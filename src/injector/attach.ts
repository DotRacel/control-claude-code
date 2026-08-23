/**
 * attach.ts — spawn `claude` with the Bun inspector open and attach an InspectorClient.
 *
 * Ported/adapted from cc-injector (src/inspector/attach.js), minus the PTY/TUI path.
 * Stable orchestration: pick a free port, spawn with BUN_INSPECT set, wait for the
 * debugger port, connect, and enable Runtime/Debugger with breakpoints armed (JSC leaves
 * breakpoints inert until `setBreakpointsActive`).
 *
 * Empirically (cc-injector + our own probes): the `--inspect` FLAG is rejected by the
 * compiled binary; the BUN_INSPECT env var opens the channel; SIGUSR1 kills the process
 * (so there is no attach-to-running); `?wait=1` blocks the whole app with no JSC release
 * — so we never use it and rely on breakpoint-pause for timing instead.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { InspectorClient } from './ws-client.ts';

export const DEFAULT_CLAUDE = process.env.CLAUDE_BIN || 'claude';
const BUN_INSPECT_ENV = 'BUN_INSPECT';

/** pid → its direct children, from a single /proc scan (Linux). */
function childMap(): Map<number, number[]> {
  const byParent = new Map<number, number[]>();
  let names: string[];
  try { names = fs.readdirSync('/proc'); } catch { return byParent; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      // `comm` can contain spaces and parens, so parse after the LAST ')': state ppid …
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(fields[1]);
      if (!Number.isFinite(ppid)) continue;
      const arr = byParent.get(ppid) ?? [];
      arr.push(Number(name));
      byParent.set(ppid, arr);
    } catch { /* process vanished mid-scan */ }
  }
  return byParent;
}

/**
 * Kill the child AND every process it spawned.
 *
 * `claude remote-control` forks a worker claude (`--print --sdk-url …`) as a GRANDCHILD. Killing
 * only the direct child orphans that worker (PPID→1, verified), and it then retries a dead
 * --sdk-url forever holding ~370MB — ten of them piled up in one day of testing.
 *
 * Why walk /proc instead of using a process group: the worker inherits whatever group it was
 * spawned in, which is the CALLER's — so `kill(-pid)` would take out the user's own shell/tmux
 * window. `detached: true` would fix that but moves the child out of the caller's group entirely,
 * which makes the SIGKILL-the-host case (where no cleanup code can run at all) leak more reliably
 * than before. Snapshotting the tree costs one /proc scan and has neither problem.
 *
 * The snapshot must be taken BEFORE anything dies: once an intermediate process exits, its
 * children are re-parented to init and unreachable from `root`. Deepest-first for the same reason.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const root = child.pid;
  if (!root) { try { child.kill(signal); } catch {} return; }
  const tree = childMap();
  const descendants: number[] = [];
  const walk = (p: number) => { for (const c of tree.get(p) ?? []) { descendants.push(c); walk(c); } };
  walk(root);
  for (const p of descendants.reverse()) { try { process.kill(p, signal); } catch {} }
  try { child.kill(signal); } catch {}
}

/**
 * killTree + a net for hosts that exit without calling it (a test script that just returns).
 * Cannot help when the host itself is SIGKILLed — nothing can.
 */
export function treeKiller(child: ChildProcess, isDead: () => boolean): () => void {
  const onHostExit = () => { if (!isDead()) killTree(child); };
  process.once('exit', onHostExit);
  return () => {
    process.removeListener('exit', onHostExit);
    if (!isDead()) killTree(child);
  };
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/**
 * Wait for claude's inspector port to accept a connection.
 *
 * The retry interval RAMPS (2ms doubling to 50ms) rather than sitting at a flat 80ms. Measured on
 * 2.1.241, `BUN_INSPECT` has the port listening ~15ms after spawn — so a flat 80ms poll turned a
 * 15ms wait into an 80ms one and spent ~65ms of every launch on nothing. A failed connect to a
 * local closed port is two syscalls, so the handful of extra early attempts costs nothing worth
 * measuring, and the ramp keeps the tail cheap when a slow machine really does take seconds.
 */
export function waitForPort(port: number, host: string, timeoutMs: number, isDead: () => boolean = () => false): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let wait = 2;
    const tryOnce = () => {
      if (isDead()) return reject(new Error('claude exited before the inspector port opened'));
      const s = net.connect({ port, host }, () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() > deadline) return reject(new Error(`inspector port ${port} never opened`));
        setTimeout(tryOnce, wait);
        wait = Math.min(wait * 2, 50);
      });
    };
    tryOnce();
  });
}

const rvalOf = (r: any) => (r && r.result ? ('value' in r.result ? r.result.value : r.result) : undefined);

/**
 * Evaluate a locator expression in the target and return the result it stashes on a global.
 *
 * Why a global and not a return value: every locator has to read the bundle through
 * `Bun.file(Bun.main).text()`, which is a promise, and JSC's `Runtime.evaluate` will not unwrap one
 * (`awaitPromise` is a V8 affordance JSC lacks). Reading the file synchronously isn't available
 * either — there is no `require` in the evaluate context. So the expression parks its result on
 * `globalThis[globalKey]` and we read it back.
 *
 * The poll interval RAMPS from 2ms. The read-and-match takes ~40ms on a 2.1.241 bundle, so the flat
 * 120ms first sleep this replaces spent ~70ms of every launch waiting on work that had already
 * finished. Polling this fast is self-throttling rather than wasteful: the target runs our read-back
 * evaluate on the same thread as the locator, so a poll issued mid-work simply doesn't answer until
 * the work is done.
 *
 * Returns whatever the global holds — including the locator's own `"ERR:…"` string, or the literal
 * `"pending"` if the budget ran out. Callers validate the shape and report their own failure.
 *
 * RPC errors are deliberately NOT caught here. A locator that cannot be evaluated and a locator
 * that evaluated to a miss are different failures with opposite fixes — a dead inspector socket vs
 * a drifted gate — and verify-injection has a catch that exists precisely to tell those apart.
 * Swallowing the throw would hand it `undefined` and make a dead host read like version drift.
 */
export async function runLocator(
  ic: InspectorClient,
  expression: string,
  globalKey: string,
  { timeoutMs = 4800, kickTimeoutMs }: { timeoutMs?: number; kickTimeoutMs?: number } = {},
): Promise<any> {
  const kickOpts = kickTimeoutMs === undefined ? undefined : { timeoutMs: kickTimeoutMs };
  await ic.send('Runtime.evaluate', { expression, returnByValue: true }, kickOpts);
  const readBack = `globalThis[${JSON.stringify(globalKey)}]`;
  const deadline = Date.now() + timeoutMs;
  let out: any = 'pending';
  let wait = 2;
  while (out === 'pending' && Date.now() < deadline) {
    await sleep(wait);
    wait = Math.min(wait * 2, 100);
    out = rvalOf(await ic.send('Runtime.evaluate', { expression: readBack, returnByValue: true }));
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AttachHandle {
  ic: InspectorClient;
  child: ChildProcessWithoutNullStreams;
  ws: string;
  port: number;
  kill: () => void;
  isDead: () => boolean;
}

export interface LaunchOpts {
  claudeBin?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  attempts?: number;
  onStdout?: (b: Buffer) => void;
  onStderr?: (b: Buffer) => void;
  /** enable Debugger domain + arm breakpoints (default true). */
  debugger?: boolean;
}

/**
 * Launch claude + attach an InspectorClient with Runtime (and optionally Debugger)
 * enabled. `args` is the full claude argv (e.g. ['-p','--input-format','stream-json']
 * for an idle host, or ['remote-control'] for the bridge).
 */
export async function launchAndAttach(opts: LaunchOpts = {}): Promise<AttachHandle> {
  const {
    claudeBin = DEFAULT_CLAUDE,
    args = [],
    env = {},
    cwd,
    timeoutMs = 20000,
    attempts = 3,
    onStdout,
    onStderr,
    debugger: enableDebugger = true,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await getFreePort();
    const token = '/cc-' + crypto.randomBytes(6).toString('hex');
    const wsUrl = `ws://127.0.0.1:${port}${token}`;
    const launchEnv = { ...process.env, ...env, [BUN_INSPECT_ENV]: wsUrl };

    const child = spawn(claudeBin, args, { env: launchEnv as NodeJS.ProcessEnv, cwd, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    let dead = false;
    child.on('exit', () => { dead = true; });
    if (onStdout) child.stdout.on('data', onStdout);
    if (onStderr) child.stderr.on('data', onStderr);
    const kill = treeKiller(child, () => dead); // takes any worker grandchild with it

    try {
      await waitForPort(port, '127.0.0.1', timeoutMs, () => dead);
      const ic = new InspectorClient();
      await ic.connect(wsUrl, { timeout: 8000 });
      await ic.send('Runtime.enable', {});
      if (enableDebugger) {
        await ic.send('Debugger.enable', {});
        await ic.send('Debugger.setBreakpointsActive', { active: true }); // JSC: inert until armed
      }
      return { ic, child, ws: wsUrl, port, kill, isDead: () => dead };
    } catch (e) {
      lastErr = e;
      kill();
      if (attempt < attempts) await sleep(150);
    }
  }
  throw lastErr;
}
