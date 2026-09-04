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

/** Strip synthetic user-message content official clients hide. null = render nothing. */
export function cleanUserText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (SYNTHETIC_TAG.test(raw)) return null;
  const s = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return s || null;
}

/** Every renderable text a `user` payload carries (empty for meta/compact payloads). */
export function userTextsFrom(payload: any): string[] {
  if (!payload || payload.isMeta || payload.isCompactSummary) return [];
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
