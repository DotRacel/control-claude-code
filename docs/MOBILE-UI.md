# Mobile UI

Below 900px. The two-pane desktop layout above it, and what the two share, is docs/DESKTOP-UI.md.

The phone UI is built to the Anthropic Remote Control design spec: warm-dark surface (`#262624`),
Source Serif 4 for assistant prose, JetBrains Mono for commands and output, 4pt grid, tool cards
that merge into bordered groups, a permission sheet whose drag-dismiss is a *deny*, and an output
sheet instead of inline dumps. Fonts are self-hosted (`web/public/fonts`, latin + latin-ext, both
variable ⇒ 4 files / 140 KB) and precached by the service worker.

**The transcript is a pure reducer.** `web/src/model.ts` folds data-plane payloads into render
items (`user · prose · thinking · tools · todo · question · bgtask · status · divider · error ·
unknown`) plus a `live` block (busy, running tool, thinking tokens, model, permission mode, slash
commands). The same function eats the history backfill and the live stream, so a reopened session
renders identically — and it is testable without a browser (`test/model.test.ts`,
`npm run render-history` replays a real session out of PostgreSQL).

**Two guardrails hold that pipeline to its own contract**, because both ends of it used to leak in
silence and neither leak was visible from inside the app:

- *Nothing arrives without a decision.* `reduce` looks up `verdictOf(shapeOf(payload))`
  (`src/wire-shape.ts`) **before** dispatching. Declared noise (a heartbeat, the receipt for a
  request we sent) returns the very same state object — identity matters, because `ChatView`
  reduces with `setState((prev) => reduce(prev, payload))` and a fresh object per keep_alive
  re-renders the whole transcript. Anything undecided is counted in `state.unhandled` and drawn as
  the faintest thing on the screen: `⋯ 未适配消息 · system:foo`, mono, with the shape key spelled
  out so a screenshot is a bug report. It used to be dropped by `system()`'s own `default` arm, one
  level below where anything was watching — and `system` subtypes are exactly where new wire shapes
  appear.
- *Nothing renders by accident.* `web/src/render/contract.ts` declares
  `ItemRenderers = { [K in Item['kind']]: … }`, so a kind with no renderer is a compile error in
  `render/phone.tsx` rather than a blank space. `divider` shipped as that blank space — reducer,
  CSS and all — because `ItemView` was a `switch`, and a missing `case` falls through to
  `undefined`, which is a perfectly legal ReactNode. A desktop layout is a second object of the
  same type; adding a kind then fails to compile in both files until each decides how to draw it.

Four things the design doc could not have known, found by reading real captured traffic:

- **`thinking` blocks arrive with `thinking: ""`** — the data plane relays the signature only,
  never the reasoning text (verified across every block of a real session). So a thinking block is
  a marker ("思考 · N tokens", token count from `system:thinking_tokens`), not a collapsible
  transcript. It expands only if a future version starts sending text.
- **`AskUserQuestion` is not a tool card.** It always arrives as `control_request:can_use_tool`
  (its `checkPermissions` returns `ask` unconditionally), and is answered with
  `{behavior:'allow', updatedInput:{questions, answers}}` — answers keyed by question text,
  multi-select comma-joined. It renders as an inline question card with options, descriptions,
  previews, a free-text box and Skip. `npm run e2e-question` proves the round trip on a real
  wire: the phone's answer reaches the tool, the tool_result echoes it, the model acts on it.
- **`Update Todos` does not exist in 2.1.232** — the todo card is built from `TaskCreate` /
  `TaskUpdate`, and falls back to a plain tool row when the input cannot be parsed.
- **The `/rc` bridge does not relay `stream_event`.** The CCR client uploads partial messages as
  ephemeral events, but a completed interactive turn delivered `user → assistant → result` and
  nothing else. So prose appears per message, not per token; the reducer handles both (the
  streamed draft is replaced in place, never appended twice) and the busy state is carried by the
  activity spinner instead of a caret.

**Six more, found by exporting a real deployment's history** (6298 events, 3 sessions) and
replaying it through the reducer — `npm run export-history && npm run history-audit`, which reports
every payload shape the front-end turns into nothing (docs/HISTORY-EXPORT.md). Seven shapes were
being dropped silently:

- **A `tool_result` is not always text.** A `Read` of a screenshot returns an image block, and
  stringifying it put **14.7 MB of base64 across 39 images** into chat bubbles. Text and images are
  separated now (`src/image-blob.ts`); the bytes stay on the server behind a `<uuid>:<n>` reference
  and the card fetches one from `/v1/blob` when tapped. Stripping happens on the way out, so
  history already in the database benefits without a migration.
- **Half the wire is `tool_use_result`** — Claude's own record of each call, which nothing here
  reads: 20.2 MB of 40.5 MB, including a *second* full copy of every screenshot. Stripping both
  copies took the same history from 40.5 MB to 11.1 MB (−72.5%).
- **A long background task reports only through `system:task_progress`**, and `system:task_updated`
  can be the only event that says it finished. Handling neither left task cards spinning forever;
  the card now shows the current step, the workflow phases, and its elapsed time.
- **`control_cancel_request` withdraws a permission request** — usually because it was answered in
  the terminal. Ignoring it left the phone holding a sheet whose answer the worker would reject,
  and the session list with an approval badge nobody could clear.
- **`conversation_reset` (a `/clear`) and `system:worker_shutting_down` end a turn** as firmly as a
  `result` does. Both now draw a break in the transcript, and both are turn boundaries for
  `turnActiveIn` and the server's digest — otherwise reopening the session shows a Stop button for
  a turn nobody will ever finish.
- **The permission sheet's reason is `description`, not `decision_reason`.** The schema name was
  never on the wire, so the "why are you being asked" line was always empty.

`permission_response` over `/ws/client` now carries the worker's own contract —
`{behavior, updatedInput?, updatedPermissions?, message?}` — which is what makes "Always allow"
work: the phone echoes back a `permission_suggestions` entry rather than inventing a rule (it
cannot reach the machine's `settings.json`). The browser is untrusted, so `web-channel.ts` filters
to those four keys and drops permission updates with an unknown `type` — one malformed entry would
make the worker silently discard the whole array and turn an "always" into a "once".

The session list is backed by a server-derived digest (`store.foldDigest`: last prompt, running
tool, tool count, needs-approval, model), persisted in a `digest jsonb` column that rides the same
batched UPDATE as `last_activity`. An in-flight approval is deliberately not restored on boot — the
request died with the process, so the badge must not come back stuck on.

A row can be **deleted** — trash button, offline rows only — which drops the session and its whole
transcript (`events` is ON DELETE CASCADE, so it is one statement and nothing can be orphaned). The
offline rule is not a UI preference: deleting a live session voids the ingress token its child is
holding, and that child would spend the rest of its life reconnecting into a 401. `store.deleteSession`
enforces it as well, because a row can go online between being drawn and being clicked. The same
deletion runs on a timer — `CCC_SESSION_TTL_DAYS` (default 7), swept at boot and hourly — which is
why the list does not grow without bound whether or not anyone presses the button.

Deliberately not built, because the architecture has no channel for it: starting a session from the
phone (only your terminal can launch `control-claude`), reading/writing the machine's
permission allowlist, the `@`-file picker, "open in editor", voice, and image upload. Web Push
lock-screen approval is deferred — notifications today are local and need the page alive.

Also deliberately **removed**, rather than shipped disabled: search (a dead grey button promised a
feature), archive (both the chip and the ⋯ row — it needed a column the `sessions` table does not
have, and a filter that can only ever be empty is not a filter), and the Markdown transcript
export. What used to be the home screen's dashed "要开一个新会话？" card is now the **?** button
next to it — a sheet with the three commands (`npm i -g control-claude-code` →
`control-claude` → `/rc`), each copyable, because that answer is instructions, not a hint.
The logout control is a door-with-arrow icon (a gear promised settings this screen does not have)
and asks twice before it forgets the key.

Verified by: `npm test` (113 tests, ~5s — reducer invariants against real captured shapes in
`test/fixtures/transcript-shapes.jsonl`, permission pass-through and digest derivation over a real
socket, digest persistence across a restart, the shape column written and backfilled against a
real PostgreSQL), `npm run e2e-interactive`, `npm run e2e-question`, and
`cd web && npm run build` (typechecks first).

The renderer-completeness guardrail is checked by breaking it on purpose: add a throwaway kind to
`Item` and `cd web && tsc` must fail with `TS2741` at `render/phone.tsx`. Before that type existed
the same edit compiled clean, `npm test` stayed green, and the item simply did not draw.

### Reviewing the phone UI without a phone

```bash
npm run ui-preview                       # :8791 — the real SPA against fake-but-real-shaped sessions
npm run ui-shot                          # both device profiles → artifacts/ui/<device>/*.png + numbers
npm run ui-shot -- --device pro-max-pwa  # just the installed-web-app profile
```

Two profiles, because the bugs differ: `phone` is a 390×844 browser tab, and `pro-max-pwa` is the
installed web app on an iPhone 15 Pro Max — 430×932 **with real safe-area insets** (59pt of Dynamic
Island, 34pt of home indicator, via `Emulation.setSafeAreaInsetsOverride`) and genuinely
`display-mode: standalone`. That last part needs chromium launched with `--app=<url>`:
`Emulation.setEmulatedMedia` accepts a `display-mode` feature and then silently ignores it
(measured — the page still reports `browser`), so a standalone run gets its own browser process.

`test/ui-preview.ts` replays `test/fixtures/transcript-shapes.jsonl` **through the actual
data-plane** (`POST …/worker/events`) into three seeded sessions — one live transcript, one waiting
on approval, one offline — so what the browser renders came out of the same reducer path as a real
session, with no claude, no inference and no database. `test/ui-shot.ts` drives chromium over CDP
(no puppeteer), sets a *real* mobile viewport with `Emulation.setDeviceMetricsOverride`
(`mobile: true`, DPR 3 — a bare `--window-size` leaves `mobile:false`, so `dvh`, safe-area insets
and touch queries behave like a desktop), and captures nine states: list, transcript top/bottom,
composing, permission sheet, question card, output sheet, menu, credential gate.

It prints numbers as well as pixels — every box's geometry, each transcript item's height,
`scrollTop/scrollMax`, and any element painting outside the viewport (ignoring code blocks, the one
place horizontal scroll is allowed). That is what found the three real bugs, none of which any unit
test could see:

- **The app shell was not one viewport tall.** `.phone-frame` inherited only `min-height: 100%`
  from `.desktop-stage` on the mobile branch, and a percentage height resolves to `auto` against an
  auto-height parent — so the frame grew with the transcript (2732px on an 844px screen), the page
  itself became the scroller and the composer scrolled off the bottom of the phone.
- **Every clipped card collapsed to a 2px sliver** once that was fixed. A column flex item's
  automatic minimum size is its content — *except* with `overflow: hidden`, where it is 0. Tool
  groups and question cards round their corners, so the moment the transcript overflowed they were
  shrunk to their borders. `.chat > *, .session-list > * { flex: none }`. (The two bugs masked each
  other: with no definite height nothing overflowed, so nothing shrank.)
- **Long unbroken tokens escaped the tool card** — a DSN or URL in a command ran past the right
  edge and was clipped, because `.tool-head` only broke at spaces.

Two smaller fixes came out of the same pass: the transcript now re-pins when the *composer* grows
(a `ResizeObserver`, since no new item arrives — typing a three-line message used to hide the
message you were writing about), and the code-block copy button moved out of the code into its own
row (floating at the top-right, it covered whatever sat at the right edge of the first line
whenever the block scrolled sideways).

Note when reading screenshots on a fresh box: with no CJK font installed every Chinese glyph
renders as tofu. `fc-list :lang=zh` first.

### Installed on iOS: safe areas, viewport units, and the scroll-off tap

Three more things only the real installed app showed (reported on an iPhone 15 Pro Max, iOS 26):

- **Safe areas now use `max(inset, gap)`, never `inset + gap`.** Adding a gap on top of an inset
  stacks padding on space the Dynamic Island already took; and when iOS installs via the manifest
  instead of the `apple-*` meta tags the inset is `0`, where `max()` still leaves the plain gap.
  Same at the bottom, which is where the wasted space was most visible (44px → 34px).
- **The height chain is `%`, with `dvh` only in a browser tab.** iOS 26.0 mis-measures `dvh` for
  viewport-sized containers, leaving a dead scrollable band at the bottom of a standalone PWA
  (Apple fixed it in Safari 26.1). An installed app has no collapsing chrome, so `%` is both
  correct and immune; `@media (display-mode: browser)` keeps `dvh` where the URL bar does move.
  `html, body { overflow: hidden }` backs this up — if the document can never scroll, the browser
  stops collapsing its chrome at all.
- **A tool card no longer opens when you scroll off it.** `ToolRow` rolls its own
  touchstart/touchend (it shares the code path with the long-press), and iOS does *not* reliably
  send `touchcancel` when a drag inside a scroll container becomes a scroll — the same touch just
  ends normally, which read as a tap. It now cancels past 10px of travel, which also kills the
  pending long-press so a slow scroll cannot fire it either.

Two follow-ups came out of measuring the installed app instead of reasoning about it, and both
reversed an earlier decision:

- **The shell is `position: fixed` and sized in `lvh` when installed.** This one took four wrong
  answers, so the measurement is worth stating in full. From the device (the app reports it on
  every socket connect — see below):

  ```
  mode=standalone  screen=430x932  win=430x873  insets=59/34
  vh/dvh/svh/lvh = 932 / 873 / 873 / 932        icb=873
  ```

  The screen is 932 and the insets are correct, but `innerHeight` says 873 — and `dvh`/`svh` agree
  with it while `vh`/`lvh` do not. iOS 26 computes the *dynamic* and *small* viewports as if
  Safari's toolbar were still present although it is hidden, so both of the units one would reach
  for first are short by ~59pt. The initial containing block is short too (`%` → 873), which is why
  `%` failed as well: every obvious choice was wrong, and switching between them just moved the
  same band around. The web view really is 932 tall — an early screenshot showed the canvas
  background reaching y=931.7 with the shell stopping at 873, which is precisely the exposed strip
  that got reported as "space left for Safari's address bar".

  So: `#root` is `position: fixed` (laid out against the viewport, not the shortened ICB) with
  `height: 100lvh` under `@media (display-mode: standalone)`. `lvh` is the viewport with
  retractable UI retracted, and an installed app has no chrome to retract, so there it is simply
  the true height. The media query is not decoration — in a browser tab `lvh` is the
  URL-bar-collapsed height, taller than the visible area, and would push the composer off-screen;
  a tab keeps `dvh`, which is correct there. Chromium reproduces none of this even with
  `Emulation.setSafeAreaInsetsOverride`, so only a device catches a regression here.
- **The composer bar reaches the screen edge**; the pill clears ~12px, not the full 34pt inset.
  That inset is clearance for the home indicator's *gesture* area, not a margin a bottom bar must
  float above; sitting 34pt up left a band of bare page background that read as a hole. The sheets
  keep the full inset, since their buttons are the primary action.
- **The activity indicator sits above the composer and is the glyph alone.** It used to be the last
  line *inside* the scroller, printing the open tool, a token count or a ticking duration. Two
  problems: it scrolled away exactly when you wanted to know whether the agent was still working,
  and the shifting text reflowed a bar sitting inches from where you type. Now it is a `flex: none`
  row between the transcript and the field, matching `.composer-wrap`'s horizontal padding so the
  star lines up with the field's left edge — and the sentence it used to print goes to `.sr-only`,
  where there is no bar to reflow. Nothing about the glyph is up for revisiting: it is the CLI's
  star, never a dot, and the line carries no visible text.
- **The user's turn hugs the right edge.** It is the only item that does not fill the column, so a
  glance down the transcript separates what you asked from what came back. The alignment lives on a
  wrapper row (`.bubble-row`, `justify-content: flex-end`) with the bubble capped at 85% inside it,
  never on the bubble itself — the desktop centres every `.chat > *` in one measure, and a bubble
  that pinned itself right would leave that column (docs/DESKTOP-UI.md, and `ui-shot --device
  desktop` fails the run if it does).

**The slash picker is keyboard-navigable now**, which it looks like it always was: it painted the
first row as selected while nothing could actually select it, so pressing return sent `/rc` as raw
text instead of completing it. `↑`/`↓` move the highlight, `Tab`/`↵` take it, `Esc` sheds the picker
before it gives up the field. Return still does not *send* on touch — that is the button's job — but
it does complete, because a newline in the middle of a command name is no use to anyone.

**The header floats and frosts.** `.header` (top bar + connection banner) is absolutely positioned
over the transcript, which now starts at `y=0` and scrolls *under* it — so the 59pt behind the
status bar and Dynamic Island is used rather than reserved, and content passing up there is blurred
instead of colliding with the clock. This is
[muffinman.io/blog/pwa-ios-status-bar-blur](https://muffinman.io/blog/pwa-ios-status-bar-blur)
adapted rather than copied: that demo has no `viewport-fit=cover`, so its layout origin sits *below*
the status bar and it can hide a blur strip at negative `y`; under `cover` `y=0` is the physical top
(measured: ICB offset 0), so the strip simply lives at the top edge. Three details are load-bearing:
the blurring `::before` needs `z-index: -1` (an absolutely positioned box paints in a later step
than its in-flow siblings, so without it the frost covers the header's own title), it needs
`pointer-events: none` (its fade tail hangs over the transcript), and the tail is a fixed 22px that
the transcript's top padding clears — a percentage tail dimmed the first card at rest. `--header-h`
is measured with a `ResizeObserver` in `ChatView`, because the banner changes the height at runtime.

What is still **not** fixable from CSS: iOS 26 paints a Liquid Glass "scroll edge effect" behind the
status bar, and there is no web-facing opt-out (`theme-color` is ignored in Safari 26; the native
`scrollEdgeEffectStyle` is not exposed). All a page can do is control what gets sampled — which the
frosted header now does deliberately.

**An installed web app could never update itself**, which is why several rounds of the above
appeared to change nothing on the phone while being correct in a browser. The update check only
runs on *navigation*, and iOS resumes a standalone app rather than navigating, so it kept whatever
bundle it first installed — and standalone mode does not share Cache Storage with Safari, hence
"fine in Safari, unchanged in the app". `main.tsx` registers with `updateViaCache: 'none'`, calls
`registration.update()` on every foreground and hourly, and reloads once on `controllerchange`.
This is the one piece of that episode worth keeping: without it no later fix can reach a phone.

The measurements above came from temporary instrumentation (a `/diag.html` page, a build/shell
readout in the session menu, a `hello` frame reporting the box chain on connect). It is all
removed — the findings live in the CSS comments, which is where they are useful.

`web/public/diag.html` (served at `/diag.html`, deliberately excluded from the service worker
cache) is the device-side counterpart: open it from the home-screen icon and it reports
`display-mode`, `innerHeight` vs `100vh` vs `100dvh` vs `100%`, all four insets and the UA, plus
three coloured bars down the left edge so a lying viewport unit is visible without reading a
number.

### Icons: the official Claude symbol

`web/public/icons/claude-symbol.svg` is Anthropic's own symbol (via Wikimedia Commons,
CC0 1.0, sourced from anthropic.com), and it is the single source of truth for the mark —
`web/scripts/gen-icons.mjs` (`cd web && npm run icons`) parses the `<path>` out of it and renders
the PWA PNGs with chromium, rather than a hand-rolled rasteriser. Proportions are measured, not
invented: `claude.ai/apple-touch-icon.png` is a #d97757 ground with a #fefcfb mark spanning
**74.4%** of the square, so that is what 192 / 512 / 180 / 32 use; the maskable 512 drops to 56% to
survive Android's circular crop. The same path is a `ClaudeMark` component (`web/src/icons.tsx`)
used for the launch screen's app icon and the question card, replacing a `✳` glyph on a coral
rounded square. The service worker cache is bumped (`ccc-web-v4`) so installed copies do not keep
serving the old ones. It is Anthropic's trademark, used here because this app is a client for
their product.

