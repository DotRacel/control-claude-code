# Desktop UI

Above 900px the app is a two-pane client: the session list is a permanent rail and one transcript
sits beside it. Below that it is the phone UI, unchanged (docs/MOBILE-UI.md).

What used to be here was a 390×844 phone frame centred on a dark ground with the words 手机专用
beside it — not a desktop layout, a request to go and find a phone.

## What the two platforms share, and what each decides

The split is deliberate and enforced by types rather than by discipline, because the failure mode is
silent: a layout that never learned to draw something looks exactly like a session with nothing to
say.

| Shared | Where | Why it cannot fork |
|---|---|---|
| Event → transcript | `web/src/model.ts` | One reducer eats both the history backfill and the live stream; a second copy would drift on the shapes nobody looks at |
| How a session *works* | `web/src/session.ts` (`useSession`, `useTranscriptScroll`) | Subscribing, backfilling, re-deriving `busy` from replayed events, sending, stopping, answering, staying pinned to the bottom. A laptop that quietly stopped re-subscribing after a reconnect looks like a quiet session |
| A tool card's body, the activity spinner, the connection banner | `web/src/render/parts.tsx` | Same words either way; only *what opens a row* differs |
| The five modal surfaces' contents | `web/src/render/surface-parts.tsx` | Same permission buttons, same install instructions; only the container differs |

| Per-platform | Where |
|---|---|
| One renderer per item kind | `render/phone.tsx`, `render/desktop.tsx` — checked for completeness by `ItemRenderers` |
| The five surfaces' containers | same files — checked by `LiveSurfaces` |
| Layout shell | `components/ChatView.tsx` vs `components/desktop/` |

**The desktop object does not spread the phone's.** `{...phoneRenderers, tools: X}` would supply
every key, so adding an `Item` kind would compile clean again and the second platform would be back
to failing invisibly. `inherit(phoneRenderers, [...])` returns `Pick<ItemRenderers, K>` from an
explicit list instead, so the literal is still settled key by key — and the list states something a
spread cannot: which kinds someone looked at and judged identical on both.

To check the mechanism, break it: add a throwaway kind to `Item` and `cd web && tsc` must fail at
**both** `render/phone.tsx` and `render/desktop.tsx`; add an entry to `LiveSurfaces` and both
surface objects must fail.

## Where the desktop genuinely differs

- **Pointer, not touch.** The phone's tool row hand-rolls touchstart/long-press/scroll-slop because
  iOS does not reliably cancel a touch that became a scroll. With a mouse none of that exists and
  all of it is in the way: `DesktopToolRow` is a plain button with a hover state.
- **Modals and a popover, not sheets.** Four centred dialogs (permission, output, help, confirm) and
  one popover anchored to the header's ⋯. `Modal` carries over `Sheet`'s one hard rule verbatim —
  **every route out is `onDismiss`, and for a permission that answers DENY**. Backdrop click and
  Escape both go there. A dialog that merely unmounted would look fine and leave the worker blocked
  on an answer that is never coming. It also traps Tab, since a keyboard that wanders behind the
  backdrop can reach Send for a turn still awaiting approval.
- **The header is in flow.** No status bar to share a strip with and nothing to blur behind, so
  there is no floating frosted layer and no `--header-h` measurement.
- **The transcript is capped and centred.** A 1440px line of serif prose is not prose anyone
  reads. The cap is CSS on the items, *not* a wrapper element — `.dchat-scroll > *` is what both the
  stylesheet's flex rules and `test/ui-shot.ts`'s geometry probe key on, and a wrapper silently
  emptied the probe. Two details the first cut got wrong: the cap is a **fixed length (45rem), not
  `ch`** — `ch` resolves against each item's *own* font, so serif prose (17.5px) and a sans tool
  card (16px) capped at "78ch" came out ~30px apart and their left edges did not line up; one fixed
  measure keeps the whole column on one edge. And the user bubble right-aligns through a **row**
  (`.bubble-row`), never through `align-self` on the bubble itself: the row is the column item, so
  it centres and caps like every other item, and the bubble is a flex child pushed to the row's
  right edge and capped at 85% of it. A bubble that pinned *itself* right would leave the shared
  column entirely and sit off-centre from the prose beside it — the same class of failure a
  leftover `align-self: stretch` once caused on the left.

`useWide()` (App.tsx) listens to the media query rather than sampling it once: the breakpoint has to
be crossable by dragging a window, and `ui-shot` proves both forms by resizing one browser. The
socket, the session list and the open session all stay in `App.tsx` above the split, so crossing it
keeps the session you were reading.

## Keyboard

Every shell binding takes a modifier, and that is the design rather than a shortcut list that
happens to look like this. The composer is a `textarea` and it is where the caret almost always is,
so a bare letter would either be swallowed by it or have to fight what someone is typing. With a
modifier the bindings work from anywhere — mid-sentence included — which means there is no mode to
enter, nothing to blur first, and no mode indicator that could drift out of sync with reality.

| Key | |
|---|---|
| `⌘K` / `Ctrl+K` | session switcher (subsequence match over name, directory, branch) |
| `⌘↑` / `⌘↓` | previous / next session |
| `⌘↵` | send even with the slash picker open |
| `Esc` | close a surface → close the slash picker → leave the composer |

`Ctrl+K` is Firefox's web-search shortcut and `⌘K` belongs to the omnibox; both yield to a page that
calls `preventDefault`. `⌘↑`/`⌘↓` do take over "caret to start/end of field" inside the composer —
a deliberate trade, since switching sessions is the more common intent in a chat client.

**Esc is a cascade, not one meaning.** It sheds the innermost thing first and only leaves the
composer when there is nothing left to shed. `Modal` listens in the capture phase and stops the
event, so a dialog always wins.

**`⌘↑`/`⌘↓` walk the FILTERED list, in the rail's order.** This is why the 活跃/全部 filter lives in
`DesktopShell` and not in `Sidebar`: stepping into a session the rail is hiding would leave nothing
highlighted and no clue where you had gone. The ⌘K switcher deliberately searches *everything* —
typing a name is an explicit request for that session, and not finding it because a chip is set
would be worse.

**The switcher is not a `LiveSurface`.** That contract exists so a surface driven by shared state
cannot go missing on one platform; this one is driven by a key combination, and a phone has no way
to trigger it. Forcing a phone implementation would mean writing something that can never open.

The slash picker's keys (`↑`/`↓`/`Tab`/`↵`) are in `Composer.tsx` and therefore apply on both
platforms — it was painting the first row as selected while nothing could select it, so `↵` sent the
raw text instead of completing. On a phone `↵` now completes the command too; it still does not
*send* there (that is the button's job), but a newline in the middle of `/rc` was no use to anyone.

## Layout bugs, found by measuring

All of these are the same family of mistake the phone shell hit, one layout system over — and none
of them is visible to a unit test (`tsc` and `vite build` compile a broken cascade cleanly):

- **The composer was off the bottom of the window.** A grid item's automatic minimum size is its
  content, so `.dmain` grew past its row instead of letting the transcript scroll. `min-height: 0`
  is needed on *both* the grid item and the flex child inside it.
- **The transcript reported `scrollMax 0`** — the same cause, seen from the other side.
- **A 136px hole above the first message.** `.chat`'s top padding is clearance for the phone's
  *floating* header; this header is in flow, so that space was a gap. Restated inside the desktop
  block rather than left to specificity: both selectors are one class deep and `.chat` comes later
  in the file, so it would otherwise win.
- **The user bubble was pinned left, and items were different widths.** `align-self: stretch`
  survived from the phone into the centred desktop column, so the bubble sat at the left edge while
  the prose and tool cards beside it were centred; and a `78ch` cap resolved per-font, so serif and
  sans items came out ~30px apart. Unlike the three above — each caught once by reading the geometry
  dump by eye — this one shipped, because nothing *asserted* the column. So `ui-shot --device
  desktop` now measures every `.chat > *` and **fails the run** if the items are not one width on
  one centred edge (with the composer on it and no horizontal overflow). The whole family now has a
  gate, not just a dump to squint at.

## Reviewing it without a desktop

```bash
npm run ui-preview                      # :8791 — drag the window across 900px
npm run ui-shot -- --device desktop     # 1440×900 → screenshots + geometry, and ASSERTS the column
npm run ui-check                        # the same desktop assertions, as a bare pass/fail gate
```

`ui-shot --device desktop` exits non-zero if the desktop layout assertions fail, so it is a real
gate rather than a dump — CI (`.github/workflows/ci.yml`, the `web` job) runs it on every push and
PR, after `vite build`, against a headless Chrome. `launchChromium` already passes `--no-sandbox`,
so it runs on a CI runner as-is; set `CHROMIUM_BIN` if your chrome is not on `PATH` as `chromium`.

The `desktop` profile is `mobile: false`, which skips touch emulation and the iPhone UA: with those
on, every hover rule and the whole pointer path would be tested in a browser pretending not to have
a mouse. The shot scripts are the phone's — the sidebar reuses `.session-card` and the scroller
keeps `.chat`, so the same selectors work — with two changes: the tool-row opener now fires a real
`click` as well as the mousedown/mouseup pair the phone needs, and a shot can carry
`only: ['desktop']` so the ⌘K switcher does not re-shoot the chat on a device that cannot open it.

**On comparing screenshots.** Several shots are not deterministic: the session list renders a live
elapsed counter and the activity spinner is mid-animation (its star frame advances every 120ms), so
`01`, `01b`, `01c`, `03`, `04`, `05` and `10` differ between two runs of identical code (`01b` and
`01c` show the list too, behind the 全部 filter and behind the delete dialog). Compare the other ten, and when one of those differs, check the *magnitude* before
believing it — dropping two wrapper divs shifted one band of the phone's composer by 2/255, which is
compositing noise, not movement. Item heights are the reliable signal, and `ui-shot` prints them.
