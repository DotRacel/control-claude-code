/**
 * wire-shape.ts — what shape a data-plane payload has, and whether we have a decision about it.
 *
 * The input space is open and undocumented: the worker emits whatever the installed `claude`
 * emits, and we learn the shapes by reading real history (docs/HISTORY-EXPORT.md). The UI's `Item`
 * union, by contrast, is a closed set we invented. This file is the boundary between the two, and
 * it exists because that boundary used to leak in silence: `reduce`'s `default: return state`
 * dropped anything it did not recognise, so a shape the front-end never learned about was
 * indistinguishable from one we deliberately ignore.
 *
 * Hence a THREE-state verdict instead of a boolean:
 *
 *   handled  — the reducer has a branch for it and something reaches the screen
 *   ignored  — deliberately dropped, and `why` says what it is
 *   unknown  — nobody has decided yet. This is the backlog.
 *
 * `ignored` vs `unknown` is the whole point. test/history-audit.ts used to infer "was this
 * consumed?" from reference equality, which is exact but cannot tell a heartbeat we drop on
 * purpose from a subtype we have never seen — and that is the only distinction that matters when
 * triaging what to adapt next.
 *
 * Shared by the reducer (web/src/model.ts), the event ingest (src/server/db.ts, which stores the
 * shape alongside every payload), the audit (test/history-audit.ts) and the backlog report
 * (test/shape-report.ts). One implementation, so the four can never disagree.
 */

/** Verdicts a shape can have. `unknown` is not stored anywhere — it is the absence of a rule. */
export type Verdict = 'handled' | 'ignored' | 'unknown';

interface ShapeRule {
  verdict: 'handled' | 'ignored';
  /** Required for `ignored`: dropping something on purpose is a claim that needs a reason. */
  why?: string;
}

/**
 * The discriminator tree of the wire protocol, as one string.
 *
 * `type` alone is too coarse (every `system` payload would collapse into one bucket) and the whole
 * payload is too fine, so each type contributes whatever field actually discriminates it. For
 * `assistant`/`user` that is the SET of content-block types, sorted so the same message always
 * produces the same shape — those are judged by `blockVerdictOf` instead, one block at a time.
 */
export function shapeOf(payload: unknown): string {
  const p = payload as any;
  const t = p?.type ?? '?';
  if (t === 'system') return `system:${p.subtype ?? '?'}`;
  if (t === 'result') return `result:${p.subtype ?? '?'}`;
  if (t === 'stream_event') return `stream_event:${p.event?.type ?? '?'}`;
  if (t === 'control_request') return `control_request:${p.request?.subtype ?? '?'}`;
  if (t === 'control_response') return `control_response:${p.response?.subtype ?? '?'}`;
  if (t === 'assistant' || t === 'user') {
    const c = p.message?.content;
    if (typeof c === 'string') return `${t}:<string>`;
    if (!Array.isArray(c)) return `${t}:<${c == null ? 'missing' : typeof c}>`;
    const kinds = [...new Set(c.map((b: any) => b?.type ?? '?'))].sort();
    return `${t}:[${kinds.join('+') || 'empty'}]`;
  }
  return String(t);
}

/**
 * Every shape the reducer has a decision about. Keys are exact shapes, or `prefix:*` for the four
 * families where enumerating is impossible or pointless (see the comments below). Anything absent
 * is `unknown` — which is deliberate: a new `system` subtype must show up as a backlog entry, not
 * be swallowed by a wildcard.
 *
 * Mirror of the `case` labels in web/src/model.ts. Adding a branch there means adding a row here;
 * test/model.test.ts asserts the two do not drift.
 */
export const SHAPES: Record<string, ShapeRule> = {
  // ── system: one row per subtype the reducer branches on ──
  'system:init': { verdict: 'handled' },
  'system:thinking_tokens': { verdict: 'handled' },
  'system:post_turn_summary': { verdict: 'handled' },
  // Compaction, which arrives as three events: `status:'compacting'` when it starts, a
  // `status` carrying `compact_result` when it lands, and `compact_boundary` with the token
  // numbers. `status` is a generic "surfaced notice" subtype in the protocol, and the reducer
  // judges it one level down by value: compaction, the permission mode (`status:null` carrying
  // `permissionMode`), and `requesting` are decided; any other notice is filed as backlog
  // (`system:status:<value>`) rather than this rule acting as a wildcard for all of them.
  'system:status': { verdict: 'handled' },
  'system:compact_boundary': { verdict: 'handled' },
  'system:task_started': { verdict: 'handled' },
  'system:task_progress': { verdict: 'handled' },
  'system:task_updated': { verdict: 'handled' },
  'system:task_notification': { verdict: 'handled' },
  'system:background_tasks_changed': { verdict: 'handled' },
  'system:vcs_state_changed': { verdict: 'handled' },
  'system:worker_shutting_down': { verdict: 'handled' },
  'system:api_error': { verdict: 'handled' },
  'system:permission_denied': { verdict: 'handled' },
  'system:mirror_error': { verdict: 'handled' },

  // ── messages: judged per content block, not per payload ──
  // The block set is combinatorial (`assistant:[text+thinking+tool_use]` and every subset), so a
  // wildcard here is the only workable rule. It is not a hole: BLOCK_SHAPES below judges the
  // individual block types, and an unrecognised one still lands in the backlog.
  'assistant:*': { verdict: 'handled' },
  'user:*': { verdict: 'handled' },

  // `subtype` is `success`, `error`, or an open-ended `tool_deferred*` name — and `result()`
  // treats every non-success the same way, so enumerating the error names would add nothing.
  'result:*': { verdict: 'handled' },

  // ── control plane ──
  'control_request:can_use_tool': { verdict: 'handled' },
  control_cancel_request: { verdict: 'handled' },
  conversation_reset: { verdict: 'handled' },

  // Host→child requests: we are the sender, so seeing one echoed back tells us nothing. Listed
  // one by one ON PURPOSE rather than as `control_request:*` — the child also sends requests of
  // its own (`mcp_message`, `hook_callback` in docs/EVENTS.md), and those are questions aimed at
  // us. A wildcard here would file them as "deliberately ignored" when they are really unhandled.
  'control_request:interrupt': { verdict: 'ignored', why: 'ours — we send it to stop the turn' },
  'control_request:set_permission_mode': { verdict: 'ignored', why: 'ours — sent from the ⋯ menu' },
  'control_request:set_model': { verdict: 'ignored', why: 'ours' },
  'control_request:set_max_thinking_tokens': { verdict: 'ignored', why: 'ours' },
  'control_request:initialize': { verdict: 'ignored', why: 'ours — the handshake' },
  'control_request:apply_flag_settings': { verdict: 'ignored', why: 'ours' },

  // The receipt for a request we sent. Wildcard because the subtype is only success/error and
  // neither carries anything the transcript could show.
  'control_response:*': { verdict: 'ignored', why: 'receipt for a request we sent' },

  // ── streaming ──
  'stream_event:content_block_delta': { verdict: 'handled' },
  'stream_event:message_stop': { verdict: 'handled' },
  // The frame bookkeeping around those two. Enumerated rather than wildcarded so that a stream
  // event type we have never seen still reaches the backlog.
  'stream_event:message_start': { verdict: 'ignored', why: 'frame bookkeeping; the deltas carry the text' },
  'stream_event:message_delta': { verdict: 'ignored', why: 'stop_reason/usage only' },
  'stream_event:content_block_start': { verdict: 'ignored', why: 'frame bookkeeping' },
  'stream_event:content_block_stop': { verdict: 'ignored', why: 'frame bookkeeping' },
  'stream_event:ping': { verdict: 'ignored', why: 'keep-alive inside the stream' },

  keep_alive: { verdict: 'ignored', why: 'idle heartbeat from the worker' },

  // Quota telemetry, not a refusal: every sampled event carried `status:'allowed'` and reported
  // the five-hour window's reset time. Handled rather than ignored because a REAL limit would
  // arrive as this same shape, and that is not something to swallow — the reducer stays quiet
  // for the benign status and surfaces any other one.
  rate_limit_event: { verdict: 'handled' },
};

/**
 * Exact rule, then a `prefix:*` rule, then `unknown`. Only the four prefixes that actually have a
 * `*` row match a wildcard — `system:something_new` finds nothing and is correctly unknown.
 */
export function verdictOf(shape: string): Verdict {
  const exact = SHAPES[shape];
  if (exact) return exact.verdict;
  const at = shape.indexOf(':');
  if (at > 0) {
    const wild = SHAPES[`${shape.slice(0, at)}:*`];
    if (wild) return wild.verdict;
  }
  return 'unknown';
}

/** The reason a shape is dropped on purpose, for the audit's report. Same lookup as verdictOf. */
export function whyIgnored(shape: string): string | undefined {
  const exact = SHAPES[shape];
  if (exact) return exact.why;
  const at = shape.indexOf(':');
  return at > 0 ? SHAPES[`${shape.slice(0, at)}:*`]?.why : undefined;
}

/**
 * Content-block types, judged separately from the payload that carries them. The same three-state
 * rule applies one level down, because this is where the worst version of a silent drop lives: a
 * block nobody recognises used to be `JSON.stringify`d into the transcript, which is not "nothing
 * on screen" but something worse — raw JSON that reads like content.
 */
export const BLOCK_SHAPES: Record<string, ShapeRule> = {
  text: { verdict: 'handled' },
  thinking: { verdict: 'handled' },
  tool_use: { verdict: 'handled' },
  tool_result: { verdict: 'handled' },
  image: { verdict: 'handled' }, // pulled out as an attachment (src/image-blob.ts)
};

export function blockVerdictOf(type: string): Verdict {
  return BLOCK_SHAPES[type]?.verdict ?? 'unknown';
}

/**
 * The block types in one `content` value that nobody has decided about, deduplicated.
 *
 * Accepts any `content` — a message's own array, or the inner array of a `tool_result` — so the
 * reducer can sweep both levels with one call. A string content has no blocks and yields nothing.
 */
export function unknownBlockTypes(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out = new Set<string>();
  for (const b of content) {
    const t = (b as any)?.type;
    if (typeof t !== 'string' || !t) {
      out.add('?');
      continue;
    }
    if (blockVerdictOf(t) === 'unknown') out.add(t);
  }
  return [...out];
}
