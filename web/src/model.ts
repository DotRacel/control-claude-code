/**
 * model.ts — the data-plane event stream folded into a renderable transcript.
 *
 * This is a pure function of (state, payload): the same reducer eats the history backfill and
 * the live stream, so what you see after reopening a session is byte-identical to what you saw
 * while it happened. Keeping it out of the components is what makes it testable against real
 * captured events (test/model.test.ts).
 *
 * Two things learned from real transcripts drive the shape here:
 *
 *  - The REPL bridge replays the WHOLE conversation on connect, so "history" is not
 *    necessarily stale: a permission request or a question that never got a tool_result is
 *    genuinely still waiting for you. So open-ness is decided by whether the matching
 *    tool_result arrived, never by whether the event came from the backfill.
 *  - `assistant` text also arrives token-by-token as `stream_event` beforehand. The final
 *    message replaces the streamed draft in place rather than appending a duplicate.
 *
 * Event shapes: docs/EVENTS.md. A new `system` subtype must never break the transcript — but it
 * must not vanish either, which is what "unknown types are no-ops" used to mean here. Every
 * payload is now gated on a declared verdict (src/wire-shape.ts): declared noise is dropped for
 * free, and anything undecided is counted in `unhandled` and marked in the transcript.
 */
import { takeVisibleUserTexts } from './transcript.ts';
import { toolArg, HIDDEN_TOOLS, QUESTION_TOOL, PLAN_EXIT_TOOL, PLAN_ENTER_TOOL } from '../../src/tool-summary.ts';
import { isPushNotificationToolUse } from '../../src/push-event.ts';
import { imageAttachmentsOf, toolResultText, type ImageAttachment } from '../../src/image-blob.ts';
import { shapeOf, verdictOf, unknownBlockTypes } from '../../src/wire-shape.ts';
// Type-only, and that is the point: the reducer names catalog KEYS but never loads a catalog, so
// its runtime graph stays free of i18n entirely and this file still folds identically in Node.
import type { Msg } from './i18n/msg.ts';

/** Task tools that mutate the list render as a checklist card, not as a tool row. */
export const TODO_TOOLS = new Set(['TaskCreate', 'TaskUpdate']);

export type ToolStatus = 'running' | 'awaiting' | 'ok' | 'error';

export interface ToolCall {
  toolUseId: string;
  name: string;
  input: any;
  status: ToolStatus;
  result?: string;
  startedAt?: number;
  endedAt?: number;
  /**
   * Images the tool_result carried. `Read` of a screenshot returns an image block, not text, and
   * stringifying it put megabytes of base64 in the transcript — so the bytes stay on the server
   * behind a reference (src/image-blob.ts) and the card fetches one when tapped.
   */
  images?: ImageAttachment[];
}

export interface QuestionOption { label: string; description?: string; preview?: string }
export interface Question { question: string; header?: string; multiSelect?: boolean; options: QuestionOption[] }

/** `subject` is the task's own text off the wire, so it is normally a bare (untranslated) string —
 * only the "the payload never said" fallbacks are catalog keys. */
export interface TodoTask { key: string; subject: Msg; status: 'pending' | 'in_progress' | 'completed' | 'deleted' }

export interface PermissionRequest {
  requestId: string;
  toolUseId?: string;
  toolName: string;
  displayName?: string;
  input: any;
  reason?: string;
  suggestions: any[];
}

export type Item =
  | { kind: 'user'; id: number; text: string; state: 'sent' | 'queued' }
  // `fromStream` outlives `streaming`: message_stop stops the caret, but the authoritative
  // `assistant` message arrives *after* it and must replace this item, not append a copy.
  | { kind: 'prose'; id: number; text: string; streaming?: boolean; fromStream?: boolean }
  | { kind: 'thinking'; id: number; text: string; tokens?: number; streaming?: boolean; fromStream?: boolean }
  | { kind: 'tools'; id: number; calls: ToolCall[] }
  | { kind: 'todo'; id: number; tasks: TodoTask[] }
  | { kind: 'question'; id: number; requestId: string; toolUseId?: string; questions: Question[]; answered?: Msg }
  /**
   * ExitPlanMode's approval ask. It is a `can_use_tool` request like any other, but the wire marks
   * it `requires_user_interaction:true` — the control schema's way of saying a one-tap Allow/Deny
   * is the wrong surface — and its input carries the entire plan as markdown. A modal with a
   * 400-char truncated command line is exactly what that flag forbids, so it renders inline, the
   * way a question does. `outcome` is which button was pressed, kept so the settled card can say
   * whether the plan was approved or sent back.
   */
  | { kind: 'plan'; id: number; requestId: string; toolUseId?: string; plan: string; planFilePath?: string;
      answered?: Msg; outcome?: 'approved' | 'rejected' }
  // `detail`/`phases`/`tools`/`ms` come from system:task_progress, which the CLI emits while a
  // background task runs — without them a task card is a spinner with no news for minutes.
  // `interrupted` is not a CLI status: it is what a running task becomes when the worker goes
  // away. Neither 'completed' (it did not finish) nor 'failed' (nothing went wrong) is honest.
  | { kind: 'bgtask'; id: number; taskId: string; description: Msg; status: 'running' | 'completed' | 'failed' | 'interrupted';
      // `summary` is the human line the completion notification carries ('Agent "X" finished', a
      // failure reason, a Monitor event) — the point of a *finished* card, kept even when `detail`
      // (the last running step) is dropped. `description` is what task_started named it.
      summary?: string; detail?: string; phases?: string[]; tools?: number; ms?: number }
  | { kind: 'status'; id: number; text: Msg }
  /** A hard break in the conversation: /clear, a compaction, the worker going away. */
  | { kind: 'divider'; id: number; label: Msg }
  /**
   * A payload whose shape nobody has decided about yet (src/wire-shape.ts). It renders as a faint
   * marker rather than nothing at all: the transcript must never silently skip a beat, because a
   * gap you cannot see is a gap nobody reports. `count` merges a run of the same shape so one
   * chatty unknown subtype cannot flood the transcript.
   */
  | { kind: 'unknown'; id: number; shape: string; count: number }
  /** `title` is ours to word for a failure we recognise, and the wire's own subtype otherwise;
   * `detail` is always the payload's text and is never translated. */
  | { kind: 'error'; id: number; title: Msg; detail?: string };

export interface Live {
  busy: boolean;
  /**
   * Is the model reasoning *right now*? `busy` spans the whole turn — tool runs and prose
   * included — so the activity line needs this narrower signal to decide whether the thinking
   * glyph is honest. Set by thinking deltas and `system:thinking_tokens`, cleared the moment
   * text or a tool call takes over.
   */
  thinking?: boolean;
  thinkingTokens?: number;
  /**
   * Is the worker compacting the context right now? Neither `busy` nor `thinking` covers it: no
   * tool is held open and the model is not reasoning, yet compaction runs for minutes (228s at the
   * top of the sampled range), and the activity line would otherwise say only 运行中 for all of it.
   * Set by `system:status`, cleared by its `compact_result` — and by idle(), so no lost completion
   * can leave it stuck on.
   */
  compacting?: boolean;
  /** The tool currently held open, for the activity line under the transcript. */
  running?: { toolUseId: string; name: string; arg: string; since: number };
  permission?: PermissionRequest;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  slashCommands: string[];
  skills: string[];
}

export interface TranscriptState {
  items: Item[];
  live: Live;
  seq: number;
  /** toolUseId → position of the call, so a tool_result can find its card. */
  index: Record<string, { i: number; j: number }>;
  /** Web-sent texts awaiting their worker echo (which must not render twice). */
  pendingWeb: string[];
  /** Task* state accumulated across the session; snapshotted into each todo card. */
  todos: TodoTask[];
  /**
   * shape → how many payloads of it this session could not turn into anything (`unknown` in
   * src/wire-shape.ts), including content-block types inside an otherwise-rendered message. This
   * is the per-session view of the same backlog `npm run shape-report` reads out of the database,
   * and it is what test/model.test.ts asserts on instead of "unknown types are inert".
   */
  unhandled: Record<string, number>;
}

export const initialState = (): TranscriptState => ({
  items: [],
  live: { busy: false, slashCommands: [], skills: [] },
  seq: 0,
  index: {},
  pendingWeb: [],
  todos: [],
  unhandled: {},
});

/** A non-empty string, or undefined — for payload fields that are sometimes present and empty. */
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** 167265 → "167k". Compaction counts are six figures, where the exact digits are noise. */
const ktok = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));

const timeOf = (p: any): number | undefined => {
  const t = p?.timestamp;
  if (typeof t !== 'string') return undefined;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : undefined;
};

/** Working copy: items/live are replaced, individual items cloned only when touched. */
interface Draft extends TranscriptState { items: Item[]; live: Live }
/** Plain `Omit` on a union collapses to the shared keys; distribute it instead. */
type NewItem = Item extends infer T ? (T extends Item ? Omit<T, 'id'> : never) : never;
const draftOf = (s: TranscriptState): Draft => ({ ...s, items: s.items.slice(), live: { ...s.live }, index: { ...s.index } });
const push = (d: Draft, item: NewItem): Item => {
  const withId = { ...item, id: d.seq++ } as Item;
  d.items.push(withId);
  return withId;
};

/** Replace the streamed draft at the tail (settled or not), or push a fresh item. */
function settleStreamed(d: Draft, kind: 'prose' | 'thinking', text: string, tokens?: number): void {
  const last = d.items[d.items.length - 1];
  if (last && last.kind === kind && (last.streaming || last.fromStream)) {
    d.items[d.items.length - 1] = { ...last, text, streaming: false, fromStream: false, ...(kind === 'thinking' ? { tokens } : {}) } as Item;
    return;
  }
  push(d, kind === 'prose' ? { kind, text } : { kind, text, tokens });
}

function appendStreamed(d: Draft, kind: 'prose' | 'thinking', chunk: string): void {
  const last = d.items[d.items.length - 1];
  if (last && last.kind === kind && last.streaming) {
    d.items[d.items.length - 1] = { ...last, text: last.text + chunk } as Item;
    return;
  }
  push(d, kind === 'prose'
    ? { kind: 'prose', text: chunk, streaming: true, fromStream: true }
    : { kind: 'thinking', text: chunk, streaming: true, fromStream: true });
}

/**
 * A textless thinking marker. Consecutive blocks coalesce (a turn emits several), so one
 * stretch of reasoning is one line, carrying the newest token estimate.
 */
function markThinking(d: Draft, tokens: number | undefined): void {
  const lastIdx = d.items.length - 1;
  const last = d.items[lastIdx];
  if (last && last.kind === 'thinking' && !last.text) {
    d.items[lastIdx] = { ...last, tokens: tokens ?? last.tokens };
    return;
  }
  push(d, { kind: 'thinking', text: '', tokens });
}

/** Adjacent tool cards merge into one bordered group (design 0b). */
function addToolCall(d: Draft, call: ToolCall): void {
  const lastIdx = d.items.length - 1;
  const last = d.items[lastIdx];
  if (last && last.kind === 'tools') {
    const calls = last.calls.concat(call);
    d.items[lastIdx] = { ...last, calls };
    d.index[call.toolUseId] = { i: lastIdx, j: calls.length - 1 };
    return;
  }
  push(d, { kind: 'tools', calls: [call] });
  d.index[call.toolUseId] = { i: d.items.length - 1, j: 0 };
}

function patchCall(d: Draft, toolUseId: string, patch: Partial<ToolCall>): ToolCall | null {
  const at = d.index[toolUseId];
  if (!at) return null;
  const item = d.items[at.i];
  if (!item || item.kind !== 'tools') return null;
  const calls = item.calls.slice();
  const next = { ...calls[at.j], ...patch };
  calls[at.j] = next;
  d.items[at.i] = { ...item, calls };
  return next;
}

/** A todo mutation refreshes the trailing todo card, or starts a new one. */
function snapshotTodos(d: Draft): void {
  const tasks = d.todos.map((t) => ({ ...t }));
  const lastIdx = d.items.length - 1;
  const last = d.items[lastIdx];
  if (last && last.kind === 'todo') d.items[lastIdx] = { ...last, tasks };
  else push(d, { kind: 'todo', tasks });
}

function applyTodoTool(d: Draft, call: { toolUseId: string; name: string; input: any }): void {
  const input = call.input ?? {};
  d.todos = d.todos.slice();
  if (call.name === 'TaskCreate') {
    // The numeric id only exists in the tool_result; key on the tool_use id until then.
    const subject = input.subject ?? input.description;
    d.todos.push({ key: call.toolUseId, subject: subject ? String(subject) : { k: 'todo.untitled' }, status: 'pending' });
  } else {
    const id = String(input.taskId ?? '');
    const found = d.todos.findIndex((t) => t.key === id);
    const status = ['pending', 'in_progress', 'completed', 'deleted'].includes(input.status) ? input.status : undefined;
    if (found >= 0) d.todos[found] = { ...d.todos[found], ...(input.subject ? { subject: String(input.subject) } : {}), ...(status ? { status } : {}) };
    else if (id) d.todos.push({ key: id, subject: input.subject ? String(input.subject) : { k: 'todo.numbered', p: { id } }, status: status ?? 'pending' });
  }
  d.todos = d.todos.filter((t) => t.status !== 'deleted');
  snapshotTodos(d);
}

/** `Task #3 created successfully: …` — learn the real id so later TaskUpdates line up. */
function learnTodoId(d: Draft, toolUseId: string, result: string): void {
  const m = /Task #(\d+)/.exec(result);
  if (!m) return;
  const at = d.todos.findIndex((t) => t.key === toolUseId);
  if (at < 0) return;
  d.todos = d.todos.slice();
  d.todos[at] = { ...d.todos[at], key: m[1] };
  // Refresh whichever todo card is showing this snapshot.
  for (let i = d.items.length - 1; i >= 0; i--) {
    const it = d.items[i];
    if (it.kind === 'todo') { d.items[i] = { ...it, tasks: d.todos.map((t) => ({ ...t })) }; break; }
  }
}

function closeOpenPermission(d: Draft, toolUseId: string): void {
  if (d.live.permission && d.live.permission.toolUseId === toolUseId) d.live.permission = undefined;
}

// ── the reducer ──
export function reduce(state: TranscriptState, payload: any, opts: { isHistory: boolean } = { isHistory: false }): TranscriptState {
  if (!payload || typeof payload !== 'object') return state;

  /*
   * The verdict is decided BEFORE dispatching, not in the default arm of each switch. That is what
   * makes src/wire-shape.ts the gate rather than a description: `system:something_new` used to be
   * swallowed by system()'s own `default: return d` — one level below where anything was watching
   * — and the `system` subtype is exactly where new wire shapes show up. Now nothing reaches a
   * branch without a declared decision, and the two lists are held together by a test
   * ('every shape the reducer branches on is declared handled').
   */
  const shape = shapeOf(payload);
  const verdict = verdictOf(shape);
  // Declared noise: the ORIGINAL state, identity included. Load-bearing, not tidiness — ChatView
  // reduces with `setState((prev) => reduce(prev, payload))`, so a fresh object per keep_alive
  // would re-render the whole transcript on every heartbeat.
  if (verdict === 'ignored') return state;
  const d = draftOf(state);
  if (verdict === 'unknown') return markUnknown(d, shape);
  const ts = timeOf(payload);

  switch (payload.type) {
    case 'system': return system(d, payload);
    case 'assistant': return assistant(d, payload, ts, opts.isHistory);
    case 'user': return user(d, payload, ts, opts.isHistory);
    case 'result': return result(d, payload);
    case 'control_request': return controlRequest(d, payload);
    case 'stream_event': return streamEvent(d, payload, opts.isHistory);
    case 'control_cancel_request': return controlCancel(d, payload);
    case 'conversation_reset': return conversationReset(d);
    case 'rate_limit_event': return rateLimit(d, payload);
    // Unreachable while SHAPES and this switch agree, which a test enforces. If they ever drift,
    // failing closed here (as an undecided shape) beats rendering nothing.
    default: return markUnknown(d, shape);
  }
}

/**
 * Nobody has decided what to do with this shape yet. It is counted for the backlog and marked in
 * the transcript — never silently dropped, because a gap you cannot see is a gap nobody reports —
 * and never allowed to disturb anything already rendered.
 */
function markUnknown(d: Draft, shape: string): TranscriptState {
  noteUnknown(d, shape);
  const last = d.items[d.items.length - 1];
  // Merge a run of the same shape rather than stacking identical markers.
  if (last?.kind === 'unknown' && last.shape === shape) {
    d.items[d.items.length - 1] = { ...last, count: last.count + 1 };
  } else {
    push(d, { kind: 'unknown', shape, count: 1 });
  }
  return d;
}

/**
 * Record a shape we could not render. Cloned on write because `draftOf` shares the map with the
 * previous state — this is the one field that survives untouched through most reductions.
 */
function noteUnknown(d: Draft, shape: string): void {
  d.unhandled = { ...d.unhandled, [shape]: (d.unhandled[shape] ?? 0) + 1 };
}

function system(d: Draft, p: any): TranscriptState {
  switch (p.subtype) {
    case 'init':
      if (typeof p.model === 'string') d.live.model = p.model;
      if (typeof p.permissionMode === 'string') d.live.permissionMode = p.permissionMode;
      if (typeof p.cwd === 'string' && p.cwd) d.live.cwd = p.cwd; // '' on REPL (/rc) sessions
      if (Array.isArray(p.slash_commands)) d.live.slashCommands = p.slash_commands.filter((c: unknown) => typeof c === 'string');
      if (Array.isArray(p.skills)) d.live.skills = p.skills.filter((c: unknown) => typeof c === 'string');
      return d;
    case 'thinking_tokens':
      // The estimate only grows while the model reasons, so its arrival IS "thinking now".
      d.live.thinking = true;
      if (typeof p.estimated_tokens === 'number') d.live.thinkingTokens = p.estimated_tokens;
      return d;
    case 'post_turn_summary':
      // Named for when it is emitted: the turn is over. `result` normally says so, but it is not
      // guaranteed to arrive (a dropped worker, a bridge that stops relaying), and a turn whose
      // end is never announced would leave the activity line spinning for good. A later tool call
      // or user turn legitimately flips `busy` back on, so this is a floor, not a latch — but
      // trailing prose does not (the worker posts the final text after the turn is over).
      idle(d);
      if (typeof p.status_detail === 'string' && p.status_detail.trim()) push(d, { kind: 'status', text: p.status_detail.trim() });
      return d;
    case 'status': {
      // A generic "surfaced notice" in the protocol whose only observed use is compaction, as a
      // pair: `status:'compacting'` when it starts, then `compact_result` when it lands (26 of each
      // in the sampled history, never anything else). The start is worth a live flag because that
      // stretch is otherwise unmarked; the success is not worth a transcript line because
      // `compact_boundary` follows with the actual numbers.
      // `busy` is deliberately NOT set here: system() cannot see opts.isHistory, and a backfill
      // must never flip it (the view re-derives it with turnActiveIn). It does not need to — every
      // sampled compaction had `trigger:'auto'`, which fires mid-turn, so the turn is already busy.
      if (p.status === 'compacting') {
        d.live.compacting = true;
        return d;
      }
      const done = str(p.compact_result);
      if (done) {
        d.live.compacting = false;
        if (done !== 'success') push(d, { kind: 'error', title: { k: 'compact.failed' }, detail: done });
        return d;
      }
      // Any other notice under this subtype. Declaring `system:status` handled must not silently
      // become a wildcard for notices nobody has looked at, so this still reaches the backlog —
      // qualified by the value, which is what a future reader needs in order to decide.
      return markUnknown(d, `system:status:${str(p.status) ?? '?'}`);
    }
    case 'compact_boundary': {
      // A real break in what the model can still see, so it earns the same divider as /clear. The
      // envelope's `historical` flag is deliberately not read: it marks a replayed event in general
      // (user and assistant events carry it too), and replay is the caller's business via
      // opts.isHistory — every other branch here ignores it for the same reason.
      const m = p.compact_metadata ?? {};
      const pre = Number(m.pre_tokens);
      const post = Number(m.post_tokens);
      // The token figures are numerals in every language, so they stay a literal fragment; only
      // the trigger word needs one, and it carries its own separator (see compact.* in zh.ts).
      const size = Number.isFinite(pre) && Number.isFinite(post) ? ` · ${ktok(pre)} → ${ktok(post)}` : '';
      const why: Msg = m.trigger === 'manual' ? { k: 'compact.manual' } : m.trigger === 'auto' ? { k: 'compact.auto' } : '';
      d.live.compacting = false;
      push(d, { kind: 'divider', label: { k: 'divider.compacted', p: { why, size } } });
      return d;
    }
    case 'task_started': {
      const taskId = String(p.task_id ?? '');
      if (!taskId || d.items.some((i) => i.kind === 'bgtask' && i.taskId === taskId)) return d;
      push(d, { kind: 'bgtask', taskId, description: p.description ? String(p.description) : { k: 'bgtask.untitled' }, status: 'running' });
      return d;
    }
    case 'task_notification': {
      const taskId = String(p.task_id ?? '');
      const status = p.status === 'failed' ? 'failed' : 'completed';
      const summary = p.summary ? String(p.summary) : undefined;
      const at = d.items.findIndex((i) => i.kind === 'bgtask' && i.taskId === taskId);
      // The card already names the task (from task_started); the notification's summary is the
      // *outcome* line, so add it alongside. Creating a card from the notification alone, there is
      // nothing else to show, so the summary becomes the description — not also a duplicate line.
      if (at >= 0) { const it = d.items[at] as Extract<Item, { kind: 'bgtask' }>; d.items[at] = { ...it, status, summary: summary ?? it.summary }; }
      else if (taskId) push(d, { kind: 'bgtask', taskId, description: summary ?? { k: 'bgtask.untitled' }, status });
      return d;
    }
    case 'background_tasks_changed': {
      // The list holds what is still tracked; anything that dropped off has finished. Inferred,
      // because a task can complete without ever emitting its own task_notification.
      const live = new Set<string>((Array.isArray(p.tasks) ? p.tasks : []).map((t: any) => String(t?.task_id ?? '')));
      for (let i = 0; i < d.items.length; i++) {
        const it = d.items[i];
        if (it.kind === 'bgtask' && it.status === 'running' && !live.has(it.taskId)) d.items[i] = { ...it, status: 'completed' };
      }
      return d;
    }
    case 'task_progress': {
      // Progress for a task already on screen. It never *creates* a card: a progress frame for a
      // task whose `task_started` we never saw would render a task nobody asked about.
      const taskId = String(p.task_id ?? '');
      const at = d.items.findIndex((i) => i.kind === 'bgtask' && i.taskId === taskId);
      if (!taskId || at < 0) return d;
      const it = d.items[at] as Extract<Item, { kind: 'bgtask' }>;
      if (it.status !== 'running') return d; // a late frame must not revive a finished card
      const phases = Array.isArray(p.workflow_progress)
        ? p.workflow_progress.map((x: any) => String(x?.title ?? '')).filter(Boolean)
        : it.phases;
      d.items[at] = {
        ...it,
        detail: typeof p.description === 'string' && p.description.trim() ? p.description.trim() : it.detail,
        phases,
        tools: typeof p.usage?.tool_uses === 'number' ? p.usage.tool_uses : it.tools,
        ms: typeof p.usage?.duration_ms === 'number' ? p.usage.duration_ms : it.ms,
      };
      return d;
    }
    case 'task_updated': {
      // `patch` is a partial task record; only a terminal status changes what the card says.
      const taskId = String(p.task_id ?? '');
      const status = p.patch?.status;
      const at = d.items.findIndex((i) => i.kind === 'bgtask' && i.taskId === taskId);
      if (!taskId || at < 0 || typeof status !== 'string') return d;
      const next = status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : 'running';
      d.items[at] = { ...(d.items[at] as Extract<Item, { kind: 'bgtask' }>), status: next };
      return d;
    }
    case 'vcs_state_changed': {
      // Emitted after the agent commits or pushes — worth a line, since it is the one kind of
      // side effect you cannot undo by reading further.
      const kind = String(p.kind ?? '');
      // A verb we recognise gets a catalog key; anything else is the wire's own subcommand name,
      // which is a git word and stays one.
      const label: Msg | null = kind === 'commit' ? { k: 'status.committed' }
        : kind === 'push' ? { k: 'status.pushed' }
        : kind ? `git ${kind}` : null;
      if (!label) return d;
      const branch = typeof p.branch === 'string' && p.branch ? ` · ${p.branch}` : '';
      push(d, { kind: 'status', text: { k: 'status.vcs', p: { label, branch } } });
      return d;
    }
    case 'worker_shutting_down': {
      // The terminal-side claude is going away: nothing else will answer this session, so the
      // activity line must stop claiming work is in flight — and neither may a task card, since
      // the process that was running it went with it.
      idle(d);
      for (let i = 0; i < d.items.length; i++) {
        const it = d.items[i];
        if (it.kind === 'bgtask' && it.status === 'running') d.items[i] = { ...it, status: 'interrupted' };
      }
      // 'host_exit' is the one reason we have words for; any other is the worker's own string.
      const reason: Msg | null = p.reason === 'host_exit' ? { k: 'divider.hostExit' }
        : typeof p.reason === 'string' && p.reason ? String(p.reason) : null;
      push(d, { kind: 'divider', label: reason ? { k: 'divider.disconnectedWhy', p: { reason } } : { k: 'divider.disconnected' } });
      return d;
    }
    case 'api_error':
    case 'permission_denied':
    case 'mirror_error':
      push(d, { kind: 'error', title: String(p.subtype).replace(/_/g, ' '), detail: typeof p.message === 'string' ? p.message : undefined });
      return d;
    default:
      // Unreachable: reduce() gates on the declared verdict, so a subtype with no rule in
      // src/wire-shape.ts never gets this far — it is counted and marked instead of vanishing
      // here, which is what this arm used to do to every new `system` subtype.
      return d;
  }
}

function assistant(d: Draft, p: any, ts: number | undefined, isHistory: boolean): TranscriptState {
  const content = p.message?.content;
  if (!Array.isArray(content)) return d;
  // Only a tool_use (below) may arm `busy`. The worker delivers the turn's FINAL text after the
  // `result` (observed live: assistant[thinking] → result → assistant[text], same message id), so
  // a text-only message arriving while idle is a turn that already ended, not one starting — and
  // arming here left the activity line saying 运行中 forever. Same rule as the server's digest
  // (src/server/store.ts foldDigest), which never had this bug.
  // A block type nobody handles (`redacted_thinking`, say) is counted but NOT marked in the
  // transcript: the message it arrived in did render, so a marker would claim a gap where there
  // is only a missing detail. The count is what puts it in the backlog.
  for (const t of unknownBlockTypes(content)) noteUnknown(d, `block:${t}`);
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    // Blocks arrive in the order the model produced them, so the last one wins: a message that
    // reasoned and then answered ends on `text` and the thinking glyph gives way.
    if (b.type === 'text') {
      if (!isHistory) d.live.thinking = false;
      if (typeof b.text === 'string' && b.text.trim()) settleStreamed(d, 'prose', b.text);
    } else if (b.type === 'thinking') {
      if (!isHistory) d.live.thinking = true;
      // Real transcripts carry `thinking: ""` — the data plane relays the signature only, never
      // the reasoning text. So a thinking block is a *marker* ("it thought, for N tokens"),
      // and only becomes expandable prose if a future version starts sending the text.
      const text = typeof b.thinking === 'string' ? b.thinking : '';
      if (text.trim()) settleStreamed(d, 'thinking', text, d.live.thinkingTokens);
      else markThinking(d, d.live.thinkingTokens);
    } else if (b.type === 'tool_use') {
      if (!isHistory) d.live.thinking = false;
      if (isPushNotificationToolUse(b) || HIDDEN_TOOLS.has(b.name)) continue;
      if (b.name === QUESTION_TOOL) continue; // rendered as a question card from its permission request
      if (b.name === PLAN_EXIT_TOOL) continue; // …and this one as a plan card, from the same place
      if (b.name === PLAN_ENTER_TOOL) {
        // Auto-approved and input-less, so there is no ask to render and nothing to put on a tool
        // card — but the mode HAS changed, and every other signal for that (the re-sent
        // `system:init`) is invisible. A line saying so is the only sign the transcript gets.
        if (!isHistory) d.live.busy = true;
        push(d, { kind: 'status', text: { k: 'plan.entered' } });
        continue;
      }
      const toolUseId = String(b.id ?? '');
      if (!toolUseId) continue;
      if (!isHistory) d.live.busy = true;
      if (TODO_TOOLS.has(b.name)) {
        applyTodoTool(d, { toolUseId, name: b.name, input: b.input });
        d.index[toolUseId] = { i: -1, j: -1 }; // known but not a tool card
        continue;
      }
      addToolCall(d, { toolUseId, name: String(b.name ?? 'Tool'), input: b.input, status: 'running', startedAt: ts });
      d.live.running = { toolUseId, name: String(b.name ?? 'Tool'), arg: toolArg(b.name, b.input), since: ts ?? Date.now() };
    }
  }
  return d;
}

/**
 * The agent has taken a turn we sent while it was busy, so that bubble is no longer queued.
 * Oldest match first: `pendingWeb` is consumed FIFO, so two identical queued texts settle in
 * the order they were sent.
 */
function settleQueued(d: Draft, text: string): void {
  const at = d.items.findIndex((i) => i.kind === 'user' && i.state === 'queued' && i.text === text);
  if (at >= 0) d.items[at] = { ...(d.items[at] as Extract<Item, { kind: 'user' }>), state: 'sent' };
}

/**
 * A `<task-notification>` echo — the queued command claude injects when a background task finishes,
 * arriving as a `user` message whose text IS the raw XML. Never a bubble (the official client never
 * shows it as a turn): parse it into card updates instead. Covers agent/command completions, the
 * multi-task "stopped" sweep on resume, Monitor events, and the fork-source session notice.
 */
function taskNotification(d: Draft, raw: string): TranscriptState {
  // The subagent's own control tags are neutralised by the harness (`<` → `&lt;`) before they reach
  // here; undo that only for the short summary/event lines we surface.
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  const tag = /<status>\s*(\w+)\s*<\/status>/.exec(raw)?.[1];
  const summary = decode(/<summary>([\s\S]*?)<\/summary>/.exec(raw)?.[1] ?? '');
  const event = decode(/<event>([\s\S]*?)<\/event>/.exec(raw)?.[1] ?? '');

  // No <status> means this is not a lifecycle end but an informational beat: a Monitor event (the
  // task is still watching), or the fork-source session notice. Surface a compact line — and never
  // terminate a card, which for a live Monitor would be a lie.
  if (!tag) {
    if (/<fork-source>/.test(raw)) push(d, { kind: 'status', text: { k: 'task.forked' } });
    else if (event || summary) push(d, { kind: 'status', text: event || summary });
    return d;
  }

  const status: 'completed' | 'failed' | 'interrupted' = tag === 'failed' ? 'failed' : tag === 'stopped' ? 'interrupted' : 'completed';
  // `__orphan_summary__:*` ids are the scanner's internal markers, not tasks (the message says so).
  const ids = [...raw.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1].trim()).filter((id) => id && !id.startsWith('__orphan_summary__'));
  if (ids.length === 0) { if (summary) push(d, { kind: 'status', text: summary }); return d; }
  for (const taskId of ids) {
    const at = d.items.findIndex((i) => i.kind === 'bgtask' && i.taskId === taskId);
    if (at >= 0) { const it = d.items[at] as Extract<Item, { kind: 'bgtask' }>; d.items[at] = { ...it, status, summary: summary || it.summary }; }
    else push(d, { kind: 'bgtask', taskId, description: summary || { k: 'bgtask.untitled' }, status });
  }
  return d;
}

function user(d: Draft, p: any, ts: number | undefined, isHistory: boolean): TranscriptState {
  const content = p?.message?.content;
  if (typeof content === 'string' && /^\s*<task-notification>/.test(content)) return taskNotification(d, content);
  const taken = takeVisibleUserTexts(p, d.pendingWeb, isHistory);
  d.pendingWeb = taken.pendingWeb;
  for (const text of taken.consumed) settleQueued(d, text);
  for (const text of taken.texts) {
    push(d, { kind: 'user', text, state: 'sent' });
    // A fresh turn has not reasoned yet — whatever the previous one ended on must not carry over.
    if (!isHistory) { d.live.busy = true; d.live.thinking = false; }
  }
  if (Array.isArray(content)) {
    for (const t of unknownBlockTypes(content)) noteUnknown(d, `block:${t}`);
    for (const b of content) {
      if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      // …and one level deeper: a tool_result's own content carries text, images, and whatever
      // else a future tool returns. toolResultText renders those as a placeholder, so the count
      // is the only thing that tells us they exist.
      for (const t of unknownBlockTypes(b.content)) noteUnknown(d, `block:tool_result.${t}`);
      const id = b.tool_use_id;
      // Not JSON.stringify: a `Read` of an image returns an image block, and stringifying it
      // dumped ~600 KB of base64 into the card. Text and images are pulled apart instead.
      const body = toolResultText(b.content);
      const images = imageAttachmentsOf(b);
      closeOpenPermission(d, id);

      const q = d.items.findIndex((i) => i.kind === 'question' && i.toolUseId === id);
      if (q >= 0) { d.items[q] = { ...(d.items[q] as any), answered: body }; continue; }

      const pl = d.items.findIndex((i) => i.kind === 'plan' && i.toolUseId === id);
      if (pl >= 0) {
        // Never the wire text: an approved plan comes back with the ENTIRE plan appended again
        // ("## Approved Plan:\n…"), so echoing it under the card would print the plan twice. The
        // outcome is all this line has to carry, and our own optimistic answer already set it
        // when the tap happened here rather than in the terminal.
        const prev = d.items[pl] as Extract<Item, { kind: 'plan' }>;
        const outcome = prev.outcome ?? (b.is_error ? 'rejected' : 'approved');
        d.items[pl] = {
          ...prev, outcome,
          answered: prev.answered ?? { k: outcome === 'approved' ? 'plan.approved' : 'plan.rejected' },
        };
        continue;
      }

      const at = d.index[id];
      if (at && at.i < 0) { learnTodoId(d, id, body); continue; } // a Task* call
      const call = patchCall(d, id, {
        status: b.is_error ? 'error' : 'ok', result: body, endedAt: ts,
        ...(images.length ? { images } : {}),
      });
      // The line tracks one call. Parallel calls settle in any order, so a result for the one on
      // display hands the line to whichever call in the same group is still open — clearing it
      // outright said 运行中 while a sibling was genuinely running. A result for a call NOT on
      // display changes nothing: the display already points at newer work.
      const shown = d.live.running;
      if (call && at && shown && shown.toolUseId === id) {
        const group = d.items[at.i];
        const open = group.kind === 'tools'
          ? [...group.calls].reverse().find((c) => c.status === 'running' || c.status === 'awaiting')
          : undefined;
        d.live.running = open
          ? { toolUseId: open.toolUseId, name: open.name, arg: toolArg(open.name, open.input), since: open.startedAt ?? shown.since }
          : undefined;
      }
    }
  }
  return d;
}

/**
 * Drop the live "work is happening" flags — everything the activity line reads. Kept separate
 * from the transcript cleanup below because `post_turn_summary` may stop the spinner but must
 * never settle a tool card: only a real `tool_result` (or `result`) knows how a call ended.
 */
function idle(d: Draft): void {
  d.live.busy = false;
  d.live.running = undefined;
  d.live.thinking = false;
  d.live.thinkingTokens = undefined;
  d.live.compacting = false;
}

/** Wind the turn down: nothing, live or rendered, may keep claiming to be in flight. */
function endTurn(d: Draft, failed = false): void {
  idle(d);
  d.live.permission = undefined;
  for (let i = 0; i < d.items.length; i++) {
    const it = d.items[i];
    if (it.kind !== 'tools') continue;
    if (!it.calls.some((c) => c.status === 'running' || c.status === 'awaiting')) continue;
    d.items[i] = { ...it, calls: it.calls.map((c) => (c.status === 'running' || c.status === 'awaiting' ? { ...c, status: failed ? 'error' : 'ok' } : c)) };
  }
  for (let i = 0; i < d.items.length; i++) {
    const it = d.items[i];
    if (it.kind === 'prose' && it.streaming) d.items[i] = { ...it, streaming: false };
    if (it.kind === 'thinking' && it.streaming) d.items[i] = { ...it, streaming: false };
  }
}

function result(d: Draft, p: any): TranscriptState {
  const failed = p.subtype && p.subtype !== 'success';
  endTurn(d, failed);
  if (failed) {
    push(d, { kind: 'error', title: String(p.subtype), detail: typeof p.result === 'string' ? p.result : undefined });
  }
  return d;
}

function controlRequest(d: Draft, p: any): TranscriptState {
  const req = p.request;
  if (req?.subtype !== 'can_use_tool') return d;
  const requestId = String(p.request_id ?? '');
  const toolUseId = typeof req.tool_use_id === 'string' ? req.tool_use_id : undefined;

  if (req.tool_name === QUESTION_TOOL) {
    const questions = Array.isArray(req.input?.questions) ? req.input.questions : [];
    if (!questions.length) return d;
    if (d.items.some((i) => i.kind === 'question' && i.requestId === requestId)) return d;
    push(d, { kind: 'question', requestId, toolUseId, questions });
    return d;
  }
  if (req.tool_name === PLAN_EXIT_TOOL) {
    // `plan` is injected from the plan file by the CLI, so in practice it is always there — but a
    // plan-less ask is still an ask, and dropping it would block the worker forever. Falling back
    // to the generic sheet is the honest answer: it can at least be allowed or denied.
    const plan = typeof req.input?.plan === 'string' ? req.input.plan : '';
    if (plan.trim()) {
      if (d.items.some((i) => i.kind === 'plan' && i.requestId === requestId)) return d;
      const planFilePath = typeof req.input?.planFilePath === 'string' ? req.input.planFilePath : undefined;
      push(d, { kind: 'plan', requestId, toolUseId, plan, planFilePath });
      return d;
    }
  }
  if (toolUseId) patchCall(d, toolUseId, { status: 'awaiting' });
  d.live.permission = {
    requestId, toolUseId,
    toolName: String(req.tool_name ?? 'Tool'),
    displayName: typeof req.display_name === 'string' ? req.display_name : undefined,
    input: req.input,
    // Real requests carry `description`; `decision_reason` is the control-schema's name for the
    // same thing and was never seen on the wire — reading only that left the sheet with no reason.
    reason: str(req.description) ?? str(req.decision_reason),
    suggestions: Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [],
  };
  return d;
}

/**
 * The child withdrew a request we may still be showing. In practice this is the same permission
 * being answered in the terminal: without it the phone keeps a sheet whose answer the worker
 * would reject, and the tool row stays stuck on "等待你允许…".
 */
function controlCancel(d: Draft, p: any): TranscriptState {
  const requestId = String(p.request_id ?? '');
  if (!requestId) return d;
  if (d.live.permission?.requestId === requestId) {
    const toolUseId = d.live.permission.toolUseId;
    d.live.permission = undefined;
    // Back to 'running', not settled: the call may still be executing, and only a tool_result
    // (or the end of the turn) knows how it ended.
    if (toolUseId) patchCall(d, toolUseId, { status: 'running' });
  }
  const q = d.items.findIndex((i) => i.kind === 'question' && i.requestId === requestId && !i.answered);
  if (q >= 0) d.items[q] = { ...(d.items[q] as Extract<Item, { kind: 'question' }>), answered: { k: 'question.handledInTerminal' } };
  const pl = d.items.findIndex((i) => i.kind === 'plan' && i.requestId === requestId && !i.answered);
  if (pl >= 0) d.items[pl] = { ...(d.items[pl] as Extract<Item, { kind: 'plan' }>), answered: { k: 'question.handledInTerminal' } };
  return d;
}

/**
 * `/clear` or a compaction: the child started a new conversation under the same session. The old
 * transcript stays visible (it is what you were reading) but must not read as one conversation
 * with the next turn — and the task list belongs to the conversation that is gone.
 */
function conversationReset(d: Draft): TranscriptState {
  endTurn(d);
  d.todos = [];
  push(d, { kind: 'divider', label: { k: 'divider.reset' } });
  return d;
}

/**
 * Quota telemetry from the worker. Every sampled event said `status:'allowed'` — it reports the
 * five-hour window's state, not a refusal — so the benign case is deliberately silent: a "额度受限"
 * line above a request that went through would be a false alarm, and there were two of these in
 * 13846 events. Any other status is the one worth showing, because a limit that stops the session
 * has to be visible; it renders as a notice rather than an error card because none of the other
 * status values have been seen, and over-escalating an unknown enum is the worse mistake.
 *
 * `resetsAt` is in SECONDS (1787334600 → 2026-08-21 17:50Z), so it needs ×1000 to be a Date.
 */
function rateLimit(d: Draft, p: any): TranscriptState {
  const info = p.rate_limit_info ?? {};
  const status = str(info.status);
  if (!status || status === 'allowed') return d;
  const at = Number(info.resetsAt);
  // The ×1000 is wire semantics and belongs here. How that instant READS as a clock is not, and
  // handing it over as a `{ t }` param is what let this reducer stop naming a language at all.
  const when: Msg = Number.isFinite(at) && at > 0 ? { k: 'status.resetsAt', p: { time: { t: at } } } : '';
  const kind = str(info.rateLimitType);
  const window: Msg = kind === 'five_hour' ? { k: 'status.quotaFiveHour' } : kind ? kind : { k: 'status.quota' };
  push(d, { kind: 'status', text: { k: 'status.rateLimit', p: { window, status, when } } });
  return d;
}

function streamEvent(d: Draft, p: any, isHistory: boolean): TranscriptState {
  const e = p.event;
  const t = e?.type;
  if (t === 'content_block_delta') {
    const delta = e.delta ?? {};
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      appendStreamed(d, 'prose', delta.text);
      if (!isHistory) d.live.thinking = false;
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      appendStreamed(d, 'thinking', delta.thinking);
      if (!isHistory) d.live.thinking = true;
    }
    if (!isHistory) d.live.busy = true;
  } else if (t === 'message_stop') {
    for (let i = d.items.length - 1; i >= 0; i--) {
      const it = d.items[i];
      if ((it.kind === 'prose' || it.kind === 'thinking') && it.streaming) { d.items[i] = { ...it, streaming: false }; break; }
    }
  }
  return d;
}

// ── local (optimistic) mutations ──

/** A web-sent turn appears immediately; `queued` while the agent still holds the turn. */
export function localSend(state: TranscriptState, text: string, queued: boolean): TranscriptState {
  const d = draftOf(state);
  d.pendingWeb = d.pendingWeb.concat(text);
  push(d, { kind: 'user', text, state: queued ? 'queued' : 'sent' });
  d.live.busy = true;
  d.live.thinking = false;
  return d;
}

/** Fold our own answer into the card so it settles without waiting for the round trip. */
export function markQuestionAnswered(state: TranscriptState, requestId: string, summary: Msg): TranscriptState {
  const d = draftOf(state);
  const at = d.items.findIndex((i) => i.kind === 'question' && i.requestId === requestId);
  if (at >= 0) d.items[at] = { ...(d.items[at] as any), answered: summary };
  return d;
}

/** Fold our own plan verdict into the card, so it settles on the tap and not a round trip later. */
export function markPlanAnswered(state: TranscriptState, requestId: string, outcome: 'approved' | 'rejected', summary: Msg): TranscriptState {
  const d = draftOf(state);
  const at = d.items.findIndex((i) => i.kind === 'plan' && i.requestId === requestId);
  if (at >= 0) d.items[at] = { ...(d.items[at] as any), outcome, answered: summary };
  // `permissionMode` is deliberately NOT touched. Approving does end plan mode, but it ends it at
  // whatever the mode was BEFORE plan (the CLI restores `prePlanMode`), and that value is not on
  // this wire — guessing "default" would be wrong for anyone who entered plan mode from
  // acceptEdits. The worker re-sends `system:init` with the real mode within the same second
  // (measured), and that is what moves the indicator.
  return d;
}

/** Clear the permission sheet the moment we answer it. */
export function clearPermission(state: TranscriptState): TranscriptState {
  const d = draftOf(state);
  const p = d.live.permission;
  d.live.permission = undefined;
  if (p?.toolUseId) patchCall(d, p.toolUseId, { status: 'running' });
  return d;
}

/**
 * Does a backfill end mid-turn? The reducer deliberately never infers `busy` from history — a
 * replay is not activity — but the REPL bridge replays the whole conversation, so a turn that is
 * genuinely still in flight arrives as history too, and reopening that session must still show the
 * Stop button and the activity line.
 *
 * Scanning backwards for the last turn boundary is the same rule the server folds into the session
 * digest (src/server/store.ts, foldDigest): `result` — or a `post_turn_summary`, which is emitted
 * once the turn is over and covers the case where no `result` ever arrives — ends a turn, a user
 * message or a tool call starts or continues one, everything else is neutral. `worker_shutting_down`
 * and `conversation_reset` end it too: the child that owed us a result is gone, or has moved on to
 * a new conversation, and either way reopening the session must not show a Stop button.
 *
 * A text- or thinking-only assistant message is NEUTRAL, not activity: the worker delivers the
 * turn's final text AFTER the `result`, so most stored turns literally end on trailing prose —
 * counting it as in-flight made every reopened session show a Stop button. Mid-turn it costs
 * nothing: the scan just keeps going until it hits the user message that started the turn.
 */
export function turnActiveIn(payloads: unknown[]): boolean {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const p = payloads[i] as any;
    const t = p?.type;
    if (t === 'result' || t === 'conversation_reset') return false;
    if (t === 'system' && (p?.subtype === 'post_turn_summary' || p?.subtype === 'worker_shutting_down')) return false;
    if (t === 'user' || t === 'stream_event') return true;
    if (t === 'assistant') {
      const content = p?.message?.content;
      if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_use')) return true;
    }
  }
  return false;
}

export function reduceAll(payloads: unknown[], opts: { isHistory: boolean } = { isHistory: true }): TranscriptState {
  let s = initialState();
  for (const p of payloads) s = reduce(s, p, opts);
  return s;
}
