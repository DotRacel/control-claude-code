/**
 * gate-rebind.ts — launch `claude remote-control` and neutralize the OAuth-only gates by
 * rebinding their local aliases at runtime, redirecting the bridge control-plane to our
 * server. This is the injector core.
 *
 * Flow (every step validated by probe before it was written):
 *   1. spawn `claude remote-control` with BUN_INSPECT=ws://…?wait=1  → paused before user code
 *   2. connect; Inspector.enable + Runtime.enable + Debugger.enable
 *   3. WHILE STILL PAUSED: run the locator (reads bundle via Bun.file) → gate {line,col,aliases}
 *   4. setBreakpointByUrl for each gate (pending; fires after release) + setBreakpointsActive
 *   5. register the Debugger.paused handler (dispatches rebinds per gate)
 *   6. Inspector.initialized  → release; claude runs, hits each gate, we rebind + resume
 *   7. feed "y\n" once for the first-run "Enable Remote Control?" prompt (headless)
 *
 * Result: dispatch + bridgeMain gates pass, getBridgeBaseUrl()→our URL,
 * getBridgeAccessToken()→our token. The bridge then talks to our server.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import { InspectorClient } from './ws-client.ts';
import { getFreePort, waitForPort, treeKiller, DEFAULT_CLAUDE } from './attach.ts';
import { fill, buildLocatorExpr, buildInteractiveLocatorExpr, buildChildLocatorExpr, childDhsRebind, type RebindConfig } from './anchors.ts';
import { newestProfile, resolveProfile, type ResolvedProfile } from './profiles.ts';

/**
 * Start resolving the injection profile WITHOUT blocking the launch.
 *
 * The profile is not needed until the locator expression is built — which is after spawn +
 * port-wait + attach — so awaiting it up front just added dead time before claude even started
 * (measured +178ms of a 249ms launch when it had to shell out to `claude --version`). Kick it off
 * here, await it at the point of use, and the residual cost overlaps the launch it used to precede.
 *
 * `.catch` keeps the "never block launch on version" contract total: resolveProfile is documented
 * not to throw, but an unawaited promise that rejected would surface as an unhandledRejection
 * before we reach the await.
 */
function startProfileResolution(claudeBin: string): Promise<ResolvedProfile> {
  return resolveProfile(claudeBin).catch(
    (): ResolvedProfile => ({ profile: newestProfile(), version: null, note: 'undetected' }),
  );
}

export interface GateRebindOpts extends RebindConfig {
  claudeBin?: string;
  cwd?: string;
  extraEnv?: Record<string, string | undefined>;
  extraArgs?: string[];
  timeoutMs?: number;
  log?: (msg: string) => void;
  onStdout?: (s: string) => void;
  onStderr?: (s: string) => void;
}

export interface GateReport {
  id: string;
  located: boolean;
  error?: string;
  line?: number;
  col?: number;
  aliases?: Record<string, string>;
  breakpointId?: string;
  hit?: boolean;
  reboundOk?: boolean;
}

export interface GateRebindHandle {
  child: ChildProcessWithoutNullStreams;
  ic: InspectorClient;
  port: number;
  reports: GateReport[];
  /** The injection profile chosen for this claude version. */
  profileId: string;
  /** The detected claude version string, or null if the probe failed. */
  version: string | null;
  kill: () => void;
  isDead: () => boolean;
}

const rval = (r: any) => (r && r.result ? ('value' in r.result ? r.result.value : r.result) : undefined);

/**
 * Attach the spawned child claude (opened in wait state via the injected BUN_INSPECT) and
 * rebind its dHs() so the --sdk-url allowlist check passes, letting it connect our ingress
 * WS. Runs to the side of the parent flow; releases the child via Inspector.initialized.
 */
async function attachChildAndRebind(childPort: number, childWsUrl: string, log: (m: string) => void): Promise<void> {
  await waitForPort(childPort, '127.0.0.1', 20000);
  const cic = new InspectorClient();
  await cic.connect(childWsUrl, { timeout: 8000 });
  log('[child] connected (wait state)');
  await cic.send('Inspector.enable');
  await cic.send('Runtime.enable');
  await cic.send('Debugger.enable');
  await cic.send('Debugger.setBreakpointsActive', { active: true });
  // Strip the child's own BUN_INSPECT so any grandchild wouldn't inherit a wait URL.
  await cic.send('Runtime.evaluate', { expression: 'try{delete process.env.BUN_INSPECT}catch(e){}; "ok"', returnByValue: true }).catch(() => {});

  const CKEY = '__ccChildGate';
  await cic.send('Runtime.evaluate', { expression: buildChildLocatorExpr(CKEY), returnByValue: true });
  let loc: any = 'pending';
  for (let i = 0; i < 40 && loc === 'pending'; i++) {
    await new Promise((r) => setTimeout(r, 120));
    loc = rval(await cic.send('Runtime.evaluate', { expression: `globalThis[${JSON.stringify(CKEY)}]`, returnByValue: true }));
  }
  if (!loc || typeof loc !== 'object' || !loc.main || !loc.dHs || loc.bpLine == null) {
    log('[child] gate locate failed: ' + JSON.stringify(loc) + ' — releasing anyway');
    await cic.send('Inspector.initialized').catch(() => {});
    return;
  }
  log(`[child] dHs=${loc.dHs} bp@L${loc.bpLine}C${loc.bpCol}`);
  await cic.send('Debugger.setBreakpointByUrl', { url: loc.main, lineNumber: loc.bpLine, columnNumber: loc.bpCol });

  let childHit = false;
  cic.on('Debugger.paused', async (p: any) => {
    try {
      if (!childHit) {
        childHit = true;
        const fid = p.callFrames[0].callFrameId;
        const expr = childDhsRebind(loc.dHs) + '; "ok"';
        const r = await cic.send('Debugger.evaluateOnCallFrame', { callFrameId: fid, expression: expr, returnByValue: true }).then(rval).catch((e) => 'ERR:' + e.message);
        log(`[child] HIT rebind dHs → ${r}`);
      }
    } finally {
      await cic.send('Debugger.resume', {}).catch(() => {});
    }
  });

  log('[child] releasing via Inspector.initialized');
  await cic.send('Inspector.initialized');
}

export async function launchWithGatesRebound(opts: GateRebindOpts): Promise<GateRebindHandle> {
  const {
    claudeBin = DEFAULT_CLAUDE,
    cwd = process.cwd(),
    bridgeBaseUrl,
    bridgeToken,
    extraEnv = {},
    extraArgs = [],
    timeoutMs = 20000,
    log = () => {},
    onStdout,
    onStderr,
  } = opts;

  // Pick the injection profile for this claude version — the gate set can differ between versions
  // (see profiles.ts). Resolved CONCURRENTLY with the launch and awaited at the locator below.
  const profileP = startProfileResolution(claudeBin);

  const port = await getFreePort();
  const token = '/cc-' + crypto.randomBytes(6).toString('hex');
  const wsUrl = `ws://127.0.0.1:${port}${token}`;
  const env = { ...process.env, ...extraEnv, BUN_INSPECT: wsUrl + '?wait=1' };

  // Pre-allocate an inspector port for the child claude that bridgeMain will spawn.
  // On the spawner.spawn gate we inject BUN_INSPECT=<childInspectUrl> into the child env,
  // then attach + rebind the child's own --sdk-url allowlist gate.
  const childPort = await getFreePort();
  const childToken = '/cc-child-' + crypto.randomBytes(4).toString('hex');
  const childInspectUrl = `ws://127.0.0.1:${childPort}${childToken}?wait=1`;
  const childWsUrl = `ws://127.0.0.1:${childPort}${childToken}`;

  log(`[gate] spawn ${claudeBin} remote-control (wait=1) port=${port} cwd=${cwd}`);
  const child = spawn(claudeBin, ['remote-control', ...extraArgs], { cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  let dead = false;
  let spawnErr: Error | null = null;
  // Without this listener a failed spawn (bad --claude-bin) throws an unhandled 'error' event.
  child.on('error', (e) => { dead = true; spawnErr = e; log(`[gate] spawn error: ${e.message}`); });
  child.on('exit', (c) => { dead = true; log(`[gate] child exit code=${c}`); });
  child.stdout.on('data', (b) => onStdout?.(b.toString()));
  child.stderr.on('data', (b) => onStderr?.(b.toString()));
  // bridgeMain forks a WORKER claude as a grandchild; killing only `child` orphans it (~370MB
  // each, retrying a dead --sdk-url forever). killTree is what actually reaps it.
  const kill = treeKiller(child, () => dead);

  try {
    await waitForPort(port, '127.0.0.1', timeoutMs, () => dead).catch((e) => { throw spawnErr ?? e; });
    const ic = new InspectorClient();
    await ic.connect(wsUrl, { timeout: 8000 });
    log('[gate] connected (wait state)');

    // Enable domains — but NOT Inspector.initialized yet (that releases the app).
    await ic.send('Inspector.enable');
    await ic.send('Runtime.enable');
    await ic.send('Debugger.enable');
    await ic.send('Debugger.setBreakpointsActive', { active: true });

    // Locate all gates while still paused (Bun.file read works in the wait state).
    const { profile, version, note } = await profileP;
    log(`[gate] claude version=${version ?? '(undetected)'} → profile=${profile.id} (${note})`);
    const GKEY = '__ccGates';
    await ic.send('Runtime.evaluate', { expression: buildLocatorExpr(GKEY, profile.gates), returnByValue: true });
    let located: any = 'pending';
    for (let i = 0; i < 40 && located === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 120));
      located = rval(await ic.send('Runtime.evaluate', { expression: `globalThis[${JSON.stringify(GKEY)}]`, returnByValue: true }));
    }
    if (!located || typeof located !== 'object' || !located.main || !Array.isArray(located.gates)) {
      throw new Error(`gate locator failed: ${JSON.stringify(located)}`);
    }
    const MAIN = located.main;
    log(`[gate] main script url: ${MAIN}`);

    // Critical: the child claude that bridgeMain spawns inherits the parent's env. If it
    // inherits BUN_INSPECT it will itself pause waiting for a debugger and never connect
    // the ingress WS. Strip it now (still in the wait state, before anything spawns).
    await ic.send('Runtime.evaluate', { expression: 'try{delete process.env.BUN_INSPECT;delete process.env.BUN_INSPECT_NOTIFY;delete process.env.BUN_INSPECT_CONNECT_TO}catch(e){}; "ok"', returnByValue: true }).catch(() => {});

    // Set a pending breakpoint per located gate; map breakpointId → gate for dispatch.
    const reports: GateReport[] = [];
    const byBp = new Map<string, GateReport>();
    const byLine = new Map<number, GateReport>();
    const vars = { TOKEN: JSON.stringify(bridgeToken), URL: JSON.stringify(bridgeBaseUrl) };

    for (const g of located.gates as any[]) {
      const rep: GateReport = { id: g.id, located: !g.error, error: g.error, line: g.line, col: g.col, aliases: g.aliases };
      if (!g.error) {
        const sb = await ic.send('Debugger.setBreakpointByUrl', { url: MAIN, lineNumber: g.line, columnNumber: g.col }).catch((e) => ({ __e: e.message }));
        if (sb && sb.breakpointId) {
          rep.breakpointId = sb.breakpointId;
          byBp.set(sb.breakpointId, rep);
          byLine.set(g.line, rep);
          log(`[gate:diag] ${g.id} bpId=${sb.breakpointId} locations=${JSON.stringify(sb.locations)}`);
        } else {
          rep.located = false;
          rep.error = 'setBreakpoint-failed';
        }
      }
      reports.push(rep);
      log(`[gate] ${g.id}: ${rep.located ? `bp@L${g.line}C${g.col} aliases=${JSON.stringify(g.aliases)}` : `NOT SET (${rep.error})`}`);
    }

    const specById = new Map(profile.gates.map((s) => [s.id, s]));

    // Dispatch rebinds on each pause, then resume.
    ic.on('Debugger.paused', async (p: any) => {
      try {
        const loc = p.callFrames?.[0]?.location;
        log(`[gate:diag] PAUSED loc=${JSON.stringify(loc)} fn=${p.callFrames?.[0]?.functionName}`);
        // JSC's Debugger.paused carries no hitBreakpoints — match by (line, nearest col).
        // Pending breakpoints resolve a few cols forward (e.g. 1417→1420), so pick the gate
        // whose col is the largest one still <= the paused column (+small slack).
        let rep: GateReport | undefined;
        let best = Infinity;
        if (loc) {
          for (const r of reports) {
            if (r.line === loc.lineNumber && r.aliases && r.col != null && loc.columnNumber >= r.col - 4) {
              const d = loc.columnNumber - r.col;
              if (d < best) { best = d; rep = r; }
            }
          }
        }
        if (rep && rep.aliases) {
          rep.hit = true;
          const frameId = p.callFrames[0].callFrameId;
          if (rep.id === 'spawner.spawn') {
            // Inject the child's inspector URL into the env object about to be spawned,
            // then attach + rebind the child asynchronously (don't block resume).
            const L = rep.aliases.L;
            const expr = `${L}.BUN_INSPECT=${JSON.stringify(childInspectUrl)}; try{delete ${L}.BUN_INSPECT_NOTIFY;delete ${L}.BUN_INSPECT_CONNECT_TO}catch(e){}; "ok"`;
            const r = await ic.send('Debugger.evaluateOnCallFrame', { callFrameId: frameId, expression: expr, returnByValue: true }).then(rval).catch((e) => 'ERR:' + e.message);
            rep.reboundOk = r === 'ok';
            log(`[gate] HIT spawner.spawn → child BUN_INSPECT set (${r})`);
            attachChildAndRebind(childPort, childWsUrl, log).catch((e) => log(`[child] attach error: ${e.message}`));
          } else {
            const spec = specById.get(rep.id)!;
            const fillVars = { ...rep.aliases, ...vars };
            let ok = true;
            for (const tmpl of spec.rebinds) {
              const expr = fill(tmpl, fillVars) + '; "ok"';
              const r = await ic.send('Debugger.evaluateOnCallFrame', { callFrameId: frameId, expression: expr, returnByValue: true }).then(rval).catch((e) => 'ERR:' + e.message);
              if (r !== 'ok') ok = false;
            }
            rep.reboundOk = ok;
            log(`[gate] HIT ${rep.id} rebind ${ok ? 'ok' : 'PARTIAL'}`);
          }
        }
      } catch (e: any) {
        log(`[gate] paused handler error: ${e.message}`);
      } finally {
        await ic.send('Debugger.resume', {}).catch(() => {});
      }
    });

    // Handle the first-run headless prompt ("Enable Remote Control? (y/n)") if it appears.
    let fedDialog = false;
    child.stdout.on('data', (b) => {
      if (!fedDialog && /Enable Remote Control/i.test(b.toString())) {
        fedDialog = true;
        try { child.stdin.write('y\n'); } catch {}
      }
    });

    // Release: the app runs from the top and hits our pending breakpoints.
    log('[gate] releasing via Inspector.initialized');
    await ic.send('Inspector.initialized');

    return { child, ic, port, reports, profileId: profile.id, version, kill, isDead: () => dead };
  } catch (e) {
    kill();
    throw e;
  }
}

export interface InteractiveLaunchOpts extends RebindConfig {
  claudeBin?: string;
  cwd?: string;
  extraArgs?: string[]; // e.g. [] (user runs /rc) or session-continuation flags
  extraEnv?: Record<string, string | undefined>;
  timeoutMs?: number;
  stdio?: 'inherit' | 'pipe'; // 'inherit' = a real TUI (control-cli); 'pipe' = probe / test
  log?: (msg: string) => void;
  onStdout?: (s: string) => void;
  onStderr?: (s: string) => void;
}

export interface InteractiveHandle {
  child: ChildProcess;
  ic: InspectorClient;
  port: number;
  reports: GateReport[];
  /** The injection profile chosen for this claude version. */
  profileId: string;
  /** The detected claude version string, or null if the probe failed. */
  version: string | null;
  kill: () => void;
  isDead: () => boolean;
}

/**
 * Launch an INTERACTIVE `claude` (the TUI) with the interactive `/rc` gates rebound: the
 * `/remote-control` command becomes enabled and its REPL bridge points at our server. Unlike
 * the headless path there is no child-spawn — the interactive process itself creates a
 * code-session and connects the SSE data-plane. Breakpoints sit on hot functions
 * (getBridgeBaseUrl / getBridgeAccessToken / isBridgeEnabled), so we rebind on the first hit
 * and immediately REMOVE the breakpoint to leave the TUI running unpaused.
 */
export async function launchInteractiveWithGatesRebound(opts: InteractiveLaunchOpts): Promise<InteractiveHandle> {
  const {
    claudeBin = DEFAULT_CLAUDE,
    cwd = process.cwd(),
    bridgeBaseUrl,
    bridgeToken,
    extraArgs = [],
    extraEnv = {},
    timeoutMs = 20000,
    stdio = 'inherit',
    log = () => {},
    onStdout,
    onStderr,
  } = opts;

  // Pick the injection profile for this claude version (see profiles.ts). Resolved CONCURRENTLY
  // with the launch and awaited at the locator below, so it never delays the TUI.
  const profileP = startProfileResolution(claudeBin);

  const port = await getFreePort();
  const token = '/cc-' + crypto.randomBytes(6).toString('hex');
  const wsUrl = `ws://127.0.0.1:${port}${token}`;
  const env = { ...process.env, ...extraEnv, BUN_INSPECT: wsUrl + '?wait=1' };

  log(`[int] spawn ${claudeBin} ${extraArgs.join(' ')} (wait=1) port=${port} cwd=${cwd} stdio=${stdio}`);
  // In 'inherit' mode keep the TUI on the real stdin/stdout, but PIPE stderr so we can capture
  // claude's [bridge:repl] debug output (with --debug) without disturbing the ink TUI.
  const stdioCfg: any = stdio === 'inherit' ? ['inherit', 'inherit', 'pipe'] : ['pipe', 'pipe', 'pipe'];
  const child = spawn(claudeBin, [...extraArgs], { cwd, env: env as NodeJS.ProcessEnv, stdio: stdioCfg });
  let dead = false;
  let spawnErr: Error | null = null;
  // Without this listener a failed spawn (bad --claude-bin) throws an unhandled 'error' event.
  child.on('error', (e) => { dead = true; spawnErr = e; log(`[int] spawn error: ${e.message}`); });
  child.on('exit', (c) => { dead = true; log(`[int] child exit code=${c}`); });
  child.stderr?.on('data', (b) => onStderr?.(b.toString()));
  if (stdio === 'pipe') child.stdout?.on('data', (b) => onStdout?.(b.toString()));
  const kill = () => { if (!dead) { try { child.kill('SIGKILL'); } catch {} } };

  try {
    await waitForPort(port, '127.0.0.1', timeoutMs, () => dead).catch((e) => { throw spawnErr ?? e; });
    const ic = new InspectorClient();
    await ic.connect(wsUrl, { timeout: 8000 });
    log('[int] connected (wait state)');

    await ic.send('Inspector.enable');
    await ic.send('Runtime.enable');
    await ic.send('Debugger.enable');
    await ic.send('Debugger.setBreakpointsActive', { active: true });

    // Locate the interactive gates while paused (Bun.file read works in the wait state).
    const { profile, version, note } = await profileP;
    log(`[int] claude version=${version ?? '(undetected)'} → profile=${profile.id} (${note})`);
    const GKEY = '__ccIntGates';
    await ic.send('Runtime.evaluate', { expression: buildInteractiveLocatorExpr(GKEY, profile.interactiveGates), returnByValue: true });
    let located: any = 'pending';
    for (let i = 0; i < 40 && located === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 120));
      located = rval(await ic.send('Runtime.evaluate', { expression: `globalThis[${JSON.stringify(GKEY)}]`, returnByValue: true }));
    }
    if (!located || typeof located !== 'object' || !located.main || !Array.isArray(located.gates)) {
      throw new Error(`interactive gate locator failed: ${JSON.stringify(located)}`);
    }
    const MAIN = located.main;
    log(`[int] main script url: ${MAIN}`);

    // The interactive path shouldn't spawn a remote-control child, but strip BUN_INSPECT
    // anyway so nothing it launches inherits a wait URL.
    await ic.send('Runtime.evaluate', { expression: 'try{delete process.env.BUN_INSPECT;delete process.env.BUN_INSPECT_NOTIFY;delete process.env.BUN_INSPECT_CONNECT_TO}catch(e){}; "ok"', returnByValue: true }).catch(() => {});

    const reports: GateReport[] = [];
    const namesById = new Map<string, string[]>();
    const vars = { TOKEN: JSON.stringify(bridgeToken), URL: JSON.stringify(bridgeBaseUrl) };
    const specById = new Map(profile.interactiveGates.map((s) => [s.id, s]));

    for (const g of located.gates as any[]) {
      const rep: GateReport = { id: g.id, located: !g.error, error: g.error, line: g.line, col: g.col, aliases: g.names ? { fn: g.alias, rebind: g.names.join(',') } : undefined };
      if (!g.error) {
        namesById.set(g.id, g.names);
        const sb = await ic.send('Debugger.setBreakpointByUrl', { url: MAIN, lineNumber: g.line, columnNumber: g.col }).catch((e) => ({ __e: e.message }));
        if (sb && sb.breakpointId) rep.breakpointId = sb.breakpointId;
        else { rep.located = false; rep.error = 'setBreakpoint-failed'; }
      }
      reports.push(rep);
      log(`[int] ${g.id}: ${rep.located ? `bp@L${g.line}C${g.col} ${g.alias}() rebind [${g.names.join(',')}]` : `NOT SET (${rep.error})`}`);
    }

    // On each hit: rebind the gate's target(s), REMOVE the breakpoint (hot path), resume.
    ic.on('Debugger.paused', async (p: any) => {
      try {
        const loc = p.callFrames?.[0]?.location;
        let rep: GateReport | undefined;
        let best = Infinity;
        if (loc) {
          for (const r of reports) {
            const sticky = specById.get(r.id)?.sticky;
            if (r.line === loc.lineNumber && r.breakpointId && (sticky || !r.hit) && r.col != null && loc.columnNumber >= r.col - 4) {
              const d = Math.abs(loc.columnNumber - r.col);
              if (d < best) { best = d; rep = r; }
            }
          }
        }
        if (rep) {
          rep.hit = true;
          const frameId = p.callFrames[0].callFrameId;
          const spec = specById.get(rep.id)!;
          const names = namesById.get(rep.id)!;
          const fillVars = { ...vars };
          for (let i = 0; i < names.length; i++) fillVars[String(i)] = names[i];
          let ok = true;
          for (let i = 0; i < names.length; i++) {
            const expr = `${names[i]}=${fill(spec.rebindValues[i], fillVars)}; "ok"`;
            const r = await ic.send('Debugger.evaluateOnCallFrame', { callFrameId: frameId, expression: expr, returnByValue: true }).then(rval).catch((e) => 'ERR:' + e.message);
            if (r !== 'ok') ok = false;
          }
          rep.reboundOk = ok;
          log(`[int] HIT ${rep.id} rebind [${names.join(',')}] ${ok ? 'ok' : 'PARTIAL/FAIL'}${spec.sticky ? ' (sticky)' : ''}`);
          // Hot-path gates (baseurl/token/enabled) are rebound once. Connect-time
          // gates patch per-invocation locals and must fire on every `/rc`.
          if (!spec.sticky && rep.breakpointId) await ic.send('Debugger.removeBreakpoint', { breakpointId: rep.breakpointId }).catch(() => {});
        }
      } catch (e: any) {
        log(`[int] paused handler error: ${e.message}`);
      } finally {
        await ic.send('Debugger.resume', {}).catch(() => {});
      }
    });

    log('[int] releasing via Inspector.initialized');
    await ic.send('Inspector.initialized');

    return { child, ic, port, reports, profileId: profile.id, version, kill, isDead: () => dead };
  } catch (e) {
    kill();
    throw e;
  }
}
