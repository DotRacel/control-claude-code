# Internals

How the injector, the control-plane and the persistence layer actually work. Split out of the
README, which is now just the entry point.

## How it works

**Injection (inspector).** `claude` is a Bun standalone ELF with the JSC/WebKit inspector
compiled in. We launch it with `BUN_INSPECT=ws://127.0.0.1:<port>?wait=1` (pauses before
user code), attach, and — key discovery — **release with `Inspector.initialized`** (JSC has
no `Runtime.runIfWaitingForDebugger`; cc-injector believed wait was unreleasable). While
paused we read the bundle in-process via `Bun.file(Bun.main).text()` to locate each gate
(string/structural anchors → current minified aliases), set pending breakpoints, release, and
on each hit **rebind the local alias** with `evaluateOnCallFrame` (JSC has no `setReturnValue`;
source hot-swap is impossible — the bundle is one 62,951-line script). `Bun.main` is read at
runtime rather than hardcoded: the embedded entry path moved from
`/$bunfs/root/src/entrypoints/cli.js` (≤2.1.228) to the flattened `/$bunfs/root/cli`
(≥2.1.229) — see [Version compatibility](#version-compatibility).

**Gates rebound (parent `claude remote-control`):** `hasStoredOAuthToken`,
`getBridgeDisabledReason`, `checkBridgeMinVersion`, `isPolicyAllowed`,
`getTrustedDeviceUnenrolledReason`, `getBridgeAccessToken`→our token,
`getBridgeBaseUrl`→our URL.

**Multi-process.** bridgeMain spawns a child `claude --print --sdk-url …` that has its OWN
gate: `dHs()` rejects a non-Anthropic `--sdk-url` host. At the spawn site we inject
`BUN_INSPECT` into the child env, attach the child, and rebind `dHs`→`{status:'ok'}`.

**Control-plane vs inference-plane.** We only take over `getBridgeBaseUrl` (the REST +
data-plane root). The child inherits the user's `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`
and does inference through their own relay, untouched.

## Version note (2.1.231)

Diverged from the 2.1.193 reconstructed source we planned against: `session_ingress/ws` is
gone; the data-plane is now **CCR v2 code-sessions over SSE** — `GET .../worker/events/stream`
(SSE) + `POST .../worker/events`, plus `GET/PUT .../worker` and `POST .../worker/register`.
All version-fragile facts live in `src/injector/anchors.ts`; re-run `extract-anchors` on a
new version to refresh them.

## Version compatibility

Swept every published `@anthropic-ai/claude-code` version (Docker-isolated, `test/test-gates.ts`)
by `npm install`ing each one's native binary — no need to touch a real `claude` install to test
this. **Works ≥2.1.229** (all 6 headless gates locate/hit/rebind). **Fails ≤2.1.228**: the
embedded bundle's virtual-fs entry path was `/$bunfs/root/src/entrypoints/cli.js` before 2.1.229,
not the flattened `/$bunfs/root/cli` those newer builds use — the locators now read `Bun.main` at
runtime instead of assuming a path, so this axis of breakage is fixed for any past *or future*
rename. Below 2.1.229 the gate guard expressions themselves haven't been probed — the sweep never
got past locating the file before this fix.

## Version-profiled injection

The runtime string/structural anchors absorb a release's minified-**name** churn, but not a
change to a guard's **code shape**. So the gate set is **version-profiled**: `src/injector/
profiles.ts` defines `PROFILES`, each a gate set for a version range, and the injector detects the
claude version at launch (`detectClaudeVersion`) and picks one (`selectProfile`). `gate-rebind.ts`
then locates/rebinds that profile's gates.

Detection stays **off the launch's critical path**, deliberately. `claude --version` means booting
a ~340MB Bun binary (120–270ms warm, worse cold) to print a string the install layout already
spells out, and doing it *before* spawning made the launch 249ms → 427ms. So:

- `versionFromInstall` reads it from the filesystem instead — the native installer's
  `bin/claude → share/claude/versions/<x.y.z>` symlink, or the npm layout's `package.json`. Both
  are matched strictly; anything else returns null rather than guessing.
- only an unrecognised layout falls back to spawning `--version`, and
- `gate-rebind.ts` starts the resolution **concurrently** with spawn + port-wait + attach, awaiting
  it at the locator (the first point that needs it), so even that fallback overlaps the launch.

Most gates are shared across every version — only the ones that actually drifted **structurally**
carry variants in `anchors.ts` (named constants assembled by `headlessGates({trust, tokenUrl})`).
Drift that is merely cosmetic (a guard that gained a parameter, a match that slid past its window)
is absorbed by widening the one gate instead, so it never reaches this table. Known drift so far:

| profile | version range | `dispatch.trust` | `bridgeMain.tokenurl` |
|---|---|---|---|
| `legacy` | 2.1.229 – 2.1.237 | two functions: `enrollTrustedDeviceIfNeeded` + `getTrustedDeviceUnenrolledReason` | one getter: `if(!M())` |
| `preflight` | 2.1.238 only | one function: `preflightTrustedDeviceBlocking` | one getter: `if(!M())` |
| `async-token` | ≥ 2.1.239 | same as `preflight` | two getters, chosen at runtime: `if(!(U?await A(r):M()))` — both rebound |

A one-version profile like `preflight` is the expected shape, not a smell: 2.1.238 moved one guard
and 2.1.239 moved the next one over.

Selection is **optimistic and never refuses on the version number**: an unknown-newer claude gets
the newest profile, an unknown-older one gets the oldest (logged as `optimistic-newer` /
`optimistic-older`). A wrong guess degrades to a loud, specific "gate X did not locate" — never a
silent wrong-rebind. When a future release drifts a gate, add a variant in `anchors.ts` and a
`PROFILES` entry here.

`node test/verify-injection.ts` runs the injector's own locators for the detected profile (no auth
— idle `-p` host, read-only), and the `injection-compat` CI workflow runs it across a version
matrix so "which versions are covered" stays answered as new releases ship.

When that CI goes red — a release drifted a gate — [INJECTION-DRIFT-RUNBOOK.md](INJECTION-DRIFT-RUNBOOK.md)
is the step-by-step: read the error string, get the binary, find the new code shape, decide
widen-vs-branch, write the gate, reprofile, and verify (locate *and* rebind).

## Launch cost

A gate-rebound launch reaches "gates located, app released" in **~60ms** (interactive 66ms, headless
57ms, host claude 2.1.241). Worth knowing where it goes, because almost everything that made it slow
was waiting rather than working:

| phase | cost |
|---|---|
| two ephemeral ports (concurrent) | ~4ms |
| spawn → `BUN_INSPECT` port listening | ~15ms |
| websocket connect + 4 domain enables | ~4ms |
| locator: read the bundle, resolve every gate | ~35ms |
| set 7 breakpoints + `Inspector.initialized` | ~3ms |

Three rules keep it there, all of them learned by measuring rather than reasoning:

**Never put a fixed sleep on the critical path.** Two flat poll intervals — `waitForPort` at 80ms
and a 120ms first sleep before reading the locator's result — accounted for ~135ms of a 240ms
launch, waiting on work that had already finished in 15ms and 50ms respectively. Both now ramp from
2ms. Polling the inspector this fast is self-throttling, not wasteful: the target answers our
read-back on the same thread that runs the locator, so a poll issued mid-work simply doesn't return
until the work is done.

**The bundle is ~28MB / 60k lines — never scan it more than once for the same thing.** `findAnchor`
memoises `s.indexOf`, because the 7 headless gates share only 4 distinct window anchors and the
most-repeated one sits near the end of the file (~9ms per scan). `absLineCol` binary-searches one
newline-offset table instead of `s.slice(0, idx).split("\n")` per gate, which copied up to 28MB and
allocated a 60k-element array each time. Together: ~50ms off the locator.

**Detection reads the filesystem, not a process.** See the note under
[Version-profiled injection](#version-profiled-injection) — `claude --version` costs a full boot of
a ~340MB binary, and it is resolved concurrently with the launch besides.

What is left is mostly real work: the bundle read is ~2ms (bunfs is mapped, not copied), and the
rest is the regex matching each gate needs. The interactive locator is the slower of the two because
three of its gates resolve through export-table regexes that each scan the whole bundle — that is
the next thing to attack if this ever needs to be faster, and it is worth maybe 15ms.

## Layout

```
src/injector/
  ws-client.ts        WebKit inspector JSON-RPC over RFC6455 (ported from cc-injector)
  attach.ts           spawn + free-port + wait-for-port + connect + killTree (worker reaping)
  anchors.ts          ★ version-fragile: gate specs (named + variants), locators, rebinds
  profiles.ts         version → profile selection + claude version detection
  gate-rebind.ts      the injector core: parent + child gate rebinding
  extract-anchors.ts  offline tool: locate gates/aliases in the running bundle
src/server/
  store.ts            state: in-memory read cache + write-through to PG; runtime conn registry
  db.ts               PostgreSQL layer (pool, schema, queries) — no ORM
  schema.sql          environments / sessions / events DDL, applied idempotently on boot
  ws-ingress.ts       WS session_ingress server (legacy ≤2.1.193; unused on 2.1.231)
  index.ts            REST (environments/work/sessions) + CCR v2 SSE data-plane
src/cli.ts            test driver: server + injector + observe the whole handshake
test/test-gates.ts    injector-only check (gates crossed + base-url redirected)
test/verify-injection.ts  no-auth per-version gate-locate check (CI canary)
```

## Run

```bash
node src/cli.ts                       # full handshake loop, prints every step
CCC_DEBUG_FILE=/tmp/b.log node src/cli.ts   # + capture the bridge's debug log
node test/test-gates.ts               # injector-only assertion
node src/injector/extract-anchors.ts  # refresh anchors against the installed claude
```
Requires Node ≥22 (uses native TS type-stripping). Set `CLAUDE_BIN` to override the
`claude` path.

## Conversation (second version) — DONE

`node src/cli.ts` now drives a real remote turn end-to-end: it relays a user message over the
SSE data-plane, the child does inference with the user's BYOK creds, and the streamed reply
comes back. `--interactive` gives a multi-turn REPL; `--deny` refuses tool-use.

- **Data-plane**: server→child SSE `client_event` frames, child→server `POST .../worker/events`;
  worker lifecycle (`GET/PUT .../worker`, `GET .../worker/internal-events`).
- **Owner semantics (subtle!)**: a relayed message must carry `client_platform`
  (`web_claude_ai` etc.) or the headless worker demotes it to a cross-session *peer* ("Another
  Claude session sent a message", tools self-approved). Payload `origin` is ignored — the worker
  classifies by `client_platform`. With it, the message is owner keyboard input.
- **Permission round-trip**: `control_request{can_use_tool}` → we answer
  `control_response{allow|deny}` → the tool runs.

## Event catalog & tests (web foundation)

`EVENTS.md` is the full wire contract the front-end builds on — every event type and
shape on the CCR v2 data-plane, both directions, with real examples, the tool-call lifecycle
(`tool_use` → `can_use_tool` → `control_response` → `tool_result`), and a rendering guide.

`npm test` runs the suite (no claude needed, ~4s): frame/secret encoding, server relay +
worker-lifecycle endpoints, and fixture regression that pins the event shapes the web depends
on (incl. the owner-vs-peer `client_platform` invariant). Real-wire fixtures live in
`test/fixtures/`; refresh them with `npm run capture-events` (uses BYOK inference). Set
`DATABASE_URL` to also run the persistence tests (otherwise they skip — see below).

## Hosted web (third version) — DONE

Phones control sessions through a central server, scoped by a **credential** (凭证A). Same
credential ⇒ the injector and the web see each other.

The credential is an **account's token**: registration issues it, it never rotates, and the
server refuses one that belongs to no account. That is the whole point — before accounts, the
credential was a namespace key anyone could conjure by picking a string, so `Authorization:
Bearer <anything>` opened a private namespace. Registration is gated by an invite code
(`INVITE_CODE` on the server; unset ⇒ registration is closed, never open).

Run it:
0. `npm install && npm run db:up` — start PostgreSQL (docker compose) and export
   `DATABASE_URL=postgres://ccc:ccc@127.0.0.1:5432/ccc` (see `.env.example`).
1. `INVITE_CODE=<码> npm run server` — central server on `:8787` (accounts + bridge
   control-plane + CCR v2 data-plane + `/ws/client` web channel + serves `web/dist`). Without
   `DATABASE_URL` it still runs, in memory, and says so — nothing survives a restart, accounts
   included.
2. `cd web && npm install && npm run build` — build the mobile SPA once.
3. On your phone (LAN IP or a tunnel), open the server URL → register (username + password +
   invite code) or log in. On a desktop the same UI renders inside a 390×844 phone frame, so
   the real thing is reviewable without a device.
4. `node src/control-cli.ts` — first run opens a small TUI: pick a backend (the default is the
   hosted `https://ccc.racel.dev`, so a self-hosted server is 「添加新后端…」 once), then log in
   with the same account (or paste its
   token). The answer is saved to `~/.config/control-claude-code/config.json` (0600) and
   later runs skip straight to launching claude; `--login` reopens it to switch backend or
   account. Interactive by default (see below); `--headless` gives the phone-only
   `claude remote-control` process instead.
5. Your session appears on the phone → chat, with tool-use permission prompts.

- `--credential <token>` / `CCC_CREDENTIAL` bypasses the TUI entirely — that is the path
  scripts and the e2e harness take, and it is why they never meet a prompt.
- Data-plane is authenticated by the per-session ingress token, independent of accounts;
  `/ws/client` requires a token that belongs to an account and is scoped to it (a socket only
  touches its own sessions).
- `node test/e2e-web.ts` runs the whole hosted loop in one process (real inference):
  session list → message → streamed reply → `can_use_tool` permission → tool executes.

Files: `src/server/main.ts` (process entry), `src/server/web-channel.ts` (browser WS),
`src/control-cli.ts` (`control-claude`), `web/` (Vite + React SPA).

## Interactive `/rc` (fourth version) — DONE, verified

The main entry point, and the **default** mode: a user is vibing in a normal `claude` TUI and,
mid-session, wants it on their phone. `control-claude` launches the interactive TUI with the
`/rc` gates rebound; the user types `/rc` (optionally `/rc <name>`) and the session appears on
their phone — same web, same credential.

Unlike headless, the REPL bridge spawns **no child**: the interactive process creates a
code-session and connects the SSE data-plane itself. Two extra server endpoints back it:
`POST /v1/code/sessions` (createCodeSession, owned by 凭证A) and
`POST /v1/code/sessions/{id}/bridge` (fetchRemoteCredentials → `worker_jwt` = the session's
ingress token). Injection rebinds **six** gates (each breakpoint removed after the first hit —
hot TUI paths): enable the command (`isBridgeEnabled` kill-switch → true); redirect the
base-url/token overrides → our URL / 凭证A; clear the command preflight (disabled-reason +
trusted-device); inject a synthetic **org UUID** (a BYOK account has none — this was the real
blocker); and satisfy the transport init's OAuth check. A relayed web message is treated as
**owner** (bridgeOrigin), not a peer — no `client_platform` hack needed here.

- `node test/probe-interactive.ts` — asserts all six gates locate against the installed claude.
- `bash test/e2e-interactive.sh` — the full loop through tmux: inject → `/rc` → session on the
  server → web message → reply, checking owner semantics.
- `npm test` — the interactive control-plane (createCodeSession ownership + fetchRemoteCredentials
  + data-plane auth).

Run: `node src/control-cli.ts` (log in on first run), then type `/rc` in the TUI.

### CLI contract

```bash
control-claude                            # interactive claude + /rc injection (default)
control-claude --login                    # pick a backend / log in again
control-claude --resume                   # ← any unknown arg is forwarded to claude
control-claude -c --model opus "fix this"
control-claude -- --help                  # everything after -- is claude's, verbatim
control-claude --headless                 # old mode: injected `claude remote-control`
```

Controller-owned flags — `--login`, `--server`, `--credential`, `--cwd`, `--claude-bin`,
`--log-dir`, `--headless`, `-i/--interactive` (compat no-op), `-h/--help`. Every other token, in
order, is claude's argv; `--` forces the rest through even if it collides with a controller flag
name. A value flag with a missing/flag-looking value is a hard error rather than silently eating a
claude argument. `test/control-cli.test.ts` pins this contract.

Backend + account live in `~/.config/control-claude-code/config.json` (0600, one entry per
backend). The TUI (`src/tui.ts`, `src/cli-auth.ts`) only appears when it has to: no saved token,
`--login`, or a token the server has rejected. A server that is merely *unreachable* does not
trigger it — the saved token is still the best answer we have, and demanding a password every
time the LAN is out of reach would be wrong. `--credential` / `CCC_CREDENTIAL` skips it outright.
Both prompts degrade to plain numbered lines when stdin is not a TTY, so scripts can drive them.

Logs go to a directory, not the terminal (the TUI owns it): `~/.config/control-claude-code/logs/`
by default, `--log-dir` / `CCC_LOG_DIR` to move it. Each run writes `ccc-<stamp>-<pid>.log`
(controller + injector) and `ccc-<stamp>-<pid>.claude.log` (claude's stderr — always captured, an
unread stderr pipe would eventually stall claude), with `latest.log` / `latest.claude.log`
symlinked for `tail -f`; the newest 20 runs are kept. If claude exits nonzero its stderr tail is
echoed to the terminal so a bad forwarded argument stays visible. `CCC_CLAUDE_DEBUG=1` adds
claude's own `--debug` (also to `~/.claude/debug/<uuid>.txt`).

**Window titles under tmux / screen.** The host renames itself to `claude` (`process.title`) so
an automatic-rename terminal titles the window the way a direct `claude` run does. tmux takes the
window name from the *foreground process group leader's* `argv[0]` (`/proc/<pgid>/cmdline`), and
claude — our child — inherits our process group, so without the rename `#W` reads `node`
(measured) while claude's own OSC title only reaches tmux's `pane_title` (`#T`), which the common
`set-titles-string "#S / #W"` never renders. Putting the child in its own foreground group is not
an option: that needs `setpgid` + `tcsetpgrp` (no Node API), and `detached: true` calls `setsid()`,
which would cost claude its controlling terminal — no `SIGWINCH`, so the TUI would stop reflowing
on resize. `CCC_NO_PROCESS_TITLE=1` keeps the real argv when you'd rather see the controller in
`ps`.

## Persistence — PostgreSQL (fifth version) — DONE, verified

The server is meant to serve many users, so state lives in PostgreSQL. Four tables
(`src/server/schema.sql`): `users`, `environments`, `sessions`, `events`. The `credential` columns
hold a `users.token`, denormalised with no FK: the namespace key predates the accounts table, and
a session outliving its account is a data question rather than a constraint worth paying for on
the event-ingest path.

Passwords are scrypt (N=16384, r=8) with the parameters stored alongside the hash, so the cost can
be raised later without invalidating anyone. Accounts are cached in memory in full — unlike
sessions there is no time window, because `store.userByToken()` has to answer *synchronously*
(the `/ws/client` upgrade handler has nowhere to await) and a token issued years ago must still
work.

```bash
npm install && npm run db:up          # postgres:17 via docker compose (loopback-only :5432)
export DATABASE_URL=postgres://ccc:ccc@127.0.0.1:5432/ccc
npm run server                        # schema is applied idempotently on boot
npm run db:psql                       # a shell in the database
```

**Design: in-memory read cache + write-through.** Since the server is single-instance, PG never
has to coordinate between processes, so it only has to be the source of truth:

| | |
|---|---|
| boot | `store.load()` pulls the last 30 days into `envs` / `sessions` maps |
| reads | served from the maps — **synchronous** (`owns()` runs on every websocket frame) |
| writes | memory + PG in the same call — the only methods that became `async` |
| events | never cached; `historyFor()` is a query, `appendEvents()` a batched INSERT |

That is why the migration touched ~8 call sites instead of ~73: `sessionsForCredential`,
`sendToChild`, `sessionByIngressToken`, `view`, `nextWork` and friends never changed signature.

**Deliberately not persisted**, because storing it would be wrong rather than merely wasteful:
SSE response handles, `wsConnected` / `online` (a restart must report offline), the SSE `seq`, and
the work queue (an in-flight lease is void after a restart — the injector re-registers). Plus
`stream_event`: token-level deltas are relayed live but never stored, since the full `assistant`
message already carries the text and storing them would multiply writes for no replay value.

Two more consequences worth knowing:

- **`last_activity` is batched.** `touch()` fires on every inbound event, so it only marks the
  session dirty; a 30s timer (and `store.close()` on SIGINT/SIGTERM) does one `UPDATE … from
  unnest(...)` for everything that accumulated.
- **A live session reconnects itself across a restart.** `ingress_token` is persisted, so a
  running claude's data-plane re-authenticates against the new process and the session goes back
  to `active` on its own — no second `/rc`. (`e2e-persist` shows exactly this; kill the TUI too
  and it correctly reports `offline` instead.)
- **A cold session is recoverable, not lost.** Sessions older than the load window aren't in the
  cache, but `POST /v1/code/sessions/{id}/bridge` recreates an unknown `cse_*` id under the
  calling credential, so a returning TUI just re-signs its worker token.

Without `DATABASE_URL` the server still runs, in memory, and says so — `new Store()` is the same
single implementation with persistence switched off, which is what the unit tests and
`src/cli.ts` use.

Verified by:
- `npm test` — with `DATABASE_URL`, `test/db.test.ts` runs write-through, restart-reload,
  transcript ordering, the `stream_event` exclusion and the `last_activity` batching against the
  real database. Without it those 6 tests skip and the suite stays zero-dependency (~4s).
  Those tests TRUNCATE, so they get their own tables via `createPool(url, { schema: 'ccc_test' })`
  (a per-connection `search_path`) — the same database as the server, never its `public` tables.
  **Any new test that writes must use that schema**; pointed at `public` it would delete live
  sessions.
- `npm run e2e-persist` — the whole thing: inject → `/rc` → web message → real reply → stop the
  server → **start a new process** → the transcript comes back from PG with claude gone.

## Worker reaping (headless only)

`claude remote-control` forks a **worker claude** (`--print --sdk-url …`) as a *grandchild*, so
killing the process we spawned leaves the worker behind (PPID→1). Whether it then exits depends on
something outside our control: with the server still up it notices and quits within ~12s, but if
the server died first it retries the dead `--sdk-url` **forever**, holding ~370 MB at 0.4% CPU.
Ten of those (7–18 hours old, 3.5 GB total) accumulated in one day of testing before this was
found.

`killTree()` in `attach.ts` fixes it: snapshot the process tree from `/proc` **before** anything
dies (once an intermediate exits, its children re-parent to init and become unreachable), then
signal deepest-first. Verified at 0.5s after SIGTERM/SIGINT, versus the old behaviour reproducing
the orphan in the same window.

Two things it deliberately does *not* do:
- **No process groups.** The worker inherits the group it was spawned in — the *caller's* — so
  `kill(-pid)` would take out the user's own shell or tmux window. `detached: true` would give the
  child its own group, but it also moves the child out of the caller's group, which makes the
  SIGKILL-the-host case (where no cleanup code runs at all) leak *more* reliably. Walking `/proc`
  costs one scan and has neither problem.
- **Interactive `/rc` is untouched.** That path must stay in the foreground process group to own
  the terminal, and it spawns no worker, so it has no grandchild to leak.

## Next

A real-phone LAN test (only tmux-automated so far), https cloud deploy, and the compose `app`
service.

The accounts table landed (registration, login, invite gate, strict token checks). What it still
does not do: **token revocation / rotation** (a leaked token is good forever — there is no way to
re-issue one without editing the row), **password change or recovery**, per-account **quota**, and
invite codes as first-class rows (they are one `INVITE_CODE` env var, so it cannot be revoked per
person or trace who used it). Login rate-limiting is per-username and in memory, which a restart
forgives and which does nothing against an attacker spreading attempts across many usernames.
