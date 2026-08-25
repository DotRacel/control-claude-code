/**
 * verify-injection.ts — does the CURRENT claude bundle still match our injection surface?
 *
 * This is the CI canary for a claude update. It needs NO auth, NO API key, and talks to
 * NOTHING at Anthropic: it launches an idle `-p` stream-json host (which never runs the
 * remote-control path, so it never needs a login), attaches the Bun inspector, and runs the
 * SAME locators the injector uses against the live bundle read via `Bun.file(Bun.main)`:
 *
 *   - buildLocatorExpr(GATES)             → the headless `remote-control` gates
 *   - buildInteractiveLocatorExpr(...)    → the interactive `/rc` gates
 *   - buildChildLocatorExpr(...)          → the spawned worker's `--sdk-url` allowlist gate
 *
 * All three read the same bundle the injector patches, so a single idle host proves the whole
 * surface. Every gate must LOCATE (anchor found, aliases resolved, bp-substr present). A gate
 * that no longer matches is a version drift — the bundle reshaped a guard — and that is exactly
 * what silently breaks injection when a new `claude` ships. We surface it here, loudly, before
 * anyone upgrades.
 *
 * This checks LOCATABILITY, not runtime rebind: it does not cross the gates or hit a server
 * (that needs a credential and is what test-gates.ts does). Locatability is the version-fragile
 * half — the half that a routine `claude` release breaks — so it is what belongs in unattended CI.
 *
 * Exit 0 = every gate located. Exit 1 = at least one gate drifted (or claude failed to launch).
 *
 * Run:  node test/verify-injection.ts            # CLAUDE_BIN=claude by default
 *       CCC_VERBOSE=1 node test/verify-injection.ts   # stream claude stderr while probing
 */
import { launchAndAttach, runLocator, type AttachHandle } from '../src/injector/attach.ts';
import {
  buildLocatorExpr,
  buildInteractiveLocatorExpr,
  buildChildLocatorExpr,
} from '../src/injector/anchors.ts';
import { resolveProfile } from '../src/injector/profiles.ts';

/** Evaluate a locator expression, then poll the global it stashes its result on. */
const locate = (ic: AttachHandle['ic'], expr: string, key: string): Promise<any> =>
  runLocator(ic, expr, key, { timeoutMs: 12000, kickTimeoutMs: 25000 });

/**
 * Where a gate landed. Blank for the entry, since on a pre-split bundle that is every gate and the
 * column would be noise; a chunk basename otherwise, which is the fact worth seeing since 2.1.243.
 */
const shortFile = (file: string | undefined, main: string | undefined): string =>
  !file || file === main ? '' : (file.split('/').pop() ?? file) + ' ';

interface Row {
  id: string;
  ok: boolean;
  detail: string;
}

/** Turn a {main, gates:[…]} locator result into per-gate rows, cross-checked against the spec ids. */
function rowsFromGateResult(result: any, specIds: string[], describe: (g: any) => string): Row[] {
  if (!result || typeof result !== 'object' || !Array.isArray(result.gates)) {
    return specIds.map((id) => ({ id, ok: false, detail: `locator returned no gates (${JSON.stringify(result)?.slice(0, 120)})` }));
  }
  const byId = new Map<string, any>(result.gates.map((g: any) => [g.id, g]));
  return specIds.map((id) => {
    const g = byId.get(id);
    if (!g) return { id, ok: false, detail: 'MISSING from locator output' };
    if (g.error) return { id, ok: false, detail: `${g.error}${g.partial ? ' partial=' + JSON.stringify(g.partial) : ''}${g.sub ? ' sub=' + JSON.stringify(g.sub) : ''}` };
    return { id, ok: true, detail: describe(g) };
  });
}

function printTable(title: string, rows: Row[]): void {
  console.log(`\n── ${title} ` + '─'.repeat(Math.max(0, 40 - title.length)));
  const w = Math.max(...rows.map((r) => r.id.length), 4);
  for (const r of rows) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.id.padEnd(w)}  ${r.detail}`);
  }
}

async function main() {
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  // Detect the version and pick the profile — the SAME resolution the injector uses at launch.
  const { profile, version, note } = await resolveProfile(claudeBin);
  const versionLabel = version ?? '(undetected)';
  console.log(`[verify] claude bin: ${claudeBin}`);
  console.log(`[verify] version:    ${versionLabel}`);
  console.log(`[verify] profile:    ${profile.id} (${note})`);

  /*
   * An idle stream-json host: it opens the inspector, waits on stdin, and never enters the
   * remote-control/login path — so it needs no credential. debugger:false: we only read the
   * bundle via Runtime.evaluate, we set no breakpoints.
   *
   * `--verbose` is REQUIRED, not cosmetic: claude refuses `--print` with
   * `--output-format=stream-json` unless it is present ("requires --verbose") and exits on the
   * spot. BUN_INSPECT is honoured before that argument check, so the inspector still opens and
   * attach still succeeds — the host is a corpse we can read for a few hundred ms, which is why
   * this went unnoticed. Whether a run passed was then a race between claude's exit and our three
   * evaluate round-trips: green on a fast box, red on a loaded CI runner, and always at whichever
   * probe happened to be last. It costs nothing to keep the host alive — the flag adds no stderr
   * output at all here, because a host that never serves a request has nothing to be verbose about.
   */
  let stderrTail = '';
  let h: AttachHandle;
  try {
    h = await launchAndAttach({
      claudeBin,
      args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      debugger: false,
      timeoutMs: 30000,
      onStderr: (b) => {
        stderrTail = (stderrTail + b).slice(-2000); // kept so a dead host can quote its own reason
        if (process.env.CCC_VERBOSE) process.stderr.write(b);
      },
    });
  } catch (e: any) {
    console.error(`\n❌ FAIL: could not launch/attach ${claudeBin}: ${e?.message || e}`);
    console.error('   (a claude that will not open its inspector cannot be injected at all.)');
    process.exit(1);
  }

  const rows: Row[] = [];
  try {
    // 1) Headless remote-control gates — the profile's set for this version.
    const headless = await locate(h.ic, buildLocatorExpr('__vHeadless', profile.gates), '__vHeadless');
    const mainUrl = headless && typeof headless === 'object' ? headless.main : undefined;
    if (mainUrl) console.log(`[verify] bundle:     ${mainUrl}`);
    const headlessRows = rowsFromGateResult(
      headless,
      profile.gates.map((g) => g.id),
      (g) => `${shortFile(g.file, mainUrl)}L${g.line}C${g.col} aliases=${JSON.stringify(g.aliases)}`,
    );
    printTable('headless gates (remote-control)', headlessRows);
    rows.push(...headlessRows);

    // 2) Interactive `/rc` gates — the profile's set for this version.
    const interactive = await locate(h.ic, buildInteractiveLocatorExpr('__vInteractive', profile.interactiveGates), '__vInteractive');
    const interactiveRows = rowsFromGateResult(
      interactive,
      profile.interactiveGates.map((g) => g.id),
      (g) => `${shortFile(g.file, mainUrl)}L${g.line}C${g.col} ${g.alias}() rebind=[${(g.names || []).join(',')}]`,
    );
    printTable('interactive gates (/rc)', interactiveRows);
    rows.push(...interactiveRows);

    // 3) The spawned worker's --sdk-url allowlist gate (same bundle, so probe-able from here).
    const child = await locate(h.ic, buildChildLocatorExpr('__vChild'), '__vChild');
    const childOk = !!(child && typeof child === 'object' && child.dHs && child.bpLine != null && child.sdkUrlIdx >= 0);
    const childRow: Row = {
      id: 'child.sdkUrl',
      ok: childOk,
      detail: childOk
        ? `dHs=${child.dHs} bp@${shortFile(child.bpFile, mainUrl)}L${child.bpLine}C${child.bpCol}`
        : `could not locate (${JSON.stringify(child)?.slice(0, 160)})`,
    };
    printTable('child worker gate (--sdk-url)', [childRow]);
    rows.push(childRow);
  } catch (e: any) {
    /*
     * A dead host and a drifted gate need opposite fixes, so never let one wear the other's
     * clothes. This branch used to surface as `[verify] fatal: inspector socket closed` from
     * whichever probe ran last, which reads exactly like an injection failure even when every
     * gate located fine — the whole point of quoting claude's own stderr here is that the next
     * person does not have to reconstruct that.
     */
    if (h.isDead()) {
      console.error(`\n❌ FAIL: the host claude exited before probing finished — NOT a gate drift.`);
      console.error(`   claude said: ${stderrTail.trim().split('\n').pop() || '(nothing on stderr)'}`);
      console.error(`   ${rows.filter((r) => r.ok).length} gate(s) had already located cleanly before it died.`);
      console.error(`   Fix the host launch in this file, not the anchors.`);
      process.exit(1);
    }
    throw e;
  } finally {
    h.kill();
  }

  const failed = rows.filter((r) => !r.ok);
  const total = rows.length;
  console.log('\n' + '═'.repeat(56));
  if (failed.length === 0) {
    console.log(`✅ PASS — all ${total} injection gates located on ${versionLabel} (profile ${profile.id}).`);
    console.log('   The injection layer is compatible with this claude build.');
    process.exit(0);
  } else {
    console.log(`❌ FAIL — ${failed.length}/${total} injection gates drifted on ${versionLabel} (profile ${profile.id}):`);
    for (const r of failed) console.log(`     • ${r.id}: ${r.detail}`);
    console.log('\n   A guard changed shape in this claude build — the current profile no longer matches.');
    console.log('   Add a gate variant in src/injector/anchors.ts and a new profile in profiles.ts');
    console.log('   for this version range (update windowAnchor / aliases / bpSubstr for each gate above).');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[verify] fatal:', e);
  process.exit(1);
});
