/**
 * census-adaptation.test.ts — what a second production census found, one level below the shape.
 *
 * The hosted deployment, 2026-10-05→07: 14596 events, 4 sessions, every worker on claude 2.1.280.
 * `npm run shape-report` called it clean — 21 shapes, every one decided — and it was not. Folding
 * the history through the real reducer and measuring the items it drew turned up four failures,
 * each reproduced below from a real event id (descriptions neutralised, shapes untouched):
 *
 *   1. `system:status` carrying `permissionMode` — 37 events, every one an unadapted marker. The
 *      only one of the four the backlog could see, and only as `system:status:?`.
 *   2. foreground and subagent-owned tasks — 222 of 248 `task_started` were Bash commands, not
 *      background work, and each became a task card: 195 cards in one session, 16 of them real.
 *   3. a resumed subagent — `task_started` again under the same id, ignored, so the card said
 *      失败 for the whole of the run that followed while 313 progress frames went nowhere.
 *   4. an API error dressed as a message — `is_api_error_message`, drawn as Claude's own prose.
 *
 * Run: node --test test/census-adaptation.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, reduceAll, initialState, type Item, type TranscriptState } from '../web/src/model.ts';
import { say, keyOf } from '../web/src/i18n/index.ts';

const H = { isHistory: true } as const;
const cards = (s: TranscriptState) => s.items.filter((i) => i.kind === 'bgtask') as Extract<Item, { kind: 'bgtask' }>[];
const kinds = (s: TranscriptState) => s.items.map((i) => i.kind);
/** Carry on from a state already folded — for asserting midway through a sequence. */
const fold = (s: TranscriptState, payloads: unknown[]) => payloads.reduce<TranscriptState>((acc, p) => reduce(acc, p, H), s);

const status = (p: Record<string, unknown>) => ({ type: 'system', subtype: 'status', ...p });
const started = (p: Record<string, unknown>) => ({ type: 'system', subtype: 'task_started', ...p });
const notified = (p: Record<string, unknown>) => ({ type: 'system', subtype: 'task_notification', ...p });
const updated = (task_id: string, patch: Record<string, unknown>) => ({ type: 'system', subtype: 'task_updated', task_id, patch });
const progress = (task_id: string, description: string) =>
  ({ type: 'system', subtype: 'task_progress', task_id, description, usage: { tool_uses: 3, duration_ms: 4000, total_tokens: 900 } });
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, content: string) =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

// ── 1. the permission mode, on the status channel ──

test('a status carrying permissionMode moves the mode and draws nothing (events.id 55919)', () => {
  // The sequence around an approved plan: the mode notice lands BEFORE the re-sent init says it.
  let s = reduce(initialState(), { type: 'system', subtype: 'init', cwd: '', tools: [], permissionMode: 'plan' }, H);
  s = reduce(s, status({ status: null, permissionMode: 'bypassPermissions' }), H);
  assert.equal(s.live.permissionMode, 'bypassPermissions', 'the plan chip must not outlive the plan');
  assert.deepEqual(kinds(s), [], 'a level, not news — and mostly a repeat of the mode in force');
  assert.deepEqual(s.unhandled, {}, 'this was all 37 of the census\'s backlog entries');
});

test('the mode is read on every status, and the other values keep their own meaning', () => {
  // The schema allows `permissionMode` beside any status, so it must not be read on one arm only.
  const both = reduce(initialState(), status({ status: 'compacting', permissionMode: 'acceptEdits' }), H);
  assert.equal(both.live.permissionMode, 'acceptEdits');
  assert.equal(both.live.compacting, true);

  // `requesting` is the third value of the schema's enum, once per API request: decided, quiet.
  const req = reduce(initialState(), status({ status: 'requesting' }), H);
  assert.deepEqual(kinds(req), []);
  assert.deepEqual(req.unhandled, {});

  // A bare notice still says nothing anyone decided about, so it is still backlog.
  const bare = reduce(initialState(), status({ status: null }), H);
  assert.deepEqual(bare.unhandled, { 'system:status:?': 1 });
});

// ── 2. a task is not always background work ──

test('the main thread\'s foreground command is its tool card, not also a task card (events.id 63112)', () => {
  const s = reduceAll([
    toolUse('toolu_fg', 'Bash', { command: './gradlew :bot:test', description: 'Run the bot tests' }),
    started({ task_id: 'bj50lnnjb', task_type: 'local_bash', description: 'Run the bot tests', tool_use_id: 'toolu_fg', is_backgrounded: false }),
    notified({ task_id: 'bj50lnnjb', status: 'completed', summary: 'Run the bot tests', tool_use_id: 'toolu_fg', output_file: '' }),
    toolResult('toolu_fg', 'BUILD SUCCESSFUL'),
  ], H);
  assert.equal(cards(s).length, 0, 'the same command drawn twice');
  assert.deepEqual(kinds(s), ['tools']);
});

test('a subagent\'s commands are its own card\'s business, foreground or not', () => {
  const s = reduceAll([
    started({ task_id: 'acb9fadde9e0724dc', task_type: 'local_agent', description: 'Audit the module', tool_use_id: 'toolu_agent', is_backgrounded: true, spawn_depth: 1 }),
    started({ task_id: 'b0rc37r09', task_type: 'local_bash', description: 'Run all tests', tool_use_id: 'toolu_inner1', is_backgrounded: false, owned_by_subagent: true }),
    notified({ task_id: 'b0rc37r09', status: 'completed', summary: 'Run all tests', tool_use_id: 'toolu_inner1' }),
    started({ task_id: 'b3kn5uaky', task_type: 'local_bash', description: 'Run tests in background', tool_use_id: 'toolu_inner2', is_backgrounded: true, owned_by_subagent: true }),
    // The text echo of the inner task's end must not draw the card the structured one declined.
    { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>b3kn5uaky</task-id>\n<status>completed</status>\n<summary>Background command "Run tests in background" completed</summary>\n</task-notification>' } },
  ], H);
  assert.deepEqual(cards(s).map((c) => c.taskId), ['acb9fadde9e0724dc'], 'one card: the agent the user asked for');
});

test('a subagent\'s command moved to the background stays quiet through its end (events.id 62727)', () => {
  const s = reduceAll([
    started({ task_id: 'b0rc37r09', task_type: 'local_bash', description: 'Run all tests', tool_use_id: 'toolu_inner', is_backgrounded: false, owned_by_subagent: true }),
    updated('b0rc37r09', { is_backgrounded: true }),
    updated('b0rc37r09', { status: 'killed', end_time: 1791296439362 }),
    notified({ task_id: 'b0rc37r09', status: 'stopped', summary: 'Run all tests', tool_use_id: 'toolu_inner' }),
  ], H);
  assert.equal(cards(s).length, 0);
  assert.deepEqual(s.unhandled, {});
});

test('the main thread\'s command moved to the background earns its card then, and keeps it', () => {
  // Not in the census (both moves there were a subagent's) — the schema's own path for it:
  // "a later move to the background arrives as task_updated patch.is_backgrounded".
  let s = reduceAll([
    toolUse('toolu_fg', 'Bash', { command: 'npm run e2e', description: 'Run the e2e suite' }),
    started({ task_id: 'bq1', task_type: 'local_bash', description: 'Run the e2e suite', tool_use_id: 'toolu_fg', is_backgrounded: false }),
  ], H);
  assert.equal(cards(s).length, 0, 'foreground: the tool card is the task');
  s = fold(s, [
    updated('bq1', { is_backgrounded: true }),
    toolResult('toolu_fg', 'Command running in background with ID: bq1'),
  ]);
  assert.deepEqual(cards(s).map((c) => [say('en', c.description), c.status]), [['Run the e2e suite', 'running']]);
  s = reduce(s, notified({ task_id: 'bq1', status: 'failed', summary: 'Background command "Run the e2e suite" failed with exit code 1' }), H);
  assert.equal(cards(s).length, 1, 'the end updates that card rather than drawing another');
  assert.equal(cards(s)[0].status, 'failed');
});

test('a task the schema marks skip_transcript gets no card', () => {
  const s = reduceAll([
    started({ task_id: 'h1', task_type: 'local_agent', description: 'housekeeping', is_backgrounded: true, skip_transcript: true }),
    notified({ task_id: 'h1', status: 'completed', summary: 'done' }),
  ], H);
  assert.equal(cards(s).length, 0);
});

test('a background command of the main thread is still a card', () => {
  const s = reduce(initialState(), started({ task_id: 'b1', task_type: 'local_bash', description: 'Watch the build', is_backgrounded: true }), H);
  assert.equal(cards(s).length, 1);
});

// ── 3. a resumed subagent is a second run ──

const RATE_LIMITED = 'Agent terminated early due to an API error: API Error: Request rejected (429) · Upstream rate limit exceeded, please retry later';

test('a resumed run gets its own card, and the failed run above it stays failed (events.id 63116→63216)', () => {
  const agent = { task_id: 'adc6ed13bc685aebc', task_type: 'local_agent', description: 'Continue and verify fixes', tool_use_id: 'toolu_spawn', is_backgrounded: true, spawn_depth: 1 };
  let s = reduceAll([
    started(agent),
    progress('adc6ed13bc685aebc', 'Running Run the suite five times'),
    updated('adc6ed13bc685aebc', { status: 'failed', error: RATE_LIMITED }),
    notified({ task_id: 'adc6ed13bc685aebc', status: 'failed', summary: RATE_LIMITED, tool_use_id: 'toolu_spawn' }),
    // SendMessage("继续") to the finished agent: the same id starts over.
    started(agent),
    progress('adc6ed13bc685aebc', 'Running Check the test config'),
  ], H);
  let [first, second] = cards(s);
  assert.equal(cards(s).length, 2);
  assert.equal(first.status, 'failed', 'the first run did fail, and that stays true');
  assert.match(first.summary ?? '', /^Agent terminated early due to an API error/, 'with the reason it failed');
  assert.equal(second.status, 'running', 'it used to say 失败 for the whole of this run');
  assert.equal(second.resumed, true);
  assert.equal(second.detail, 'Running Check the test config', 'progress reaches the live run, not the finished one');
  assert.equal(first.detail, 'Running Run the suite five times', 'and leaves the old card alone');

  s = fold(s, [
    updated('adc6ed13bc685aebc', { status: 'completed' }),
    notified({ task_id: 'adc6ed13bc685aebc', status: 'completed', summary: 'Verified the handoff and fixed three defects.', tool_use_id: 'toolu_spawn' }),
  ]);
  [first, second] = cards(s);
  assert.equal(second.status, 'completed');
  assert.equal(second.summary, 'Verified the handoff and fixed three defects.');
  assert.equal(first.status, 'failed', 'a later run\'s end is not the earlier run\'s');
});

test('a completed run keeps its report when the agent is resumed (events.id 61975→62056)', () => {
  const agent = { task_id: 'acb9fadde9e0724dc', task_type: 'local_agent', description: 'Audit the module', is_backgrounded: true };
  const s = reduceAll([
    started(agent),
    notified({ task_id: 'acb9fadde9e0724dc', status: 'completed', summary: '## High\n\nFirst report.\n\n' + 'Finding.\n'.repeat(30) }),
    started(agent),
    // The text echo of the second run's end, which spells it by id like the structured one.
    { type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>acb9fadde9e0724dc</task-id>\n<status>completed</status>\n<summary>Agent "Audit the module" completed</summary>\n<result>Second report.</result>\n</task-notification>' } },
  ], H);
  const [first, second] = cards(s);
  assert.match(first.report ?? '', /First report/, 'the first report exists nowhere else on the wire');
  assert.equal(second.report, 'Second report.');
  assert.equal(second.status, 'completed');
});

test('a second start for a task still running is a duplicate, not a resume', () => {
  const agent = { task_id: 'a1', task_type: 'local_agent', description: 'Explore', is_backgrounded: true };
  const s = reduceAll([started(agent), started(agent)], H);
  assert.equal(cards(s).length, 1);
  assert.equal(cards(s)[0].resumed, undefined);
});

test('a resumed card says so, in both languages', () => {
  assert.equal(say('zh', { k: 'bgtask.resumed' }), '续跑');
  assert.equal(say('en', { k: 'bgtask.resumed' }), 'resumed');
});

// ── 4. an API error is not something Claude said ──

const API_ERROR = {
  type: 'assistant', error: 'rate_limit', is_api_error_message: true,
  message: { id: '636b8fb7-9471-4427-a288-afaf1861aea1', role: 'assistant', type: 'message', model: '<synthetic>',
    content: [{ type: 'text', text: 'API Error: Request rejected (429) · Upstream rate limit exceeded, please retry later' }] },
};

test('an API error message is an error card with the text verbatim (events.id 63118)', () => {
  const s = reduce(initialState(), API_ERROR, H);
  assert.deepEqual(kinds(s), ['error'], 'it used to be prose — Claude, apparently, saying it');
  const card = s.items[0] as Extract<Item, { kind: 'error' }>;
  assert.equal(keyOf(card.title), 'error.api');
  assert.equal(say('zh', card.title), 'API 错误');
  assert.equal(card.detail, 'API Error: Request rejected (429) · Upstream rate limit exceeded, please retry later');
});

test('a result that is_error ends the turn as failed, without a second card (events.id 63119)', () => {
  const s = reduceAll([
    toolUse('toolu_open', 'Bash', { command: 'sleep 600' }),
    API_ERROR,
    { type: 'result', subtype: 'success', is_error: true, result: '', terminal_reason: 'api_error', api_error_status: 429 },
  ], H);
  const call = (s.items.find((i) => i.kind === 'tools') as Extract<Item, { kind: 'tools' }>).calls[0];
  assert.equal(call.status, 'error', 'a call the failed turn left open did not succeed');
  assert.equal(s.items.filter((i) => i.kind === 'error').length, 1, 'the message already said why');
});
