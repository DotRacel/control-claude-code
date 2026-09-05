# CCR v2 Data-Plane Event Catalog

The wire contract between our controller server and the child `claude` worker, and therefore
the contract the web front-end builds on. Every message is a **stream-json SDK message** carried
as a `payload`:

- **server → child** — SSE frame on `GET .../worker/events/stream`:
  `event: client_event\ndata: {"sequence_num":N,"event_id":"…","event_type":"relay","payload":{…}}\nid: N\n\n`
- **child → server** — `POST .../worker/events` body `{"worker_epoch":N,"events":[{"payload":{…}}]}`

The server exposes this as `sendUserMessage` / `sendControlResponse` (send) and the
`claude.event` callback (receive). Fixtures of every real event live in
`test/fixtures/` (`child-events.jsonl`, `event-samples.json`), captured by `test/capture-events.ts`.

Legend: ✓ = observed on the wire at runtime · ○ = defined in `sdk-control-protocol-schemas.js`
but not seen in the capture run (rarer paths).

## Correlation IDs

- `uuid` — unique per message.
- `request_id` — pairs a `control_request` with its `control_response`.
- `tool_use_id` (aka `toolu_…`) — the thread that ties **`assistant` tool_use** →
  **`control_request` can_use_tool** → **`user` tool_result** together.

---

## server → child (what the web SENDS)

### `user` — a user turn ✓
```json
{ "type": "user",
  "message": { "role": "user", "content": "…text… or content blocks" },
  "client_platform": "web_claude_ai" }
```
**`client_platform` is mandatory** (`ios`/`android`/`web_claude_ai`/`desktop_app`). Without it the
worker demotes the message to a cross-session *peer* ("Another Claude session sent a message",
tools self-approved). With it, the message is owner keyboard input (`origin:{kind:"human"}`) and
the normal permission flow runs. Payload `origin` is IGNORED by the worker — only `client_platform`
decides ownership.

### `control_response` — answer a permission (or other) request ✓
```json
{ "type": "control_response",
  "response": { "subtype": "success", "request_id": "<from the control_request>",
    "response": { "behavior": "allow" } } }
```
`behavior`: `"allow"` | `"deny"`. Allow may also carry `updated_input` (edited tool input) and
`permission_updates`. Error form: `response:{ "subtype":"error", "request_id", "error":"…" }`.

### `control_request` (host→child) — drive the session ○
`{ "type":"control_request", "request_id":"…", "request":{ "subtype":<X>, … } }` where subtype:
- `interrupt` — cancel the in-flight turn.
- `set_permission_mode` — `{subtype:"set_permission_mode", mode:"default"|"acceptEdits"|"plan"|"bypassPermissions", …}`.
- `set_model` — switch model. · `set_max_thinking_tokens`. · `initialize` — handshake. ·
  `apply_flag_settings`, `mcp_message`, `hook_callback`.

---

## child → server (what the web RENDERS)

### `system` (subtype-tagged) — session + progress signals
- `init` ✓ — session metadata. Fields: `cwd`, `session_id`, `tools:[…]`, `model`,
  `permissionMode`, `slash_commands:[…]`, `agents`, `skills`, `mcp_servers`, `output_style`,
  `capabilities`. **Use this to seed the web UI** (available tools, current model/mode).
- `post_turn_summary` ✓ — `{summarizes_uuid, status_category, status_detail, needs_action}`; a
  short human status of the turn ("replied with hi as requested").
- `task_started` ✓ (`{task_id, task_type:"local_bash"|"local_agent", description, prompt,
  tool_use_id, workflow_name}`) · `task_progress` ✓ (`{task_id, description, summary,
  usage:{tool_uses,duration_ms,total_tokens}, last_tool_name,
  workflow_progress:[{type:"workflow_phase",index,title}]}`) · `task_updated` ✓
  (`{task_id, patch:{status,end_time}}`) · `task_notification` ✓ (`{task_id, status, summary,
  output_file, tool_use_id, usage}`) · `task_summary` ○ — background-task lifecycle.
  Two things a client has to get right: between `task_started` and the notification, a long
  workflow reports **only** through `task_progress` (a card with no progress is a spinner for
  minutes), and `task_updated` can be the **only** event that says a task finished.

  **The three producers do not share a status vocabulary.** One user pressing stop, in one
  session, produced `task_updated.patch.status:"killed"`, `task_notification.status:"stopped"`,
  and `<status>killed</status>` in the `<task-notification>` text echo. `completed` and `failed`
  are the only words all three agree on, so a client that maps its own subset and lets the rest
  fall through to a default WILL mislabel a stop — ours reported 完成 above a summary reading
  `Agent "…" was stopped by user`. Map them in one table (`src/task-status.ts`) and file an
  unrecognised word as backlog rather than guessing.

  **`summary` is not a label.** For a `local_bash` task it is one line ("Run quarkusBuild to
  validate CDI wiring"); for a `local_agent` it is the subagent's ENTIRE final report — 30122
  characters of markdown in a 5006-event history, and 7 of 35 task cards were titled with one.
  It is also not a duplicate of anything: the Agent `tool_result` for the same `tool_use_id` is a
  different, much shorter text (1100 vs 7794 chars in one sampled pair), so the notification is
  the only place that report exists. Take a headline for the card, keep the body behind a toggle,
  and prefer the spawning Agent call's own `description` (found via `tool_use_id`) as the title.

  `usage` on the notification is the same shape as `task_progress`'s and is often the ONLY copy:
  a task that finished without ever emitting a progress frame carried its counts here alone.
- `thinking` ○ · `thinking_tokens` ✓ (`{estimated_tokens, estimated_tokens_delta}`) — reasoning progress.
- `notification` ○ · `os_notification` ○ · `informational` ○ — surfaced notices.
- `status` ✓ — the same notices group, but the only use observed on the wire is compaction, as a
  pair: `{status:"compacting"}` when it starts, then `{status:null, compact_result:"success"}` when
  it lands (26 of each in a 13846-event census, never another value). The start is worth showing —
  compaction runs for **minutes** (228s at the top of the sampled range) with no tool open and no
  reasoning, so nothing else accounts for the wait. Because the subtype is generic, a client must
  not treat "handled" as a wildcard here: an unrecognised notice belongs in the backlog.
  A failure carries `compact_error` alongside the result — `{compact_result:"failed",
  compact_error:"aborted"}` — and that is the field worth putting on screen; `compact_result` only
  ever repeats the word "failed".
- `api_error` ○ · `api_retry` ○ · `permission_denied` ○ · `permission_retry` ○ — error/retry.
- `vcs_state_changed` ✓ — `{kind:"commit"|"push", branch, cwd}`; emitted after the agent commits
  or pushes. The one side effect a reader cannot undo by reading further, so it is worth a line.
- `worker_shutting_down` ✓ — `{reason:"host_exit"}`; the terminal-side claude is going away. No
  `result` is coming, so anything still claiming to be in flight has to be wound down.
- `compact_boundary` ✓ · `compact_start`/`compact_progress`/`compact_end` ○ — context compaction.
  `{compact_metadata:{trigger:"auto"|"manual", pre_tokens, post_tokens, duration_ms,
  cumulative_dropped_tokens, preserved_messages:{anchor_uuid, uuids:[…], all_uuids:[…]},
  preserved_segment:{anchor_uuid, head_uuid, tail_uuid}}}`. A hard break in what the model can
  still see, so it earns the same treatment as `conversation_reset`; `pre_tokens → post_tokens`
  (167k → 26k in the sampled runs) is the part worth putting on screen, and the two `preserved_*`
  objects are uuid bookkeeping with nothing renderable in them. Arrives AFTER the `status` pair
  above, so a client that renders both must not announce the same compaction twice. The envelope's
  `historical` flag is not compaction-specific — replayed `user`/`assistant` events carry it too.
- `memory_recall` ○ · `memory_saved` ○ — memory ops.
- `hook_started`/`hook_progress`/`hook_response`/`stop_hook_summary` ○ — hooks.
- `model_fallback` ○ · `model_refusal_fallback`/`model_refusal_no_fallback` ○ ·
  `model_consent_fallback` ○ — model routing.
- `commands_changed` ○ · `session_state_changed` ○ · `plugin_install` ○ ·
  `elicitation_complete` ○ · `local_command_output` ○ · `away_summary` ○ ·
  `file_snapshot`/`files_persisted` ○ · `scheduled_task_fire` ○ · `mirror_error` ○.

### `assistant` — a model message ✓
```json
{ "type": "assistant",
  "message": { "model": "claude-opus-5", "id": "msg_…", "role": "assistant",
    "content": [ {"type":"text","text":"…"} | {"type":"tool_use","id":"toolu_…","name":"Write","input":{…},"caller":{"type":"direct"}} | {"type":"thinking",…} ],
    "stop_reason": null, "usage": { … } } }
```
Iterate `message.content`: `text` blocks are prose; `tool_use` blocks (with `id`) are pending tool
calls; `thinking` blocks are reasoning.

### `user` (replay) — echo of a user turn / tool results ✓
```json
{ "type": "user", "isReplay": true, "origin": { "kind": "human" },
  "message": { "role": "user",
    "content": "…" | [ {"type":"tool_result","tool_use_id":"toolu_…","content":"…"} ] },
  "session_id": "…", "parent_tool_use_id": null, "uuid": "…", "timestamp": "…" }
```
`isReplay:true` messages are the worker echoing turns into the transcript (including our own sends
and tool results). Match `tool_result.tool_use_id` back to the `assistant` tool_use.

**Far more `user` payloads are the harness talking than are turns, and the flag that marks them
has moved.** In a 5006-event production history (claude 2.1.26x) `isMeta` and `isCompactSummary`
— the two flags this project filtered on — appeared on **zero** payloads, while `isSynthetic:true`
appeared on 23: the 8 `<local-command-caveat>` wrappers, and 15 post-compaction replays reading
`"This session is being continued from a previous conversation…"` at 15628–32809 characters each.
Every one of those 15 rendered as a user bubble. They need no rendering of their own: each lands
directly after its own `compact_boundary`, which already draws the break.

Three more `user` shapes carry no envelope flag at all and have to be recognised by content:

- `<command-name>/model</command-name>` + `<command-message>` + `<command-args>`, then a separate
  `<local-command-stdout>` with what the command printed. Hiding the WRAPPER is right; hiding the
  event is not — the terminal shows `> /model` and its output, and a remote viewer otherwise sees
  the model change with nothing on screen to say why. `/clear` is the exception: it also arrives
  as `conversation_reset`, whose divider is the beat (though one `/clear` in that history came
  with no reset at all, and was invisible).
- `[Request interrupted by user]` — a plain text block. Nobody typed it, so it is a notice, not a
  turn. It lands AFTER the `result` that already wound the turn down, so it must not settle tool
  cards of its own accord.
- `<task-notification>…</task-notification>` as the whole message text — the queued command claude
  injects when a background task ends. Its report body is in `<result>`, its counts in
  `<usage><tool_uses>/<duration_ms>`, and its status word is the `killed` spelling described above.

**`tool_result.content` is not always a string.** A `Read` of an image returns
`[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}]` — one
screenshot is 300–600 KB of base64. Stringifying that block puts megabytes of noise in a chat
bubble, so text and images have to be pulled apart (`src/image-blob.ts`).

**Every `tool_result` payload also carries `tool_use_result`** — Claude's own record of the call,
outside `message` and not part of this wire contract: `{interrupted, isImage, stdout, stderr}` for
Bash, `{filePath, oldString, newString, originalFile, structuredPatch}` for Edit, `{type, file:
{type, base64|content}}` for Read. Nothing in this project reads it, and it is **half the bytes**:
across a real 6298-event history it was 20.2 MB of 40.5 MB, including a second full copy of every
screenshot. The server strips the duplicated image on the way to a browser.

### `result` — end of a turn ✓
```json
{ "type": "result", "subtype": "success", "is_error": false, "stop_reason": "end_turn",
  "num_turns": 1, "duration_ms": …, "duration_api_ms": …, "total_cost_usd": …,
  "usage": {…}, "modelUsage": {…}, "permission_denials": [], "result": "…final text…" }
```
`subtype`: `success` | `error` (and specific errors like `tool_deferred*`). Signals the turn is
done; `result` is the final assistant text.

**The turn's final `assistant` text message can arrive AFTER the `result`** (observed live on
2.1.237: `assistant[thinking]` → `result` → `assistant[text]`, same `message.id`). A client that
re-arms its "turn in flight" state on any assistant message will show a busy indicator forever —
only a `user` turn or a `tool_use` block genuinely (re)starts a turn (web/src/model.ts,
src/server/store.ts foldDigest agree on this rule).

### `control_request` (child→host) — the worker asks us ✓
```json
{ "type": "control_request", "request_id": "…",
  "request": { "subtype": "can_use_tool", "tool_name": "Write", "display_name": "Write",
    "input": {…}, "description": "…", "tool_use_id": "toolu_…",
    "permission_suggestions": [ {"type":"setMode","mode":"acceptEdits","destination":"session"},
                                {"type":"addDirectories","directories":["/tmp"],"destination":"session"} ],
    "decision_reason": "Path is outside allowed working directories",
    "decision_reason_type": "workingDir" } }
```
`can_use_tool` is the permission ask — the web renders a prompt (tool_name + input + why), then we
reply with a `control_response`. Other child→host subtypes (○): `mcp_message`, `hook_callback`.

**`requires_user_interaction: true` forbids a one-tap Allow/Deny.** The control schema's own
words: *"True when one-tap Approve/Deny must not be offered: the tool's approval card IS the
user-interaction surface (Tool.requiresUserInteraction()) … the user has to open the session to
answer."* Two tools set it — `AskUserQuestion` and `ExitPlanMode` — and both need a dedicated
inline card rather than the generic permission sheet. A client that ignores the flag renders
exactly what it forbids.

## Plan mode

Verified end to end against claude 2.1.260 through a real `/rc` bridge (`test/e2e-plan-mode.sh`;
the payloads are in `test/fixtures/transcript-shapes.jsonl`). Note that a stream-json probe cannot
reach any of this: under `-p` the CLI answers `No such tool available: ExitPlanMode. ExitPlanMode
is disabled for this session`, so only an interactive claude behind the bridge emits it.

**`EnterPlanMode` never asks.** Its input schema is empty (`{}`), it is read-only, and it is
auto-approved — no `can_use_tool` is sent. On the wire it is a `tool_use` with `input:{}`, a
`tool_result` of ~200 words of instructions aimed at the model, and then the mode echo below. The
CLI itself renders neither (`renderToolUseMessage(){return null}`, empty `userFacingName()`), so a
tool card with an empty input is wrong on both counts.

**`ExitPlanMode` asks, and carries the whole plan.**
```json
{ "subtype": "can_use_tool", "tool_name": "ExitPlanMode", "display_name": "ExitPlanMode",
  "input": { "plan": "# …the entire plan, as markdown…", "planFilePath": "/home/…/.claude/plans/….md" },
  "tool_use_id": "toolu_…", "description": "", "requires_user_interaction": true }
```
`plan` and `planFilePath` are injected from the plan file by the CLI's own `normalizeToolInput`,
so they are present even though the declared input schema has neither. Two traps: `description` is
the **empty string** (there is no reason line to show), and `permission_suggestions` is **absent**
— so a client that builds its buttons only out of suggestions offers nothing but allow/deny.

The three answers, which differ on the wire and not just in wording:

| verdict | `control_response` | what the worker does |
|---|---|---|
| approve | `{behavior:"allow"}` | exits plan mode into `prePlanMode` (`default` unless plan was entered from another mode) |
| approve + auto-accept edits | `{behavior:"allow", permission_updates:[{type:"setMode",mode:"acceptEdits",destination:"session"}]}` | exits into `acceptEdits` — **verified accepted** even though the ask suggested nothing |
| keep planning | `{behavior:"deny", message:"…"}` | stays in plan mode; the message reaches the model verbatim as *"the user said: …"* and it revises |

An approved `tool_result` repeats **the entire plan back** (`## Approved Plan:\n…`), so a client
must not render that text under the card it already drew the plan on.

**A permission-mode change is announced by re-sending `system:init`.** There is no event of its
own — `permission_mode_changed` exists in the bundle but is OTel telemetry, not wire traffic. The
re-sent init carries the new `permissionMode`, and on a `/rc` session it carries **`cwd:""` and
`tools:[]`**, so a client that overwrites those fields unconditionally blanks out what it already
knew. Observed sequence for one plan cycle: `init(plan)` on entry → the ask → `init(default)` or
`init(acceptEdits)` on approval; a rejection emits no init at all, because the mode did not change.

### `control_cancel_request` ✓ — a request is withdrawn
```json
{ "type": "control_cancel_request", "request_id": "<the control_request's id>", "uuid": "…" }
```
The child is taking back a request we may still be showing — in practice the same permission being
answered in the terminal. It carries **only** `request_id`, so a client has to match on that: the
sheet must close (and the list badge clear), or the phone keeps offering an answer the worker
would reject.

### `conversation_reset` ✓ — /clear or a compaction
```json
{ "type": "conversation_reset", "new_conversation_id": "…", "session_id": "…", "uuid": "…" }
```
The same session continues under a new conversation. The turns above it are history, not context:
render a break, drop the task list, and treat the turn as over.

### `rate_limit_event` ✓ — quota telemetry, not a refusal
```json
{ "type": "rate_limit_event", "session_id": "cse_…", "uuid": "…",
  "rate_limit_info": { "status": "allowed", "rateLimitType": "five_hour",
    "resetsAt": 1787334600, "isUsingOverage": false,
    "overageStatus": "rejected", "overageDisabledReason": "org_level_disabled" } }
```
Not in `sdk-control-protocol-schemas.js` at all — it turned up on the wire first (2 events in a
13846-event census, both `status:"allowed"`). **`resetsAt` is in SECONDS**, not milliseconds, so it
needs ×1000 before it is a JS `Date`. `status:"allowed"` means the request went through: rendering
a limit warning on it is a false alarm, so the benign case should say nothing. Any other status is
worth surfacing — a limit that stalls the session is exactly what a user needs told — but no other
value has been observed, so treat the enum as open.

### `keep_alive` ○ — idle heartbeat from the worker; ignore.

---

## Tool-call lifecycle (the sequence the web threads together)

```
1. assistant   → content[].tool_use  { id: toolu_X, name, input }        (model wants a tool)
2. control_request { subtype:can_use_tool, tool_use_id: toolu_X, … }      (worker asks permission)
3. [web/us]    control_response { request_id, response:{behavior:allow} } (we answer)
4. user(replay)→ content[].tool_result { tool_use_id: toolu_X, content }  (tool ran)
5. assistant   → text …                                                   (model continues)
6. result      { subtype:success, … }                                     (turn done)
```
An auto-approved tool (safe, in-workdir) skips steps 2–3. A `deny` short-circuits to a
`tool_result` error and often a `system:permission_denied`.

## Web rendering guide

- **Transcript**: `assistant` text/thinking, `tool_use` (as a tool card), `user` `tool_result`
  (tool output), `result` (final text + cost).
- **Permission UI**: `control_request:can_use_tool` → modal with `tool_name`, `input`, the reason,
  and `permission_suggestions` as one-tap options; reply `control_response`. The reason arrives in
  **`description`** — `decision_reason` is the control-schema's name for it and was never seen on
  the wire, so reading only that leaves the modal with no explanation. Handle
  `control_cancel_request` too, or the modal outlives the request. An ask carrying
  `requires_user_interaction` is the exception and must NOT get this modal: `AskUserQuestion` is a
  question card and `ExitPlanMode` is a plan card, both inline (see **Plan mode** above).
- **Permission mode**: seeded from `system:init` and updated by the same payload being re-sent —
  guard every field against the empty `cwd`/`tools` a re-sent init carries.
- **Status chips**: `system:post_turn_summary`, `system:task_*`, `system:thinking_tokens`,
  `system:api_error`/`permission_denied`.
- **Session bootstrap**: `system:init` → tool list, model, permission mode.
- **Ignore**: `keep_alive` and our own `control_response` echoed back — declared noise, dropped for
  free. An unrecognised `system:*` must NOT break the transcript, but "forward-compatible no-op" is
  the wrong reflex: a shape nobody has decided about is indistinguishable from one deliberately
  dropped, which is how shapes go missing for months. `src/wire-shape.ts` makes the decision
  explicit (handled / ignored-with-a-reason / unknown) and `npm run shape-report` reads the backlog
  straight out of `events.shape` — one aggregate query, no conversation content. `test/history-audit.ts`
  answers the same question but needs a full history export first (docs/HISTORY-EXPORT.md).
- **Controls the web can send**: `user` (with `client_platform`), `control_response`,
  and host `control_request` (`interrupt`, `set_permission_mode`, `set_model`).
