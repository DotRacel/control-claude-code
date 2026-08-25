#!/usr/bin/env node
/**
 * test-spawn-chain.ts — the half of the injector that test-gates.ts structurally cannot reach.
 *
 * `remote-control` is MULTI-PROCESS: bridgeMain registers the environment, then spawns a worker
 * `claude --print --sdk-url <our server>` to actually run the session. That worker has its OWN gate
 * — a `--sdk-url` allowlist rejects a non-Anthropic host — so the injector has to inject
 * `BUN_INSPECT` into the child's spawn env at the `spawner.spawn` gate, attach to the child, and
 * neutralize that guard there too. Nothing joins the data-plane if any link in that chain fails.
 *
 * test-gates.ts cannot cover it: its stub answers `/work/poll` with no work, so bridgeMain never
 * has a session to run and never spawns anything. `spawner.spawn` reports `hit=false` there
 * forever, which reads like coverage but is absence of it — and `spawner.spawn` is exactly the gate
 * whose window has now drifted twice (2.1.234, 2.1.239). This test closes that hole by standing up
 * the REAL controller instead of a stub: `store.pushSessionWork` queues a session at registration,
 * so the bridge is handed work on its first poll and the spawn actually happens.
 *
 * No Docker and no DATABASE_URL — `createControllerServer()` with no pool is in-memory. No
 * credential of yours either: the account is created straight through the store.
 *
 * What it asserts, as an ORDERED chain, because which link broke is the whole diagnosis:
 *   1. the environment registered          ⇒ the headless dispatch/bridgeMain gates were crossed
 *   2. the server handed out work          ⇒ bridgeMain is polling us, not Anthropic
 *   3. spawner.spawn hit + rebound         ⇒ we reached the spawn site and wrote the child's env
 *   4. the child opened its inspector      ⇒ the injected BUN_INSPECT actually took
 *   5. the child's guard rebound           ⇒ its --sdk-url allowlist was neutralized
 *   6. the server saw ws.connect           ⇒ the child ACCEPTED our sdk-url and joined the data-plane
 *
 * Step 6 is the one that cannot be faked by a locator: a rebind that located perfectly but returned
 * the wrong shape still leaves the child refusing to connect.
 *
 * Run:  node test/test-spawn-chain.ts            # CLAUDE_BIN=claude by default
 *       CCC_VERBOSE=1 node test/test-spawn-chain.ts   # stream the injector log while it runs
 */
import { createControllerServer, type ServerEvent } from '../src/server/index.ts';
import { launchWithGatesRebound, type GateRebindHandle } from '../src/injector/gate-rebind.ts';

const TIMEOUT_MS = 60000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Link {
  n: number;
  what: string;
  done: () => boolean;
}

async function main() {
  const events: ServerEvent[] = [];
  const server = await createControllerServer({ onEvent: (e) => events.push(e) });
  // The bridge authenticates as an account token (凭证A). Made through the store so this test
  // needs neither the invite code nor /v1/auth/register's own contract.
  const user = await server.store.createUser('spawn-chain-test', 'pw-spawnchain');
  if (!user) throw new Error('could not create the test account');
  console.log(`[chain] controller at ${server.baseUrl}`);

  const log: string[] = [];
  const seen = (t: ServerEvent['type']) => events.some((e) => e.type === t);
  const said = (s: string) => log.some((l) => l.includes(s));
  const logText = () => log.join('\n');

  let h: GateRebindHandle;
  let stderrTail = '';
  try {
    h = await launchWithGatesRebound({
      bridgeBaseUrl: server.baseUrl,
      bridgeToken: user.token,
      cwd: process.cwd(),
      // The worker would otherwise stop to ask about credentials before it ever reads --sdk-url.
      // Its inference is not what is under test here; joining our data-plane is.
      extraEnv: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'sk-ant-not-a-real-key' },
      log: (m) => { log.push(m); if (process.env.CCC_VERBOSE) console.log(`  ${m}`); },
      onStderr: (s) => { stderrTail = (stderrTail + s).slice(-2000); },
    });
  } catch (e: any) {
    console.error(`\n❌ FAIL: could not launch/inject ${process.env.CLAUDE_BIN || 'claude'}: ${e?.message || e}`);
    server.close();
    process.exit(1);
  }

  const spawner = () => h.reports.find((r) => r.id === 'spawner.spawn');
  const chain: Link[] = [
    { n: 1, what: 'environment registered (headless gates crossed)', done: () => seen('env.register') },
    { n: 2, what: 'server handed out session work', done: () => events.some((e) => e.type === 'work.poll' && (e as any).delivered) },
    { n: 3, what: 'spawner.spawn hit + child env rebound', done: () => !!(spawner()?.hit && spawner()?.reboundOk) },
    { n: 4, what: 'child opened its inspector (BUN_INSPECT took)', done: () => said('[child] connected') },
    // Matched on the outcome, not the binding's name: since the 2.1.243 chunk split what gets
    // rebound is the guard's own result local (`let n=sd(url);if(n!==null)`), because the allowlist
    // function itself lives in another chunk and is not in scope at the reject site.
    { n: 5, what: "child's --sdk-url guard rebound", done: () => /\[child\] HIT rebind \S+ → ok/.test(logText()) },
    { n: 6, what: 'child joined the data-plane (ws.connect)', done: () => seen('ws.connect') },
  ];

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline && !chain.every((l) => l.done())) {
    if (h.isDead() && !chain[2].done()) break; // host gone before it could even spawn
    await sleep(300);
  }
  await sleep(500); // let a just-completed link's log line land

  console.log('\n===== GATES =====');
  for (const r of h.reports) {
    console.log(`  ${r.id.padEnd(22)} located=${r.located} hit=${!!r.hit} rebound=${!!r.reboundOk}${r.error ? ' err=' + r.error : ''}`);
  }
  const childLines = log.filter((l) => l.startsWith('[child]'));
  console.log('\n===== CHILD CHAIN =====');
  for (const l of childLines.length ? childLines : ['  (the child never attached — nothing to show)']) console.log(`  ${l}`);

  console.log('\n===== CHAIN =====');
  for (const l of chain) console.log(`  ${l.done() ? '✅' : '❌'} ${l.n}. ${l.what}`);

  const unlocated = h.reports.filter((r) => !r.located);
  const broke = chain.find((l) => !l.done());
  const ok = !broke && unlocated.length === 0;

  if (unlocated.length) {
    console.log(`\n  gates that did not LOCATE: ${unlocated.map((r) => `${r.id} (${r.error})`).join(', ')}`);
    console.log('  → that is version drift, not a chain failure. Run test/verify-injection.ts and see');
    console.log('    docs/INJECTION-DRIFT-RUNBOOK.md.');
  } else if (broke) {
    console.log(`\n  the chain stopped at step ${broke.n}: ${broke.what}`);
    // Every gate located, so the injection surface still matches this build — the break is in the
    // runtime chain, and those two need opposite fixes. Say which one this is.
    if (broke.n <= 2) console.log('  → the headless gates located and rebound but the bridge never reached us. Check the server side.');
    else if (broke.n === 3) console.log('  → the spawn site was never reached, or the env object we wrote is no longer the one it spawns with.');
    else if (broke.n === 4) console.log('  → BUN_INSPECT did not survive into the child. Check the env-stripping loop that now runs before the spawn.');
    else if (broke.n === 5) console.log("  → the child attached but its --sdk-url guard did not rebind. Check buildChildLocatorExpr's reject-site regex.");
    else console.log('  → the guard rebound but the child still would not use our --sdk-url. Check what childDhsRebind returns.');
    if (stderrTail.trim()) console.log(`\n  claude stderr (tail):\n${stderrTail.trim().split('\n').map((l) => '    ' + l).join('\n')}`);
  }

  console.log(`\n${ok ? '✅ PASS' : '❌ FAIL'}: the child-spawn injection chain ${ok ? 'is intact end to end' : 'is broken'}.`);
  h.kill();
  server.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[chain] fatal:', e);
  process.exit(1);
});
