/**
 * extract-anchors.ts — locate the version-fragile injection points inside the running
 * claude bundle, WITHOUT dragging the 25MB source back over the wire.
 *
 * Why this shape: `Debugger.getScriptSource` / `Debugger.searchInContent` both HANG on
 * the 62951-line main bundle (measured). But the compiled binary mounts its own source
 * at `Bun.main` (NOT a fixed path — moved from `/$bunfs/root/src/entrypoints/cli.js` on
 * ≤2.1.228 to the flattened `/$bunfs/root/cli` on ≥2.1.229; read it at runtime, never
 * hardcode it), and the target process can read it via `Bun.file(...).text()`. So we ship
 * a probe into the target that reads the source, locates each anchor string, and returns
 * only small {line, col, count, ctx} records. We poll a global for the result (JSC won't
 * unwrap the promise for us).
 *
 * Run:  node src/injector/extract-anchors.ts
 * Out:  prints a report + writes artifacts/anchors-dump.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { launchAndAttach } from './attach.ts';

// Each probe: a human name + the literal to search for + which occurrence + context radius.
// occ:-1 means "return every occurrence" (line/col only, no ctx, to disambiguate dupes).
interface Probe {
  name: string;
  needle: string;
  occ?: number;
  radius?: number;
}

const PROBES: Probe[] = [
  // ── bridgeMain region: access-token guard + base-url consume `let G=P();if(...http...)`
  { name: 'bridgeMain.region', needle: 'base URL uses HTTP', radius: 3000 },
  // ── dispatch remote-control branch entry (telemetry marker) → guards follow
  { name: 'dispatch.entry', needle: 'cli_bridge_path', radius: 2600 },
  { name: 'gate.onlyApiAnthropic', needle: 'only available when using Claude via api.anthropic.com', radius: 160 },
  // ── createBridgeSession: unique tail `reuse_outcome_branches:!0` sits next to the guards
  { name: 'session.createBridge', needle: 'reuse_outcome_branches', radius: 1600 },
  // ── spawner: child argv → env object → `.spawn(…,{env:X,windowsHide:!0})`. Radius is generous
  // because this region is where the window-edge drifts keep happening (2.1.234, 2.1.239): the
  // whole point is to see how far `env:X` has slid from the `--replay-user-messages` anchor.
  { name: 'spawner.region', needle: '--replay-user-messages', radius: 3600 },
  // ── export-table name maps (reveal minified locals: NAME:()=>MINIFIED)
  { name: 'exp.bridge', needle: 'getBridgeBaseUrl:()=>', radius: 220 },
  { name: 'exp.isFirstPartyProvider', needle: 'isFirstPartyProvider:()=>', radius: 40 },
  { name: 'exp.getBridgeDisabledReason', needle: 'getBridgeDisabledReason:()=>', radius: 40 },
  { name: 'exp.getOrganizationUUID', needle: 'getOrganizationUUID:()=>', radius: 40 },
  // ── local-oauth env switch (may let us set BASE_API_URL by env, no hook)
  { name: 'oauth.localBaseEnv', needle: 'CLAUDE_LOCAL_OAUTH_API_BASE?.', radius: 520 },
  { name: 'oauth.useLocalCheck', needle: 'USE_LOCAL_OAUTH', occ: -1 },
];

// Probe body runs INSIDE the target. Reads the bundle, resolves each probe to
// {line,col,count} (+ctx unless occ:-1 for every hit). Stashes on a global we poll.
function buildProbeExpr(probes: Probe[], globalKey: string): string {
  return `
    globalThis[${JSON.stringify(globalKey)}] = "pending";
    var MAIN = Bun.main;
    Bun.file(MAIN).text().then(function(s){
      var PROBES = ${JSON.stringify(probes)};
      function lineColOf(idx){ var pre = s.slice(0, idx); var nl = pre.lastIndexOf("\\n"); return { line: pre.split("\\n").length - 1, col: idx - (nl + 1) }; }
      function countOf(needle){ var c=0,j=0; while((j=s.indexOf(needle,j))>=0){c++;j+=needle.length;} return c; }
      function nthIdx(needle,n){ var j=0,k=0; while((j=s.indexOf(needle,j))>=0){ if(k===n) return j; k++; j+=needle.length; } return -1; }
      var out = { meta: { main: MAIN, total_lines: s.split("\\n").length, bytes: s.length } };
      for (var p of PROBES) {
        var cnt = countOf(p.needle);
        if (p.occ === -1) {
          var hits = [], j = 0, guard = 0;
          while ((j = s.indexOf(p.needle, j)) >= 0 && guard < 40) { var lc = lineColOf(j); hits.push({ line: lc.line, col: lc.col }); j += p.needle.length; guard++; }
          out[p.name] = { count: cnt, hits: hits };
        } else {
          var occ = p.occ || 0; var idx = nthIdx(p.needle, occ);
          if (idx < 0) { out[p.name] = { count: cnt, found: false }; continue; }
          var lc2 = lineColOf(idx); var r = p.radius || 200;
          out[p.name] = { count: cnt, found: true, line: lc2.line, col: lc2.col, ctx: s.slice(idx - r, idx + r) };
        }
      }
      globalThis[${JSON.stringify(globalKey)}] = out;
    }).catch(function(e){ globalThis[${JSON.stringify(globalKey)}] = "ERR:" + (e && e.message || e); });
    "kicked";`;
}

const rval = (r: any) => (r && r.result ? ('value' in r.result ? r.result.value : r.result) : undefined);

async function main() {
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const GLOBAL_KEY = '__ccExtract';
  console.error(`[extract] launching ${claudeBin} (idle stream-json) ...`);
  const h = await launchAndAttach({
    claudeBin,
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'],
    debugger: false,
    timeoutMs: 20000,
    onStderr: (b) => process.env.CCC_VERBOSE && process.stderr.write(b),
  });
  try {
    const ev = (expr: string) => h.ic.send('Runtime.evaluate', { expression: expr, returnByValue: true }, { timeoutMs: 25000 }).then(rval).catch((e) => 'ERR:' + e.message);
    await ev(buildProbeExpr(PROBES, GLOBAL_KEY));
    let out: any = 'pending';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 400));
      out = await ev(`globalThis[${JSON.stringify(GLOBAL_KEY)}]`);
      if (out !== 'pending') break;
    }
    if (typeof out !== 'object' || !out) {
      console.error('[extract] FAILED:', out);
      process.exitCode = 1;
      return;
    }
    // Report
    console.error(`[extract] bundle: ${out.meta?.main} — ${out.meta?.total_lines} lines, ${out.meta?.bytes} bytes`);
    for (const p of PROBES) {
      const r = out[p.name];
      if (!r) continue;
      if (r.hits) {
        console.error(`\n### ${p.name}  (count=${r.count})`);
        r.hits.forEach((hh: any) => console.error(`    L${hh.line} C${hh.col}`));
      } else if (r.found) {
        console.error(`\n### ${p.name}  L${r.line} C${r.col}  (count=${r.count})`);
        console.error('    ctx: ...' + String(r.ctx).replace(/\n/g, '\\n') + '...');
      } else {
        console.error(`\n### ${p.name}  NOT FOUND (count=${r.count})`);
      }
    }
    const here = path.dirname(fileURLToPath(import.meta.url));
    const outDir = path.resolve(here, '../../artifacts');
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'anchors-dump.json');
    writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.error(`\n[extract] wrote ${outFile}`);
  } finally {
    h.kill();
  }
}

main().then(() => process.exit(0), (e) => { console.error('[extract] fatal:', e); process.exit(1); });
