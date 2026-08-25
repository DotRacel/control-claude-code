/**
 * msg.ts — the type a piece of user-facing text has before anyone knows the language.
 *
 * The reducer in web/src/model.ts is pure and runs in Node (test/render-history.ts drives it
 * against a real database with no browser anywhere), so it cannot call a translator. It therefore
 * emits a `Msg` — a catalog key plus parameters — and the view resolves it at render time. That
 * keeps one reducer output correct in every language, and it is why the transcript tests can
 * assert structure (`{ k: 'divider.reset' }`) instead of copy that drifts every time the wording
 * is tweaked.
 *
 * A BARE STRING IS DELIBERATE and means "already-final text, never translate this". Half the
 * fields that carry a Msg also carry raw text off the wire — `status.text` is a generated line at
 * model.ts:464 but `p.status_detail` verbatim at model.ts:363, and `error.title` is a phrase we
 * wrote at model.ts:381 but `String(p.subtype)` at model.ts:483. Making the string case legal is
 * what lets every one of those passthrough assignments stay exactly as it was.
 */
import type { MsgKey } from './zh.ts';

export type { MsgKey };

/**
 * A parameter substituted into a catalog string.
 *
 * `Msg` is allowed recursively because some lines are assembled from pieces that are themselves
 * translatable — the compaction divider's " · auto" suffix, the quota line's window name — and the
 * reducer that assembles them must stay locale-free.
 *
 * `{ t: <epoch seconds> }` is a clock time to be formatted in the reader's locale. It exists
 * because the quota line used to hardcode `toLocaleTimeString('zh-CN', …)` inside the reducer
 * (model.ts:716), which is exactly the kind of decision only the view is entitled to make.
 */
export type MsgParam = string | number | Msg | { t: number };
export type MsgParams = Record<string, MsgParam>;

export type Msg = string | { k: MsgKey; p?: MsgParams };
