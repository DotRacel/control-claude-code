/**
 * task-adaptation.test.ts — the shapes a production database held that reached nothing on screen.
 *
 * Every fixture here is a real payload from the hosted deployment (2026-09-03→04, 5006 events).
 * The payload layer was clean — all 32 stored shapes were `handled` — so these are the failures a
 * shape census cannot see: a shape that IS handled, by a branch that draws the wrong thing.
 *
 * Three of them, each confirmed by rendering the real history:
 *
 *   1. `stopped` / `killed` — three producers, three spellings, three ad-hoc ladders. A task the
 *      user stopped was labelled 完成 by two of them and left spinning by the third.
 *   2. a subagent's `summary` is its ENTIRE report (30122 chars in that history), and it was the
 *      card's unclipped title; the `<result>` body of the text form reached nothing at all.
 *   3. `<command-name>` / `<local-command-stdout>` — dropped wholesale, so `/model` changed the
 *      model with nothing on screen to say why.
 *
 * Run: node --test test/task-adaptation.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, reduceAll, initialState, type Item, type TranscriptState } from '../web/src/model.ts';
import { taskStateOf, headlineOf } from '../src/task-status.ts';
import { slashCommandOf, localCommandOutputOf, interruptNoticeIn, userTextsFrom } from '../src/transcript-text.ts';
import { say } from '../web/src/i18n/index.ts';

const H = { isHistory: true } as const;
const userEcho = (content: string) => ({ type: 'user', message: { role: 'user', content } });
const bgtasks = (s: TranscriptState) => s.items.filter((i) => i.kind === 'bgtask') as Extract<Item, { kind: 'bgtask' }>[];
const statuses = (s: TranscriptState) => (s.items.filter((i) => i.kind === 'status') as Extract<Item, { kind: 'status' }>[]).map((i) => say('en', i.text));
const started = (task_id: string, description: string, tool_use_id = 'toolu_x') =>
  ({ type: 'system', subtype: 'task_started', task_id, task_type: 'local_agent', description, tool_use_id });
const notified = (p: Record<string, unknown>) => ({ type: 'system', subtype: 'task_notification', ...p });

// events.id 15878 — the `summary` really is the whole report; trimmed here, not reshaped.
const REPORT = 'I have everything needed. Here is the full recovery.\n\n---\n\n# 1. Deleted file: `PendingJob` entity\n\n'
  + 'The entity was removed in commit 4a1f2b9 and its table left behind.\n'.repeat(40);

// ── 1. the stop vocabulary ──

test('every word the wire uses for a stop reads as interrupted, and an unknown one is backlog', () => {
  assert.equal(taskStateOf('killed'), 'interrupted');      // system:task_updated.patch.status
  assert.equal(taskStateOf('stopped'), 'interrupted');     // system:task_notification.status
  assert.equal(taskStateOf('cancelled'), 'interrupted');
  assert.equal(taskStateOf('failed'), 'failed');
  assert.equal(taskStateOf('completed'), 'completed');
  assert.equal(taskStateOf('timed_out'), 'failed', 'nobody chose to stop it — that is a failure');
  assert.equal(taskStateOf('brand_new_word'), null, 'an undecided word must never be guessed');
});

test('a task_notification saying "stopped" does not claim the task completed (events.id 19125)', () => {
  const s = reduceAll([
    started('a35dc4dfa79989e2d', 'Validate PAT + sub-account plan'),
    notified({ task_id: 'a35dc4dfa79989e2d', status: 'stopped', summary: 'Agent "Validate PAT + sub-account plan" was stopped by user' }),
  ], H);
  assert.equal(bgtasks(s)[0].status, 'interrupted');
});

test('a task_updated patch of "killed" ends the card instead of leaving it running (events.id 19124)', () => {
  const s = reduceAll([
    started('a35dc4dfa79989e2d', 'Validate PAT + sub-account design'),
    { type: 'system', subtype: 'task_updated', task_id: 'a35dc4dfa79989e2d', patch: { status: 'killed' } },
  ], H);
  assert.equal(bgtasks(s)[0].status, 'interrupted', 'killed used to fall through to running');
});

test('the text echo spells the same stop "killed", and reads the same (events.id 19129)', () => {
  const raw = `<task-notification>
<task-id>a35dc4dfa79989e2d</task-id>
<tool-use-id>toolu_014H4UrYMKaj9BcA9k7pnUGy</tool-use-id>
<status>killed</status>
<summary>Agent "Validate PAT + sub-account plan" was stopped by user</summary>
</task-notification>`;
  const s = reduceAll([started('a35dc4dfa79989e2d', 'Validate PAT'), userEcho(raw)], H);
  assert.equal(bgtasks(s)[0].status, 'interrupted');
});

test('an unrecognised status is filed as backlog rather than folded into completed', () => {
  const s = reduce(initialState(), notified({ task_id: 't1', status: 'evaporated', summary: 'gone' }), H);
  assert.ok(Object.keys(s.unhandled).some((k) => k.includes('evaporated')), 'the new word must reach the backlog');
  assert.notEqual(bgtasks(s)[0].status, 'completed', 'and must not be reported as a clean finish');
});

// ── 2. the report that was a title ──

test('a subagent report becomes a headline plus a collapsible body, never a card title', () => {
  const s = reduce(initialState(), notified({
    task_id: 'x1', status: 'completed', tool_use_id: 'toolu_none', summary: REPORT,
  }), H);
  const card = bgtasks(s)[0];
  const title = say('en', card.description);
  assert.ok(title.length <= 101, `the title is still the whole report (${title.length} chars)`);
  assert.equal(title, 'I have everything needed. Here is the full recovery.');
  assert.equal(card.report, REPORT.trim(), 'the full text is kept — it exists nowhere else on the wire');
});

test('the card is titled by the Agent call that spawned it when there is one', () => {
  const s = reduceAll([
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_01FqAy', name: 'Agent', input: { description: 'Explore removed PendingJob system', prompt: '…' } },
    ] } },
    notified({ task_id: 'x2', status: 'completed', tool_use_id: 'toolu_01FqAy', summary: REPORT }),
  ], H);
  const card = bgtasks(s)[0];
  assert.equal(say('en', card.description), 'Explore removed PendingJob system');
  assert.equal(card.summary, 'I have everything needed. Here is the full recovery.', 'the headline becomes the outcome line');
  assert.equal(card.report, REPORT.trim());
});

test('a one-line Bash summary gets no report toggle (events.id 15742)', () => {
  const s = reduce(initialState(), notified({ task_id: 'b1', status: 'completed', summary: 'Run quarkusBuild to validate CDI wiring' }), H);
  const card = bgtasks(s)[0];
  assert.equal(say('en', card.description), 'Run quarkusBuild to validate CDI wiring');
  assert.equal(card.report, undefined, 'nothing to expand — the summary IS the line');
});

test('markdown furniture never becomes the headline (events.id 16624)', () => {
  assert.equal(headlineOf('## Answer\n\n`GET /api/project/job/pending` is handled by …'), 'Answer');
  assert.equal(headlineOf('---\n\n# Report\n\nbody'), 'Report');
  assert.equal(headlineOf(''), '');
});

test("a notification's usage counts reach the card even with no progress frame (events.id 15878)", () => {
  const s = reduce(initialState(), notified({
    task_id: 'u1', status: 'completed', summary: 'done', usage: { tool_uses: 21, duration_ms: 148758, total_tokens: 84553 },
  }), H);
  assert.equal(bgtasks(s)[0].tools, 21);
  assert.equal(bgtasks(s)[0].ms, 148758);
});

test('the text form carries its report in <result>, and its counts in <usage>', () => {
  const raw = `<task-notification>
<task-id>aac48db3ec2c820a6</task-id>
<status>completed</status>
<summary>Agent "Determine RESTEasy route priority" finished</summary>
<result>## Answer

\`GET /api/project/job/pending\` is handled by **PendingJobResource.listPending**.</result>
<usage><subagent_tokens>8420</subagent_tokens><tool_uses>3</tool_uses><duration_ms>24180</duration_ms></usage>
</task-notification>`;
  // No Agent tool_use precedes it here, so the headline titles the card (same rule as the
  // structured branch: a name from the spawning call if there is one, the outcome line if not).
  const card = bgtasks(reduce(initialState(), userEcho(raw), H))[0];
  assert.equal(say('en', card.description), 'Agent "Determine RESTEasy route priority" finished');
  assert.match(String(card.report), /PendingJobResource\.listPending/);
  assert.equal(card.tools, 3);
  assert.equal(card.ms, 24180);
});

// ── 3. the slash commands that rendered nothing ──

test('a slash command echo is parsed rather than dropped (events.id 18559)', () => {
  assert.deepEqual(
    slashCommandOf('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-fable-5-1</command-args>'),
    { name: '/model', args: 'claude-fable-5-1' },
  );
  assert.equal(slashCommandOf('just a message'), null);
  assert.equal(localCommandOutputOf('<local-command-stdout>Set model to `Opus 5`</local-command-stdout>'), 'Set model to `Opus 5`');
});

test('/model and the line it printed both reach the transcript (events.id 18559–18560)', () => {
  const s = reduceAll([
    userEcho('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>'),
    userEcho('<command-name>/model</command-name>\n  <command-args>claude-fable-5-1</command-args>'),
    userEcho('<local-command-stdout>Set model to `claude-fable-5-1` and saved as your default for new sessions</local-command-stdout>'),
  ], H);
  assert.deepEqual(statuses(s), ['/model claude-fable-5-1', 'Set model to `claude-fable-5-1` and saved as your default for new sessions']);
  assert.equal(s.items.filter((i) => i.kind === 'user').length, 0, 'the wrappers are still never bubbles');
});

test('/clear does not double the break it already has as a divider', () => {
  const paired = reduceAll([
    { type: 'conversation_reset' },
    userEcho('<command-name>/clear</command-name>\n  <command-args></command-args>'),
  ], H);
  assert.deepEqual(statuses(paired), [], 'the reset divider already marks it');
  assert.equal(paired.items.filter((i) => i.kind === 'divider').length, 1);

  // …but one that arrived without its reset (seen once in the sampled history) is not invisible.
  const orphan = reduceAll([userEcho('<command-name>/clear</command-name>\n  <command-args></command-args>')], H);
  assert.deepEqual(statuses(orphan), ['/clear']);
});

// ── 4. the flags the envelope actually sets ──

test('a post-compaction continuation replay is not a user bubble (events.id 15564 …)', () => {
  // 15 of these in the sampled history, 15628–32809 characters each, every one rendered as a
  // right-aligned bubble. The envelope marks them `isSynthetic`; `isMeta` and `isCompactSummary`
  // — the two flags the filter DID read — appeared on no payload in that history at all.
  const replay = {
    type: 'user', isSynthetic: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. ' + 'The summary below covers what was done.\n'.repeat(300) },
  };
  const s = reduce(initialState(), replay, H);
  assert.equal(s.items.filter((i) => i.kind === 'user').length, 0);
  assert.deepEqual(userTextsFrom(replay), [], 'the session-list digest must hide it too');
});

test('the compaction break is still on screen — it is the boundary that draws it', () => {
  // Each replay lands directly after its own compact_boundary, so dropping the bubble loses
  // nothing: the divider is the beat.
  const s = reduceAll([
    { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 152000, post_tokens: 31000 } },
    { type: 'user', isSynthetic: true, message: { role: 'user', content: 'This session is being continued from a previous conversation…' } },
  ], H);
  assert.equal(s.items.filter((i) => i.kind === 'divider').length, 1);
  assert.equal(s.items.filter((i) => i.kind === 'user').length, 0);
});

test('an interrupt marker is a notice, not something the owner typed (events.id 19128)', () => {
  const s = reduce(initialState(), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }, H);
  assert.equal(s.items.filter((i) => i.kind === 'user').length, 0, 'it was never typed — it must not be a bubble');
  assert.deepEqual(statuses(s), ['Interrupted by user']);
  // The tool-use variant the harness also emits.
  assert.ok(interruptNoticeIn({ message: { content: '[Request interrupted by user for tool use]' } }));
  assert.equal(interruptNoticeIn({ message: { content: 'please interrupt the deploy' } }), false);
});

test('a real typed turn is untouched by any of it', () => {
  const s = reduce(initialState(), { type: 'user', message: { role: 'user', content: '继续' } }, H);
  assert.equal(s.items.filter((i) => i.kind === 'user').length, 1);
});

test('a failed compaction shows the reason, not the word "failed" (events.id 16074)', () => {
  const s = reduce(initialState(), { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'aborted' }, H);
  const err = s.items.find((i) => i.kind === 'error') as Extract<Item, { kind: 'error' }>;
  assert.equal(err.detail, 'aborted');
  // …and a failure with no reason still says something.
  const bare = reduce(initialState(), { type: 'system', subtype: 'status', compact_result: 'failed' }, H);
  assert.equal((bare.items.find((i) => i.kind === 'error') as any).detail, 'failed');
});
