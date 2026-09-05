/**
 * transcript-text.ts — extracting the *visible* text of a `user` payload.
 *
 * The worker echoes far more `user` messages than a person ever typed: local-command caveats,
 * `<command-name>` wrappers, synthetic replays, compact summaries. Real captured history
 * contains all of these (see test/fixtures). Both the transcript and the session-list digest
 * must hide exactly the same set, so the filter lives here and is shared by
 * web/src/transcript.ts and src/server/store.ts.
 */

/**
 * Wrapper tags the official clients never render. `task-notification` is the queued command claude
 * injects when a background task finishes: it reaches us as a plain `user` message whose text is
 * the raw `<task-notification>…` XML. The official client never shows it as a turn (the web model
 * turns it into a card update instead — see taskNotification() in web/src/model.ts); dropping it
 * here keeps it out of both the transcript bubbles and the session-list preview digest.
 */
const SYNTHETIC_TAG = /^\s*<(local-command-caveat|command-name|command-message|command-args|command-contents|local-command-stdout|command-stdout|bash-stdout|bash-stderr|bash-input|task-notification)\b/;

/**
 * The harness's own interrupt marker. It arrives as an ordinary `user` text block with no flag on
 * the envelope, so it used to render as a right-aligned bubble — a sentence attributed to someone
 * who pressed Escape and typed nothing. It is a beat worth showing, but as a notice, not a turn:
 * see interruptNoticeIn() and the `status.interrupted` line the reducer draws instead.
 */
const INTERRUPT_NOTICE = /^\s*\[Request interrupted by user[^\]]*\]\s*$/;

/** Strip synthetic user-message content official clients hide. null = render nothing. */
export function cleanUserText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (SYNTHETIC_TAG.test(raw) || INTERRUPT_NOTICE.test(raw)) return null;
  const s = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return s || null;
}

/** Did this payload carry the interrupt marker? The reducer turns it into a status line. */
export function interruptNoticeIn(payload: any): boolean {
  const content = payload?.message?.content;
  if (typeof content === 'string') return INTERRUPT_NOTICE.test(content);
  if (!Array.isArray(content)) return false;
  return content.some((b: any) => b?.type === 'text' && typeof b.text === 'string' && INTERRUPT_NOTICE.test(b.text));
}

/**
 * Every renderable text a `user` payload carries (empty for the ones no client shows as a turn).
 *
 * `isSynthetic` is the flag that actually matters, and it was the one not being read. In a 5006-event
 * production history `isMeta` and `isCompactSummary` appeared on ZERO payloads while `isSynthetic`
 * appeared on 23 — 15 of them the post-compaction "This session is being continued from a previous
 * conversation…" replay, up to 32809 characters each, every one rendered as a user bubble. The
 * break they belong to is already on screen: each lands directly after its own
 * `system:compact_boundary`, which draws the divider.
 */
export function userTextsFrom(payload: any): string[] {
  if (!payload || payload.isMeta || payload.isCompactSummary || payload.isSynthetic) return [];
  const content = payload.message?.content;
  const out: string[] = [];
  if (typeof content === 'string') {
    const t = cleanUserText(content);
    if (t) out.push(t);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text') {
        const t = cleanUserText(b.text);
        if (t) out.push(t);
      }
    }
  }
  return out;
}

/** A slash command the owner ran in the terminal, as the transcript should show it. */
export interface SlashCommand {
  /** Always `/`-prefixed, e.g. `/model`. */
  name: string;
  /** What followed it, when anything did. */
  args?: string;
}

/**
 * The `<command-name>` echo, parsed rather than dropped.
 *
 * Running `/model claude-fable-5-1` in the terminal puts three of these on the wire — the caveat,
 * the command itself, then a `<local-command-stdout>` with the confirmation — and cleanUserText
 * hides all three, on the grounds that the official clients never render the WRAPPER. But the
 * terminal does render the command: you see `> /model` and the line it printed. Hiding the wrapper
 * was read as hiding the event, so a remote viewer watching the same session saw the model change
 * under them with nothing on screen to say why.
 *
 * Returns null for anything that is not a command echo, so callers can chain it before their
 * ordinary text handling. `<command-message>` is deliberately not read: it is the same word as
 * the name without its slash.
 */
export function slashCommandOf(raw: unknown): SlashCommand | null {
  if (typeof raw !== 'string') return null;
  const name = /^\s*<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(raw)?.[1];
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim();
  return { name: name.startsWith('/') ? name : `/${name}`, args: args || undefined };
}

/**
 * The text a local command printed (`Set model to …`). Its own tag, separate from the command
 * above, because they arrive as two events and only some commands print anything at all.
 */
export function localCommandOutputOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^\s*<(?:local-command-stdout|command-stdout)>([\s\S]*?)<\/(?:local-command-stdout|command-stdout)>/.exec(raw);
  const text = m?.[1]?.trim();
  return text || null;
}
