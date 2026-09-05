/**
 * Transcript helpers for the phone UI.
 *
 * Live `user` events are worker echoes of every keyboard turn — web-sent and
 * terminal-typed alike. Web submits are inserted optimistically, so their
 * echo must be dropped; terminal-typed turns must be shown.
 *
 * `cleanUserText` / `userTextsFrom` live in src/transcript-text.ts because the server's
 * session-list digest must hide exactly the same synthetic messages; re-exported here so
 * the web (and test/transcript.test.ts) keeps one import site.
 */
export { cleanUserText, userTextsFrom, slashCommandOf, localCommandOutputOf, interruptNoticeIn } from '../../src/transcript-text.ts';
export type { SlashCommand } from '../../src/transcript-text.ts';
import { userTextsFrom } from '../../src/transcript-text.ts';

/**
 * Decide which user texts to append.
 * Live echoes that match a pending web-sent string are consumed (already on screen).
 * Everything else — history, and live terminal turns — is returned to render.
 *
 * `consumed` names the echoes we dropped. The echo is the worker telling us the agent has
 * actually taken that turn, which is the only signal that a queued bubble is no longer queued.
 */
export function takeVisibleUserTexts(payload: any, pendingWeb: string[], isHistory: boolean): { texts: string[]; pendingWeb: string[]; consumed: string[] } {
  const next = pendingWeb.slice();
  const texts: string[] = [];
  const consumed: string[] = [];
  for (const t of userTextsFrom(payload)) {
    if (!isHistory) {
      const i = next.indexOf(t);
      if (i >= 0) { next.splice(i, 1); consumed.push(t); continue; }
    }
    texts.push(t);
  }
  return { texts, pendingWeb: next, consumed };
}
