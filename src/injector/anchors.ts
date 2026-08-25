/**
 * anchors.ts — THE INJECTION SURFACE, centralized (version-fragile facts).
 *
 * When a Claude Code update lands, THIS is the first (usually only) file to review.
 * Nothing here depends on stable minified symbol names: every gate is located at RUNTIME
 * by reading the bundle source (via `Bun.file(Bun.main).text()` inside the target) and
 * matching STRING / STRUCTURAL anchors, then extracting the current minified local aliases
 * with a regex. So an update that only reshuffles names keeps working; only a change to the
 * surrounding *code shape* (the guard expressions themselves) needs edits.
 *
 * Empirically established (see the probes under our own history + cc-injector):
 *  - `--inspect` flag is rejected; `BUN_INSPECT=ws://…?wait=1` opens the channel AND pauses
 *    the whole app before user code runs.
 *  - `?wait=1` is released by the WebKit `Inspector.initialized` message (NOT
 *    `Runtime.runIfWaitingForDebugger`, which JSC lacks). Sequence:
 *    Inspector.enable → Runtime.enable → Debugger.enable → (set breakpoints) →
 *    Inspector.initialized  ⇒ execution resumes and hits our pending breakpoints.
 *  - In the wait state we CAN `Runtime.evaluate` + `Bun.file().text()` (promise resolves),
 *    so we locate every gate before releasing — zero startup race.
 *  - The embedded bundle's virtual-fs path is NOT stable across versions — ≤2.1.228 it's
 *    `/$bunfs/root/src/entrypoints/cli.js`, ≥2.1.229 it's the flattened `/$bunfs/root/cli`
 *    (confirmed by probe). A hardcoded guess made every gate lookup ENOENT below 2.1.229, so
 *    every locator here reads `Bun.main` at runtime instead and reports it back so the Node
 *    side can point `Debugger.setBreakpointByUrl` at the same URL.
 *  - `Debugger.setBreakpointByUrl` accepts a breakpoint on a not-yet-parsed script
 *    (pending, locations:[]) and it fires once the bundle parses after release.
 *  - On pause, `Debugger.evaluateOnCallFrame` can REBIND a local alias in that frame
 *    (`alias = function(){…}`); the guard that reads it right after sees the new value.
 */

/** Config the rebinds need at runtime (filled in by gate-rebind, not fragile). */
export interface RebindConfig {
  bridgeBaseUrl: string; // e.g. http://127.0.0.1:PORT — becomes getBridgeBaseUrl()
  bridgeToken: string; // becomes getBridgeAccessToken()
}

/**
 * A gate = one breakpoint site inside a consumer function.
 *  - windowAnchor/back/fwd: slice of source to search in (keeps regexes unambiguous).
 *  - aliases: name → regex whose capture group 1 is the CURRENT minified local alias.
 *  - bpSubstr: substring (after ${alias} substitution) whose index is the breakpoint col.
 *  - rebinds: statements (after ${alias}/${TOKEN}/${URL} substitution) run in the paused
 *    frame to neutralize the guard.
 */
export interface GateSpec {
  id: string;
  windowAnchor: string;
  windowBack: number;
  windowFwd: number;
  aliases: Record<string, string>;
  bpSubstr: string;
  rebinds: string[];
}

// dispatch() remote-control branch (anchor: telemetry marker "cli_bridge_path"), and
// bridgeMain() (anchor: the http-scheme check string). Guard shapes originally captured from
// 2.1.231.
//
// ── Version-profiled surface ──────────────────────────────────────────────────────────────
// Each gate below is a NAMED constant so a version PROFILE (see profiles.ts) can pick the right
// variant when a claude release reshapes one guard's *code shape* (the runtime string/structural
// anchors already absorb pure name churn). Most gates are shared across every version; only the
// ones that actually drifted carry variants. `headlessGates(trustVariant)` assembles the 7-gate
// headless array in its original order — order does not affect correctness (each gate locates
// independently) but keeps logs and reports stable.
//
// Known drift so far (measured):
//   - `dispatch.trust`: ≤2.1.237 used two functions (enrollTrustedDeviceIfNeeded +
//     getTrustedDeviceUnenrolledReason); 2.1.238 merged them into a single
//     preflightTrustedDeviceBlocking(). Hence LEGACY vs PREFLIGHT below.

// ── dispatch: hasStoredOAuthToken + getBridgeDisabledReason + checkBridgeMinVersion.
// h/g are destructured BEFORE H, so at the `if(!H())` pause they're already visible.
export const GATE_DISPATCH_OAUTH: GateSpec = {
  id: 'dispatch.oauth',
  windowAnchor: 'cli_bridge_path',
  windowBack: 0,
  windowFwd: 3200,
  aliases: {
    H: 'hasStoredOAuthToken:([\\w$]+)\\}',
    h: 'getBridgeDisabledReason:([\\w$]+)[,}]',
    g: 'checkBridgeMinVersion:([\\w$]+)[,}]',
  },
  bpSubstr: 'if(!${H}())',
  rebinds: ['${H}=function(){return !0}', '${h}=async function(){return null}', '${g}=function(){return null}'],
};

// ── dispatch: isPolicyAllowed("allow_remote_control")
export const GATE_DISPATCH_POLICY: GateSpec = {
  id: 'dispatch.policy',
  windowAnchor: 'cli_bridge_path',
  windowBack: 0,
  windowFwd: 3600,
  aliases: { R: 'isPolicyAllowed:([\\w$]+)\\}' },
  bpSubstr: '!${R}("allow_remote_control")',
  rebinds: ['${R}=function(){return !0}'],
};

// ── dispatch: trusted-device gate — LEGACY variant (≤2.1.237).
// Two functions: `await W(); F=await G(); if(F)`. Break at `await W()` (W/G both bound by then),
// neutralize both: enrollment → no-op, unenrolled-reason → null.
export const GATE_DISPATCH_TRUST_LEGACY: GateSpec = {
  id: 'dispatch.trust',
  windowAnchor: 'cli_bridge_path',
  windowBack: 0,
  windowFwd: 3600,
  aliases: {
    W: 'enrollTrustedDeviceIfNeeded:([\\w$]+)\\}',
    G: 'getTrustedDeviceUnenrolledReason:([\\w$]+)[,}]',
  },
  bpSubstr: 'await ${W}()',
  rebinds: ['${W}=async function(){}', '${G}=async function(){return null}'],
};

// ── dispatch: trusted-device gate — PREFLIGHT variant (≥2.1.238).
// Merged into one function: `let{preflightTrustedDeviceBlocking:Z}=…,W=await Z();if(W)…H(Error)`.
// Break at `=await Z(` (Z already destructured), rebind Z → returns null so `if(W)` never fires.
//
// bpSubstr stops at the OPEN PAREN on purpose: 2.1.239 started passing the credentials store in
// (`ne=await K(Z)` where 2.1.238 had `W=await Z()`). Same guard, same rebind — a parameter is
// cosmetic, so this widens rather than branching. Our replacement ignores whatever it's handed.
export const GATE_DISPATCH_TRUST_PREFLIGHT: GateSpec = {
  id: 'dispatch.trust',
  windowAnchor: 'cli_bridge_path',
  windowBack: 0,
  windowFwd: 3600,
  aliases: { Z: 'preflightTrustedDeviceBlocking:([\\w$]+)\\}' },
  bpSubstr: '=await ${Z}(',
  rebinds: ['${Z}=async function(){return null}'],
};

// ── bridgeMain: workspace-trust gate `if(…,!<trust>())` before token/baseurl.
export const GATE_BRIDGEMAIN_TRUST: GateSpec = {
  id: 'bridgeMain.trust',
  windowAnchor: 'base URL uses HTTP',
  windowBack: 4000,
  windowFwd: 200,
  aliases: { t: 'checkHasTrustDialogAccepted:([\\w$]+)\\}' },
  bpSubstr: ',!${t}())',
  rebinds: ['${t}=function(){return !0}'],
};

// ── bridgeMain: getBridgeAccessToken guard + getBridgeBaseUrl consume.
// M,P destructured together → rebind both at the `if(!M())` pause: M→token, P→our URL.
// SYNC variant (≤2.1.238): one token getter, read straight into the guard.
export const GATE_BRIDGEMAIN_TOKENURL_SYNC: GateSpec = {
  id: 'bridgeMain.tokenurl',
  windowAnchor: 'base URL uses HTTP',
  windowBack: 4000,
  windowFwd: 200,
  aliases: { M: 'getBridgeAccessToken:([\\w$]+),', P: 'getBridgeBaseUrl:([\\w$]+)\\}' },
  bpSubstr: 'if(!${M}())',
  rebinds: ['${M}=function(){return ${TOKEN}}', '${P}=function(){return ${URL}}'],
};

// ── bridgeMain: same gate — ASYNC variant (≥2.1.239).
// 2.1.239 added a SECOND token getter and picks between them at runtime:
//   {getBridgeAccessToken:M,getBridgeAccessTokenAsync:A,getBridgeBaseUrl:P}=await …,
//   U=Nt()&&r!==void 0; if(!(U?await A(r):M())) process.exit(1)
// Rebinding M alone is no longer enough — when U holds, the guard never calls it — so this is a
// BRANCH, not a widen: a different alias set with a different rebind list. A is rebound async
// because the call site awaits it.
//
// The breakpoint must sit on the `if` STATEMENT, not inside its condition: a column that lands on
// `await A(r)` would only be reached when U is true, and then M/P would go un-rebound on the other
// path. `U` is captured out of the condition itself purely to anchor bpSubstr to that statement —
// if this shape ever changes, U stops resolving and the gate reports a loud alias-not-found rather
// than silently parking the breakpoint on some other `if(!(` in the window.
export const GATE_BRIDGEMAIN_TOKENURL_ASYNC: GateSpec = {
  id: 'bridgeMain.tokenurl',
  windowAnchor: 'base URL uses HTTP',
  windowBack: 4000,
  windowFwd: 200,
  aliases: {
    M: 'getBridgeAccessToken:([\\w$]+),',
    A: 'getBridgeAccessTokenAsync:([\\w$]+),',
    P: 'getBridgeBaseUrl:([\\w$]+)\\}',
    U: ';if\\(!\\(([\\w$]+)\\?await ',
  },
  bpSubstr: 'if(!(${U}?await ${A}(',
  rebinds: [
    '${M}=function(){return ${TOKEN}}',
    '${A}=async function(){return ${TOKEN}}',
    '${P}=function(){return ${URL}}',
  ],
};

// ── bridgeMain: inline scheme check after `let U=P()`.
// `if(U.startsWith("http://")&&!U.includes("localhost")&&!U.includes("127.0.0.1")) process.exit(1)`.
// U is a primitive string, so `U.startsWith=fn` is discarded. One-shot-patch
// String.prototype.startsWith: this check returns false, then the original is restored.
export const GATE_BRIDGEMAIN_HTTPSCHEME: GateSpec = {
  id: 'bridgeMain.httpscheme',
  windowAnchor: 'Error: Remote Control base URL uses HTTP',
  windowBack: 200,
  windowFwd: 40,
  aliases: { U: 'let ([\\w$]+)=[\\w$]+\\(\\);if\\(\\1\\.startsWith\\("http://"\\)' },
  bpSubstr: 'if(${U}.startsWith("http://")',
  rebinds: ['var _s=String.prototype.startsWith;String.prototype.startsWith=function(){String.prototype.startsWith=_s;return!1}'],
};

// ── spawner: the point where bridgeMain spawns the child claude. Special-cased in
// gate-rebind: on hit we set <env>.BUN_INSPECT so the child opens its own inspector,
// then attach + rebind the child too (it has its own --sdk-url allowlist gate).
export const GATE_SPAWNER_SPAWN: GateSpec = {
  id: 'spawner.spawn',
  windowAnchor: '--replay-user-messages',
  windowBack: 0,
  windowFwd: 3600,
  // `{...,env:l,windowsHide:!0}` is the spawn options object. Match only up to the env
  // alias (`env:l,`) — as of 2.1.234 `windowsHide` sits at ~1204 bytes past the anchor,
  // so anchoring on it was fragile at the window edge (windowFwd used to be 1200 and cut
  // it off, breaking the whole headless child-rebind chain). `[,}]` after the alias is
  // enough to disambiguate the spawn env from `e.env` (which has no colon) and from the
  // long env-object literal above (whose keys are CLAUDE_CODE_*, never `env`).
  //
  // The SAME window-edge failure recurred on 2.1.239: the arg/env construction above grew and
  // pushed `env:m` out to ~2007 bytes past the anchor, past the 1600 this had been widened to,
  // and the gate went back to alias-not-found (empty partial — nothing matched at all).
  // windowFwd is now 3600, which keeps the match at ~56% of the window. Measured on 2.1.241:
  // `env:X[,}]` has exactly ONE hit anywhere in the first 5000 bytes after the anchor, so the
  // extra room buys headroom without buying ambiguity.
  aliases: { L: 'env:([\\w$]+)[,}]' },
  // Break BEFORE the spawn call (the `.spawn(` site fires AFTER the child is already
  // spawned). The env object `l` is defined just before this debug log, so pausing here
  // lets us mutate l.BUN_INSPECT before the spawn reads it.
  bpSubstr: 'Spawning sessionId',
  rebinds: [], // handled specially (needs the child inspector port at runtime)
};

/** Which variant a profile uses for each gate that has drifted structurally. */
export interface GateVariants {
  /** dispatch.trust: LEGACY (two functions, ≤2.1.237) or PREFLIGHT (merged, ≥2.1.238). */
  trust: GateSpec;
  /** bridgeMain.tokenurl: SYNC (≤2.1.238) or ASYNC (second getter added, ≥2.1.239). */
  tokenUrl: GateSpec;
}

/**
 * Assemble the 7 headless gates in canonical order from a profile's variant choices. Profiles
 * (profiles.ts) call this; the exported GATES below is the legacy set.
 *
 * Takes a named SET rather than positional GateSpecs on purpose: every variant has the same type,
 * so two positional parameters would let a swapped call compile clean and fail only at runtime.
 */
export function headlessGates(variants: GateVariants): GateSpec[] {
  return [
    GATE_DISPATCH_OAUTH,
    GATE_DISPATCH_POLICY,
    variants.trust,
    GATE_BRIDGEMAIN_TRUST,
    variants.tokenUrl,
    GATE_BRIDGEMAIN_HTTPSCHEME,
    GATE_SPAWNER_SPAWN,
  ];
}

/**
 * Shared preamble for every locator expression, injected into the target.
 *
 * Assumes the enclosing scope has already bound `s` to the bundle text. Both helpers exist because
 * the naive forms are O(bundle) EACH TIME and the bundle is ~28MB / 60k lines (2.1.241):
 *
 *  - findAnchor memoises `s.indexOf(needle)`. The 7 headless gates share only 4 distinct window
 *    anchors — `cli_bridge_path` alone is the anchor for 3 of them, and it sits near the END of the
 *    bundle, so each repeat was a full ~9ms scan for a result we already had.
 *  - absLineCol builds ONE newline-offset table (~5ms) and binary-searches it, replacing a
 *    `s.slice(0, idx).split("\n")` per gate — that slice copies up to 28MB and the split allocates
 *    a 60k-element array, ~30ms across 7 gates, to count newlines we can count once.
 *
 * The table is built lazily so a locator that never asks for a line/col never pays for it.
 * Semantics are unchanged: `line` is the 0-based count of newlines before idx, and `col` is the
 * offset from the last newline (or from 0 on the first line).
 */
const LOCATOR_PRELUDE = `
        var __nl = null;
        function lineTable(){ if (__nl) return __nl; __nl = []; for (var j = s.indexOf("\\n"); j >= 0; j = s.indexOf("\\n", j + 1)) __nl.push(j); return __nl; }
        function absLineCol(idx){
          var t = lineTable(), lo = 0, hi = t.length;
          while (lo < hi) { var mid = (lo + hi) >> 1; if (t[mid] < idx) lo = mid + 1; else hi = mid; }
          return { line: lo, col: lo === 0 ? idx : idx - (t[lo - 1] + 1) };
        }
        var __find = new Map();
        function findAnchor(needle){ if (!__find.has(needle)) __find.set(needle, s.indexOf(needle)); return __find.get(needle); }
        function totalLines(){ return lineTable().length + 1; }
`;

/**
 * Backwards-compatible default gate set (legacy `dispatch.trust`). Kept so older callers and
 * `extract-anchors.ts` keep working; the version-aware paths take `profile.gates` instead.
 */
export const GATES: GateSpec[] = headlessGates({ trust: GATE_DISPATCH_TRUST_LEGACY, tokenUrl: GATE_BRIDGEMAIN_TOKENURL_SYNC });

/**
 * Child-process locator: the spawned `claude --print --sdk-url …` has its OWN gate —
 * `dHs()` (getSdkUrl allowlist check) rejects a non-Anthropic host / non-wss scheme,
 * failing both the startup arg check (via `cku`) and the runtime getSdkUrl. Rebinding
 * `dHs` to return {status:'ok', url:<the --sdk-url value>} passes both. This locator
 * finds dHs's minified name and the breakpoint line/col right before the startup check.
 */
export function buildChildLocatorExpr(globalKey: string): string {
  const K = JSON.stringify(globalKey);
  return `
    globalThis[${K}] = "pending";
    (async () => {
      try {
        var MAIN = Bun.main;
        var s = await Bun.file(MAIN).text();
        ${LOCATOR_PRELUDE}
        var out = { main: MAIN, total_lines: totalLines() };
        // dHs name: locate uHs("--sdk-url"), walk back to the enclosing function name.
        var si = findAnchor('("--sdk-url")');
        out.sdkUrlIdx = si;
        // NB: minified names can contain '$' (e.g. dHs = "l$s"), so match [\\w$]+ not \\w+.
        if (si >= 0) {
          var b1 = s.slice(si - 200, si);
          var mm = /function ([\\w$]+)\\(\\)\\{[^{}]*$/.exec(b1);
          out.dHs = mm ? mm[1] : null;
        } else out.dHs = null;
        // breakpoint: the \`let nn=cku(J);if(nn!==null)\` right before the reject telemetry.
        var ci = findAnchor("tengu_sdk_url_host_rejected");
        if (ci >= 0) {
          var back = s.slice(ci - 240, ci);
          var m2 = /let [\\w$]+=[\\w$]+\\([^)]*\\);if\\([\\w$]+!==null\\)/.exec(back);
          if (m2) { var abs = ci - 240 + back.indexOf(m2[0]); var p = absLineCol(abs); out.bpLine = p.line; out.bpCol = p.col; }
        }
        globalThis[${K}] = out;
      } catch (e) { globalThis[${K}] = "ERR:" + (e && e.message || e); }
    })();
    "kicked";`;
}

/** Rebind expression for the child's dHs (getSdkUrl allowlist check). */
export function childDhsRebind(dHsName: string): string {
  return `${dHsName}=function(){var a=(typeof process!=="undefined"&&process.argv)||[];var u;for(var i=0;i<a.length;i++){if(a[i]==="--sdk-url"){u=a[i+1];break;}}return{status:"ok",url:u}}`;
}

/** Substitute ${name} placeholders from a map (aliases + TOKEN/URL). */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `\${${k}}`));
}

/**
 * Build the target-side locator expression. Runs inside claude (wait state), reads the
 * bundle, resolves each gate to {id, line, col, aliases}, and stashes {main, gates} on
 * globalThis[globalKey]. The Node side polls that global, then sets breakpoints against
 * `main` (the resolved Bun.main URL — NOT assumed, since it moved across versions).
 *
 * `gates` is the profile's headless gate set (defaults to the legacy GATES for old callers).
 */
export function buildLocatorExpr(globalKey: string, gates: GateSpec[] = GATES): string {
  const K = JSON.stringify(globalKey);
  const GATES_JSON = JSON.stringify(gates);
  return `
    globalThis[${K}] = "pending";
    (async () => {
      try {
        var MAIN = Bun.main;
        var s = await Bun.file(MAIN).text();
        var GATES = ${GATES_JSON};
        ${LOCATOR_PRELUDE}
        function fillLocal(t, vars){ return t.replace(/\\$\\{(\\w+)\\}/g, function(_, k){ return (k in vars) ? vars[k] : ("\\${"+k+"}"); }); }
        var out = [];
        for (var gi = 0; gi < GATES.length; gi++) {
          var G = GATES[gi];
          var anchorIdx = findAnchor(G.windowAnchor);
          if (anchorIdx < 0) { out.push({ id: G.id, error: "anchor-not-found" }); continue; }
          var start = Math.max(0, anchorIdx - G.windowBack);
          var win = s.slice(start, anchorIdx + G.windowFwd);
          var aliases = {}, ok = true;
          for (var name in G.aliases) {
            var m = new RegExp(G.aliases[name]).exec(win);
            if (!m) { ok = false; break; }
            aliases[name] = m[1];
          }
          if (!ok) { out.push({ id: G.id, error: "alias-not-found", partial: aliases }); continue; }
          var sub = fillLocal(G.bpSubstr, aliases);
          var rel = win.indexOf(sub);
          if (rel < 0) { out.push({ id: G.id, error: "bp-substr-not-found", aliases: aliases, sub: sub }); continue; }
          var absIdx = start + rel;
          var lc = absLineCol(absIdx);
          out.push({ id: G.id, line: lc.line, col: lc.col, aliases: aliases });
        }
        globalThis[${K}] = { main: MAIN, gates: out };
      } catch (e) { globalThis[${K}] = "ERR:" + (e && e.message || e); }
    })();
    "kicked";`;
}

// ───────────────────────────────────────────────────────────────────────────
// Interactive `/rc` injection surface (a running interactive `claude`, not `remote-control`).
//
// The REPL-bridge path differs from headless: no environment / work / child-spawn — the
// interactive process creates a code-session and connects the SSE data-plane itself. To make
// `/rc` usable and pointed at our server we rebind three *underlying* functions (not consumer
// aliases), each located via the export table then its own definition body:
//   isBridgeEnabled      → kill-switch  `OOo()`  ⇒ always-true (the /remote-control command enables)
//   getBridgeBaseUrl     → override     `D7e()`  ⇒ our URL
//   getBridgeAccessToken → override     `L7e()`  ⇒ our token (凭证A)
// then four more that unblock the connect path (preflight / replinit / orguuid / httpscheme), and
// finally two that fix what the user is SHOWN once it works (weburl / qrnudge).
// Breakpoints sit at each consumer's function-body entry; those are hot paths under the TUI, so
// gate-rebind REMOVES each breakpoint after the first hit (headless gates sit on one-shot paths).
export interface InteractiveGateSpec {
  id: string;
  // How to find the function to breakpoint: by its export-table alias, or by a string anchor
  // inside it plus the declaration keyword to walk back to.
  locate: { exportName: string } | { anchorStr: string; declKeyword: string };
  rebindRe: string; // regex on the located function's body; each capture group = a name to rebind
  rebindValues: string[]; // rebindValues[i] is bound to capture group i+1 (after ${URL}/${TOKEN} fill)
  bpAnchor?: string; // if set, breakpoint at this substring inside the body (${N} = capture group N+1); else at the function-body entry
  // Keep the breakpoint after the first hit. Connect-time gates rebind *locals*
  // (`ie`, `le`, one-shot String.prototype) that are recreated on every `/rc`.
  sticky?: boolean;
}

export const INTERACTIVE_GATES: InteractiveGateSpec[] = [
  // /remote-control command enable: isBridgeEnabled ($D) short-circuits on kill-switch OOo().
  { id: 'int.enabled', locate: { exportName: 'isBridgeEnabled' }, rebindRe: '\\)\\{if\\(([\\w$]+)\\(\\)\\)', rebindValues: ['function(){return !0}'] },
  // getBridgeBaseUrl (aer) = D7e()??BASE_API_URL — rebind override D7e to our URL.
  { id: 'int.baseurl', locate: { exportName: 'getBridgeBaseUrl' }, rebindRe: '\\)\\{return ([\\w$]+)\\(\\)\\?\\?', rebindValues: ['function(){return ${URL}}'] },
  // getBridgeAccessToken (C4) = L7e()??… — rebind override L7e to our token.
  { id: 'int.token', locate: { exportName: 'getBridgeAccessToken' }, rebindRe: '\\)\\{let [\\w$]+=([\\w$]+)\\(\\)', rebindValues: ['function(){return ${TOKEN}}'] },
  // REPL-bridge PREFLIGHT (Aqi): before connecting it checks, in order, getBridgeDisabledReason
  // (NOo), a second disabled-reason (iii), the login check `if(!getBridgeAccessToken())` — which
  // int.token's L7e rebind already satisfies (returns 凭证A ⇒ truthy), so we must NOT touch it —
  // and a trusted-device requirement `G_n()` (guarded after a side-effect `await`). Rebind NOo/iii
  // → null and G_n → false so preflight falls through to "Prerequisites passed, enabling bridge".
  {
    id: 'int.preflight',
    locate: { anchorStr: 'Prerequisites passed, enabling bridge', declKeyword: 'async function' },
    // The login check and the side-effect call both drifted on 2.1.239 without changing what this
    // gate does, so both assertions are widened rather than branched:
    //   `if(!eF())return{kind`            → `if(!(Nt()&&e!==void 0?await iie(e):Wj()))return{kind`
    //   `await Eei(),await G_n()`         → `await Eei(e),await vFn()`
    // `if\(![^;]*?\)return\{kind` still asserts "a login check that returns {kind:…}" — it just no
    // longer insists the check is a bare call — and `\([^)]*\)` lets either call take an argument.
    // The async getter needs no rebind of its own: getBridgeAccessTokenAsync reads the same
    // `wge()` override as the sync one (verified in the 2.1.241 bundle), which int.token owns.
    rebindRe: 'let [\\w$]+=await ([\\w$]+)\\(\\);if\\([\\w$]+\\)return\\{kind[^]*?let [\\w$]+=await ([\\w$]+)\\(\\);if\\([\\w$]+\\)return\\{kind[^]*?if\\(![^;]*?\\)return\\{kind[^]*?await [\\w$]+\\([^)]*\\),await ([\\w$]+)\\([^)]*\\)',
    rebindValues: ['async function(){return null}', 'async function(){return null}', 'async function(){return !1}'],
    sticky: true,
  },
  // REPL-bridge INIT (Asc, bridge-repl-v2): reads getAccessToken() into `ie`; `if(!ie)` aborts
  // with "No OAuth token" (BYOK has none) BEFORE any request — this, not preflight, is what
  // stops the connection. The auth getter here is NOT getBridgeAccessToken, so int.token can't
  // help. Break at `if(!ie)` and set ie → 凭证A (pass the guard) AND o (getAccessToken) → 凭证A
  // (so `ne = () => o() ?? ie` authenticates our createCodeSession/fetchRemoteCredentials calls).
  {
    id: 'int.replinit',
    locate: { anchorStr: 'bridge_connect_no_token', declKeyword: 'async function' },
    rebindRe: '([\\w$]+)=([\\w$]+)\\(\\);if\\(!\\1\\)return[^]*?bridge_connect_no_token',
    bpAnchor: 'if(!${0})',
    rebindValues: ['${TOKEN}', 'function(){return ${TOKEN}}'],
    sticky: true,
  },
  // REPL-bridge INIT gating (HKm, init-repl-bridge): a long precondition chain. BYOK clears most
  // of it via the rebinds above (the OAuth check `if(!eF())` is satisfied because eF is
  // getBridgeAccessToken and int.token's L7e makes it return 凭证A; the token-override branch
  // short-circuits on L7e too). The org-UUID check `le=await k$();if(!le)` still fails — a BYOK
  // account has no org — so give `le` a synthetic UUID and init proceeds to createCodeSession
  // (our server doesn't validate the org).
  {
    id: 'int.orguuid',
    locate: { anchorStr: 'Skipping: no org UUID', declKeyword: 'async function' },
    rebindRe: '([\\w$]+)=await [\\w$]+\\(\\);if\\(!\\1\\)return [\\w$]+\\("no_org_uuid"',
    bpAnchor: 'if(!${0})',
    rebindValues: ['"ccc00000-0000-4000-8000-000000000000"'],
    sticky: true,
  },
  // Same inline scheme check as bridgeMain.httpscheme, on the /rc helper (throws, does not
  // exit). Quote-prefixed message is unique to this site (headless prefixes `Error: `).
  {
    id: 'int.httpscheme',
    locate: { anchorStr: '"Remote Control base URL uses HTTP. Only HTTPS or localhost HTTP is allowed."', declKeyword: 'async function' },
    rebindRe: '([\\w$]+)=[\\w$]+\\(\\);if\\(\\1\\.startsWith\\("http://"\\)',
    bpAnchor: 'if(${0}.startsWith("http://")',
    rebindValues: ['(function(u){var _s=String.prototype.startsWith;String.prototype.startsWith=function(){String.prototype.startsWith=_s;return!1};return u})(${0})'],
    sticky: true,
  },
  // ── What the user is shown once /rc works ──
  //
  // The session URL claude prints is built by `rw(sessionId, ingressUrl)` =
  // `${qVr(compatId, ingressUrl)}/code/${compatId}`, and `qVr` is the ORIGIN CHOOSER — a three-way
  // pick between localhost:4000 / the staging host / claude.ai. Left alone it hands the user a
  // DEAD link: an Anthropic host carrying a session id our server minted (`cse_<hex>`, which
  // claude's toCompatSessionId renders as `session_<hex>`). Rebinding `qVr` to our backend fixes it
  // at the source, which matters because the renderer cross-checks the message's url against
  // `store.replBridgeSessionUrl` — both read this one value, so they stay equal. It also fixes,
  // for free, claude's own "Show QR code" dialog, the /status footer fallback `${qVr()}/code`, and
  // the `Claude-Session:` git commit trailer.
  //
  // The breakpoint is `rw`'s body entry, i.e. BEFORE the `${qVr(o,t)}` interpolation, so the very
  // first call is already correct. Not sticky: `qVr` is a bundle-level function declaration, so one
  // assignment is permanent. Group 1 is `qVr` and deliberately nothing else — `o` is `let`-declared
  // and still in TDZ here, and gate-rebind assigns EVERY capture group, so capturing it would emit
  // `o=o` and throw.
  {
    id: 'int.weburl',
    locate: { anchorStr: '/code/${', declKeyword: 'function' },
    rebindRe: '=`\\$\\{([\\w$]+)\\([\\w$]+,[\\w$]+\\)\\}/code/\\$\\{',
    rebindValues: ['function(){return ${URL}}'],
  },
  // The inline ASCII QR under that line, for scanning with a phone.
  //
  // We do NOT replace the message factory. Its second parameter is `upgradeNudge`, which the only
  // call site leaves undefined, and which the renderer draws as an optional second row
  // (`<Box row>[<Text dimColor>"⎿  "</Text>, <Text dimColor>{nudge}</Text>]</Box>` inside a
  // `<Box row width={999}>` — so multi-line content neither wraps nor needs a renderer patch).
  // A breakpoint at the factory's body entry is BEFORE that parameter is read, so assigning the
  // PARAMETER is enough: the live invocation picks it up, there is no first-call miss, and we never
  // have to reproduce type/subtype/content/url/isMeta/timestamp/uuid — the shape stays claude's.
  //
  // The regex's `\1`/`\2` backreferences are the drift detector: they assert that parameter 1 is
  // the url and parameter 2 is the nudge, so a future reshuffle fails loudly instead of quietly
  // writing a QR into the wrong field. Group 1 is re-assigned to itself — an intentional no-op,
  // because gate-rebind assigns every group and we need `${0}` to name the url. `${1}||` leaves a
  // real upgrade nudge alone if claude ever starts passing one.
  //
  // Sticky: the factory runs once per bridge-status emit, so a reconnect must get a QR too. Every
  // failure path (encoder absent, url not ours, terminal too narrow, throw) yields `void 0`, which
  // makes the renderer's `nudge && …` falsy — the line renders exactly as it does today.
  //
  // The anchor is the field NAME, not the sentence. `or at ${e}` reads better and was unique
  // through 2.1.241, but 2.1.243 added a cloud-session message with the same tail ("Cloud session
  // active · code here or at ${e}") that sorts FIRST — and findAnchor takes the first hit, so the
  // walk-back would land in the wrong function entirely. `upgradeNudge:` is unique on every
  // version measured, and sitting past the span the regex needs leaves the body window its
  // maximum slack (the locator's window is anchor + 120 chars, and prose grows).
  {
    id: 'int.qrnudge',
    locate: { anchorStr: 'upgradeNudge:', declKeyword: 'function' },
    rebindRe: 'function [\\w$]+\\(([\\w$]+),([\\w$]+)\\)\\{return\\{type:"system",subtype:"bridge_status",content:`[^`]*`,url:\\1,upgradeNudge:\\2,',
    rebindValues: [
      '${0}',
      '(${1}||(function(_u){try{return globalThis.__cccQr(_u,{origin:${URL},maxWidth:((typeof process!=="undefined"&&process.stdout&&process.stdout.columns)||80)-6})||void 0}catch(_e){return void 0}})(${0}))',
    ],
    sticky: true,
  },
];

/**
 * Locator for the interactive gates. For each: resolve the consumer's minified alias from the
 * export table, find its `function <alias>(` definition, extract the underlying override alias
 * from the body, and place the breakpoint at the function-body entry (right after `){`).
 */
export function buildInteractiveLocatorExpr(globalKey: string, gates: InteractiveGateSpec[] = INTERACTIVE_GATES): string {
  const K = JSON.stringify(globalKey);
  const GATES_JSON = JSON.stringify(gates);
  return `
    globalThis[${K}] = "pending";
    (async () => {
      try {
        var MAIN = Bun.main;
        var s = await Bun.file(MAIN).text();
        var GATES = ${GATES_JSON};
        ${LOCATOR_PRELUDE}
        function expName(n){ var m = new RegExp(n + ":\\\\(\\\\)=>([\\\\w$]+)").exec(s); return m ? m[1] : null; }
        var out = [];
        for (var gi = 0; gi < GATES.length; gi++) {
          var G = GATES[gi], di = -1, alias = null;
          if (G.locate.exportName) {
            alias = expName(G.locate.exportName);
            if (!alias) { out.push({ id: G.id, error: "export-not-found" }); continue; }
            di = s.indexOf("function " + alias + "(");
          } else {
            var ai = findAnchor(G.locate.anchorStr);
            if (ai < 0) { out.push({ id: G.id, error: "anchor-not-found" }); continue; }
            di = s.lastIndexOf(G.locate.declKeyword, ai);
            var dm = /([\\w$]+)\\(/.exec(s.slice(di + G.locate.declKeyword.length, di + G.locate.declKeyword.length + 40));
            alias = dm ? dm[1] : null;
          }
          if (di < 0) { out.push({ id: G.id, error: "def-not-found", alias: alias }); continue; }
          var body = G.locate.exportName ? s.slice(di, di + 900) : s.slice(di, ai + G.locate.anchorStr.length + 120);
          var rm = new RegExp(G.rebindRe).exec(body);
          if (!rm) { out.push({ id: G.id, error: "rebind-re-not-found", alias: alias, body: body.slice(0, 160) }); continue; }
          var names = rm.slice(1);
          var bpIdx;
          if (G.bpAnchor) {
            var ba = G.bpAnchor.replace(/\\$\\{(\\d+)\\}/g, function(_, n){ return names[+n]; });
            var bi = body.indexOf(ba);
            bpIdx = bi >= 0 ? di + bi : s.indexOf("){", di) + 2;
          } else {
            bpIdx = s.indexOf("){", di) + 2;
          }
          var lc = absLineCol(bpIdx);
          out.push({ id: G.id, alias: alias, names: names, line: lc.line, col: lc.col });
        }
        globalThis[${K}] = { main: MAIN, gates: out };
      } catch (e) { globalThis[${K}] = "ERR:" + (e && e.message || e); }
    })();
    "kicked";`;
}
