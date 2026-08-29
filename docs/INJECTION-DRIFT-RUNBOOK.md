# Injection Drift Runbook

What to do when the `injection-compat` CI goes red — i.e. a `claude` release reshaped one of the
guards the injector patches, and a gate no longer locates. Written from the fixes that actually
happened (2.1.229 path drift, 2.1.234 spawner window, 2.1.238 `dispatch.trust` merge, the
four-gate 2.1.239 release), so it encodes the judgement calls, not just the steps.

Read [docs/INTERNALS.md](INTERNALS.md) (the "Version-profiled injection" section) first if you
haven't — this runbook assumes you know what a gate and a profile are.

---

## 0. The mental model — why this keeps happening

The injector never depends on minified symbol names. Every gate is found at **runtime** by reading
the bundle source (`Bun.file(Bun.main).text()` inside the target) and matching **string /
structural anchors**, then pulling the current minified alias out with a regex (`anchors.ts`). So:

- A release that only **renames** locals keeps working — the anchors still match, the regex just
  captures a different letter. Most releases are this. You do nothing.
- A release that **reshapes the code around a guard** (merges two functions into one, moves a
  statement, changes a call site) breaks the anchor/alias/bp-substr for that one gate. That is a
  *drift*, and that is what this runbook fixes.

The gate set is **version-profiled** (`profiles.ts`): a profile bundles the gate set for a version
range, and the injector detects the claude version at launch and picks one. A fix is therefore
usually "add a gate variant + a profile", not "edit the one true gate".

**Most releases move one gate; some move several, and that does not mean several profiles.**
Across 2.1.236→2.1.238 exactly one of fifteen gates moved. 2.1.239 moved four — but three of those
were the same code sliding around (a call gaining an argument, a match sliding past its window) and
only one was a guard growing a second code path. Diagnose each failing gate independently and
expect most of them to be widens.

---

## 1. Read the signal

CI red: open the failed `injection-compat` job. Unattended runs check **`latest` only**, so the
build that drifted is whatever `npm view @anthropic-ai/claude-code version` says today — the step
log prints it, along with the per-gate table and the failing ids. (A `workflow_dispatch` run names
the version you gave it in the leg.)

The **error string is the diagnosis** — it tells you which layer of the gate broke:

| verify-injection says | meaning | where to look |
|---|---|---|
| `anchor-not-found` | the `windowAnchor` string is gone | the feature/telemetry-marker was renamed or removed |
| `alias-not-found` | anchor found, but the alias regex didn't match | **the code shape changed** — most common; a guard was refactored |
| `bp-substr-not-found` | aliases resolved, but the breakpoint substring isn't in the window | the statement the breakpoint sits on was rewritten |
| `MISSING from locator output` | the gate id never came back | locator threw, or the gate array is malformed |
| (interactive) `export-not-found` | the export-table name is gone | the function was renamed in the export map |
| (interactive) `rebind-re-not-found` | function found, its body regex didn't match | the function body was refactored |

`alias-not-found` with an empty `partial={}` means the very first alias failed; a non-empty
`partial` tells you which aliases *did* resolve, so you know how far in the shape held.

---

## 2. Get the offending binary — no auth needed

You never need a credential to diagnose drift: everything here reads the bundle, it never crosses a
gate or hits the network.

The native installer keeps versions side by side:

```bash
ls ~/.local/share/claude/versions/         # already-installed builds, usable as CLAUDE_BIN
```

For any published version, install it into a throwaway dir (this pulls the ~330 MB native ELF as an
optional dep — the `linux-x64` package is the real binary; the postinstall step is not required):

```bash
mkdir -p /tmp/cc-<ver> && cd /tmp/cc-<ver> && npm init -y >/dev/null
npm install @anthropic-ai/claude-code@<ver> --no-audit --no-fund
BIN=$PWD/node_modules/@anthropic-ai/claude-code-linux-x64/claude
"$BIN" --version    # sanity
```

---

## 3. Reproduce and localize

```bash
CLAUDE_BIN="$BIN" node test/verify-injection.ts
```

This detects the version, picks the profile, and prints the per-gate table with the same error
strings CI showed. Confirm the failing gate and note the **profile it selected** — if a *new*
version fails on the newest profile, you'll be adding a profile; if an *old* version fails, the
existing profile's range is wrong.

`CCC_VERBOSE=1` streams claude's stderr while probing, if the process is dying before attach.

---

## 4. Find the new code shape

You have to see what the guard looks like now. Two ways, both read `Bun.file(Bun.main)` from inside
the target (never `Debugger.getScriptSource`/`searchInContent` — they **hang** on the 60k-line
bundle):

```bash
CLAUDE_BIN="$BIN" node src/injector/extract-anchors.ts   # dumps context windows around key anchors
#   → artifacts/anchors-dump.json  (each probe: {line, col, count, ctx})
```

The `ctx` field is a ±radius slice of real source around the anchor. Grep it for the function names
you expect (`grep -o '.\{0,80\}TrustedDevice.\{0,120\}' <<<"$ctx"`), and you'll see the new form.
Add a probe to `PROBES` in `extract-anchors.ts` if the anchor you need isn't dumped yet.

**Compute the offset from the window anchor** — the locator only searches `windowAnchor - windowBack`
… `windowAnchor + windowFwd`. If the new guard sits past `windowFwd`, the alias will never match even
though the string is in the bundle. Measure it:

```python
# in artifacts/anchors-dump.json, for the dispatch gates whose anchor is 'cli_bridge_path':
ctx = dump['dispatch.entry']['ctx']; anchor='cli_bridge_path'
print(ctx.find('theNewFunctionName') - ctx.find(anchor))   # must be < windowFwd
```

This is the trap that broke `spawner.spawn` on 2.1.234: the matched span drifted to the far edge of
the window and got sliced off. **Keep the match well inside the window; widen `windowFwd` if needed.**

---

## 5. Decide: let it ride, widen, or branch

Not every diff needs a code change. Work down this list:

1. **Only a name changed** → do nothing. The locator already absorbs it. (Verify: the gate is green
   on the new version. If it isn't, the regex was over-specific — go to 2.)
2. **Same structure, new and old both matchable by one regex** → **widen the existing gate's
   regex**, don't branch. One gate keeps covering every version. This is what fixed `spawner.spawn`:
   `env:([\w$]+),windowsHide` → `env:([\w$]+)[,}]` dropped the fragile trailing token. Prefer this
   whenever the shapes are the same idea with a cosmetic difference.
3. **The structure genuinely changed** (functions merged/split/removed, a guard rewritten) → **add a
   gate variant + a profile.** This is what `dispatch.trust` needed on 2.1.238: two functions
   (`enrollTrustedDeviceIfNeeded` + `getTrustedDeviceUnenrolledReason`) became one
   (`preflightTrustedDeviceBlocking`). No single regex should straddle a real structural change —
   that produces a gate that matches the wrong thing on one side.

Rule of thumb: **widen for cosmetics, branch for structure.** A widened regex that has to encode an
"A or B" of two different code shapes is a branch wearing a disguise — branch instead.

**Zeroth question, before any of that: does this gate carry weight?** Two of them do not.
`int.weburl` and `int.qrnudge` only change what the `/rc` line *shows* — the session link and its
QR. If either drifts, `/rc` still connects and the phone still works; the user just gets the
Anthropic-hosted link back, or no QR. So when one of those is the only red row, **let it ride until
you are touching that area anyway**. Spending the fix-it-now budget on a cosmetic gate is how the
gates that actually gate things end up waiting.

Read the report accordingly: 9 interactive gates, but only the first seven can cost someone their
session.

---

## 6. Write the gate (or variant)

Gates live as **named constants** in `anchors.ts` (`GATE_DISPATCH_OAUTH`, …); a gate with variants
just gets a second constant (`GATE_DISPATCH_TRUST_LEGACY` / `_PREFLIGHT`,
`GATE_BRIDGEMAIN_TOKENURL_SYNC` / `_ASYNC`) and a field on `GateVariants`, which
`headlessGates({trust, tokenUrl})` reads to assemble a profile's set. Add the field rather than a
positional parameter — every variant is a `GateSpec`, so positional args let a swapped call compile
clean. A `GateSpec` is four things:

- `windowAnchor` + `windowBack`/`windowFwd` — the slice to search (keeps regexes unambiguous).
- `aliases` — `{ name: regex }`, capture group 1 is the current minified alias.
- `bpSubstr` — after `${alias}` substitution, the substring whose index is the breakpoint column.
- `rebinds` — statements (after `${alias}`/`${TOKEN}`/`${URL}` fill) run in the paused frame.

**Alias-regex tips**
- Minified names can contain `$` — always `[\w$]+`, never `\w+`.
- Delimit so you capture the whole name: `hasStoredOAuthToken:([\w$]+)\}` (object-literal value ends
  at `}`), `getBridgeDisabledReason:([\w$]+)[,}]` (or `,`), destructuring
  `{preflightTrustedDeviceBlocking:([\w$]+)\}`.
- On lightly-minified early builds the "alias" is the real name (`W:W`, `dHs:dHs`). That's fine — the
  regex captures whatever's there.

**Breakpoint placement** — pick a statement that pauses **before** the guard reads the alias, so the
rebind is in effect when the original code runs. For `preflightTrustedDeviceBlocking` the site is
`W=await Z()`, so `bpSubstr: '=await ${Z}()'` pauses with `Z` bound but not yet called; the rebind
then swaps `Z` and the `await` uses the new one. (JSC's `Debugger.paused` carries no
`hitBreakpoints` — gate-rebind dispatches by (line, nearest column), so the substring only needs to
land on the right statement, not the exact char.)

**Rebind cookbook** — match the guard's type:

| guard | rebind |
|---|---|
| boolean gate `if(!X())` | `${X}=function(){return !0}` (or `!1` to force the other way) |
| async "reason" getter, null = OK | `${X}=async function(){return null}` |
| value override (token / url) | `${X}=function(){return ${TOKEN}}` / `${URL}` |
| method on a primitive string (`u.startsWith`) | can't reassign the property — one-shot patch the prototype and self-restore: `var _s=String.prototype.startsWith;String.prototype.startsWith=function(){String.prototype.startsWith=_s;return!1}` |
| the child-spawn site | leave `rebinds: []` — it's special-cased in gate-rebind (inject `BUN_INSPECT` into the spawn env, then attach + rebind the child's own `dHs` `--sdk-url` gate). See [injection-mechanics] in memory. |

Interactive `/rc` gates (`INTERACTIVE_GATES`) locate differently — by export-table name or a body
anchor + `declKeyword`, then a `rebindRe` over the function body — but the same widen-vs-branch and
rebind-type judgement applies.

---

## 7. Add / update the profile

In `profiles.ts`:

- New structural variant → new `PROFILES` entry with `since` = the first version that has the new
  shape, `verifiedThrough` = the highest version you actually measured green, and
  `gates: headlessGates(<newVariant>)`.
- Set the previous profile's `verifiedThrough` to the last version before the drift.
- `interactiveGates` and the child `--sdk-url` locator are shared unless *they* drifted — only add
  variants for what actually moved.

Selection is optimistic and never throws, so you don't have to handle "unknown version" — a version
past the newest `since` gets the newest profile; the point of the profile boundary is to route each
known range to the gates that match it.

---

## 8. Verify — locate is not enough

1. **Locate, on the new build AND downward.** Unattended CI watches `latest` only, so this step is
   the *only* thing standing between a widened regex and a silently broken older profile — nothing
   will catch it for you later.
   ```bash
   for v in <new> <new-1> <oldest-in-each-surviving-profile>; do
     CLAUDE_BIN=~/.local/share/claude/versions/$v node test/verify-injection.ts | grep -E 'profile:|PASS|FAIL'
   done
   ```
   The new version must go green on the new profile **and** every older profile's floor must still
   pick that older profile and stay green — no regression from a too-wide `since`, and none from a
   loosened regex on a shared gate (see the DOWNWARD note in the appendix). Versions you don't have
   locally: step 2 installs any published tag into a throwaway dir.
2. **Unit tests:** `npm test` — `test/profiles.test.ts` covers the selection logic; add a case for
   the new boundary.
3. **Rebind, on real metal:** `verify-injection` proves a gate *locates*, not that its rebind
   *neutralizes* the guard. Two scripts prove that, and they cover different halves:
   ```bash
   CLAUDE_BIN="$BIN" node test/test-gates.ts        # stub server + real remote-control, asserts POST /v1/environments/bridge
   CLAUDE_BIN="$BIN" node test/test-spawn-chain.ts  # real in-process controller: the worker spawn + the child's own dHs gate
   ```
   Always run these for a **new rebind** (a new `bpSubstr`/`rebinds`), even if locate is green — a
   rebind can locate perfectly and still fail to neutralize (wrong return value, wrong pause point).

   **`test-gates.ts` alone is not "the rebind is verified".** Its stub answers `/work/poll` with no
   work, so bridgeMain never spawns the worker and `spawner.spawn` reports `hit=false` there
   permanently — which reads like coverage and is the absence of it, on the one gate whose window has
   now drifted twice. `test-spawn-chain.ts` stands up the real controller (in-memory, no Docker, no
   DATABASE_URL, no credential of yours) so registration queues work, the spawn happens, and the
   child's `--sdk-url` gate is rebound and *used*. It reports its six links in order, so a red run
   tells you which one broke — and if a gate merely failed to locate it says so and sends you back
   here rather than blaming the chain.
4. **CI:** nothing to add — `injection-compat` tracks `latest` on a daily cron, which is what
   catches the *next* release. Use its `workflow_dispatch` input to run a specific version when you
   want a boundary re-checked in CI rather than locally.

---

## 9. Land it

- Update the `verifiedThrough` values (the matrix is `latest`-only; there is no version list).
- Update [docs/INTERNALS.md](INTERNALS.md) (the profile table) and the `version-compat-boundary`
  memory with the new drift + fix, so the next drift starts from the current truth.
- Commit with a conventional prefix (`fix:` for a re-widened regex, `feat:` for a new profile) in
  **English**, and push straight to `main` (single-maintainer repo — no branch, no PR).

---

## Appendix — drift history (for pattern-matching the next one)

| version | what moved | fix class |
|---|---|---|
| ≤2.1.228 → 2.1.229 | embedded bundle path `/$bunfs/root/src/entrypoints/cli.js` → flattened `/$bunfs/root/cli` | read `Bun.main` at runtime, never hardcode the path (fixed for all future renames) |
| 2.1.234 | `spawner.spawn` env-options literal grew; `windowsHide` fell past `windowFwd` | **widen** regex `env:([\w$]+)[,}]` + `windowFwd` 1200→1600 |
| 2.1.238 | `dispatch.trust`: two trusted-device functions merged into `preflightTrustedDeviceBlocking` | **branch** — `preflight` profile, alias `Z`, rebind `→ return null` |
| 2.1.239 | `dispatch.trust`: the merged call gained an argument (`await K(Z)`, was `await K()`) | **widen** — `bpSubstr` stops at the open paren: `=await ${Z}(` |
| 2.1.239 | `spawner.spawn`: env construction grew, `env:m` slid to +2007 past a `windowFwd:1600` | **widen** — `windowFwd` 1600→3600 (the 2.1.234 failure, verbatim, one release later) |
| 2.1.239 | `int.preflight`: login check became a ternary, side-effect call gained an argument | **widen** — `if\(![^;]*?\)return\{kind` + `\([^)]*\)` on both calls |
| 2.1.239 | `bridgeMain.tokenurl`: `getBridgeAccessTokenAsync` added beside the sync getter, chosen at runtime | **branch** — `async-token` profile, aliases `M`/`A`/`P`/`U`, three rebinds |
| 2.1.248 | all three `dispatch.*` guards lifted out of the entry into `chunk-77n86n8h.js`, regrouped into `refuseRemoteControlLocally` / `refuseRemoteControlIneligible` / `startRemoteControl` — `cli_bridge_path` no longer reaches any of them (`alias-not-found partial={}` ×3) | **branch** — `chunked-dispatch` profile; each gate re-anchors on a `<exportName>:` destructure key unique to that chunk; policy rebinds the shared `exitWithError` (one bp, three checks) since `isPolicyAllowed`'s alias imports only after the first two guards run |
| 2.1.248 | interactive `int.enabled`/`baseurl`/`token`: the barrel's defining chunk uses a **bare** `export{n}` (with a non-renaming named import), which `resolveExport`'s `localFor` didn't recognise (`export-unresolved`) | shared-locator fix — `localFor` learned the `export{…,n,…}` form (only after the two renaming forms fail, only inside an `export{}` clause) |
| 2.1.248 | latent: `getBridgeBaseUrl` minifies to local `$ae`; `$` is a regex metacharacter, so a local spliced raw into the import-edge regex silently failed to match (only `int.baseurl` drifted; `int.token`=`Ig` was fine) — surfaced by the fix above | shared-locator fix — `reEsc` escapes `$` before any local goes into a `new RegExp` |

The pattern: path/name churn is absorbed automatically; window-edge fragility is a widen; a real
structural change is a branch. When unsure which, the error string in step 1 and the offset math in
step 4 tell you.

**2.1.248 is the second instructive multi-gate release: six gates failed, and only ONE was a
profile branch.** The dispatch trio was one structural relocation (one branch, three gates). The
three interactive failures were not a profile matter at all — they were two bugs in the *shared*
`/rc` export-resolver (`localFor` missing the bare-export shape, and unescaped `$` in a spliced
local), fixed once for every version. A re-chunk that renames every chunk and reshapes the export
tables looks catastrophic in the gate table; read each error string and most of it is the resolver,
not the profile. The `$ae` bug also earns the DOWNWARD-verify note twice over: it was invisible on
`latest` (2.1.251, where `getBridgeBaseUrl`=`Gue`) and only appeared on 2.1.248/.250 — exactly the
older-version regression that `latest`-only CI cannot see.

**2.1.239 is the instructive one: four gates failed at once, and only one of them was a branch.**
A red CI leg with several failing gates is not four separate structural changes — read each error
string on its own. Three of these were the release moving code around; one was a guard genuinely
gaining a second code path. Branching all four would have meant three gates that each need a new
variant on every future release, for nothing.

**A widen still has to be re-verified DOWNWARD, and only you can do it.** `windowFwd` can only grow
the search space, so its first match cannot move — but a loosened regex can match a *different,
shorter* span on an older bundle. Run the oldest version in each surviving profile's range, not just
the new one.

Profiles do not protect you here, and it is worth being precise about why: a profile scopes a gate
*variant* to a version range, but a widen edits a gate that **all** profiles share. So a widen can
break `legacy` while `latest` stays green — and since unattended CI checks `latest` only, that break
ships. Most drift fixes are widens (three of the four on 2.1.239), which makes this the common case,
not the exotic one.
