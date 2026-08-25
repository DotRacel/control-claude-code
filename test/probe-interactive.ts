/**
 * probe-interactive.ts — verify the interactive `/rc` gates LOCATE correctly against the
 * installed claude (wait-state locate + breakpoint set). Runs in stdio:'pipe' mode, so it does
 * NOT exercise a real TUI or `/rc` — rebind-on-hit + data-plane are validated on a real phone.
 *
 * Run: node test/probe-interactive.ts
 */
import { launchInteractiveWithGatesRebound } from '../src/injector/gate-rebind.ts';

async function main() {
  const h = await launchInteractiveWithGatesRebound({
    bridgeBaseUrl: 'http://127.0.0.1:8787',
    bridgeToken: 'probe-cred',
    stdio: 'pipe',
    log: (m) => { if (/\[int\]/.test(m)) console.log(m); },
    onStdout: () => {},
    onStderr: () => {},
  });

  console.log('\n=== interactive gate reports ===');
  for (const r of h.reports) {
    console.log(`${r.located ? '✅' : '❌'} ${r.id.padEnd(12)} L${r.line}C${r.col}  ${JSON.stringify(r.aliases)}  ${r.error || ''}`);
  }
  const allLocated = h.reports.length === INTERACTIVE_EXPECTED && h.reports.every((r) => r.located);
  console.log(`\n${allLocated ? '✅ PASS — all interactive gates located + breakpoints set' : '❌ FAIL — see above'}`);
  h.kill();
  setTimeout(() => process.exit(allLocated ? 0 : 1), 200);
}
const INTERACTIVE_EXPECTED = 9;
main().catch((e) => { console.error('[probe-interactive] fatal:', e); process.exit(1); });
