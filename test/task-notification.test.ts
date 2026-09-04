/**
 * task-notification.test.ts — the `<task-notification>` user echo becomes a card, never a bubble.
 *
 * When a background task finishes, claude injects a queued command that reaches the wire as a plain
 * `user` message whose text IS the raw `<task-notification>…` XML (isMeta unset, so nothing else
 * hides it). The official client never renders it as a turn; the web must not either. Every string
 * below is a real echo captured from ~/.claude transcripts (2.1.238–2.1.260), trimmed only in the
 * <result> body — the family is agent/command completions, the multi-task "stopped" resume sweep,
 * Monitor events, and the fork-source session notice.
 *
 * Run: node --test test/task-notification.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, reduceAll, initialState, type Item, type TranscriptState } from '../web/src/model.ts';
import { cleanUserText } from '../src/transcript-text.ts';
import { say } from '../web/src/i18n/index.ts';

const H = { isHistory: true } as const;
const userEcho = (content: string) => ({ type: 'user', message: { role: 'user', content } });
const taskStarted = (task_id: string, description: string, task_type = 'local_agent') =>
  ({ type: 'system', subtype: 'task_started', task_id, task_type, description, tool_use_id: 'toolu_x' });
const bgtasks = (s: TranscriptState) => s.items.filter((i) => i.kind === 'bgtask') as Extract<Item, { kind: 'bgtask' }>[];
const bubbles = (s: TranscriptState) => s.items.filter((i) => i.kind === 'user') as Extract<Item, { kind: 'user' }>[];

const AGENT_DONE = `<task-notification>
<task-id>a6995fe2d2e60f3fa</task-id>
<tool-use-id>toolu_01326zYzWbazoCnvHZPEigVJ</tool-use-id>
<output-file>/tmp/claude-1000/-home-racel-capgate/ee63d6d1/tasks/a6995fe2d2e60f3fa.output</output-file>
<status>completed</status>
<summary>Agent "配置状态栏" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own.</note>
<result>Configured. Summary of changes: created the statusline script and wired it in.</result>
<usage><subagent_tokens>11272</subagent_tokens><tool_uses>4</tool_uses><duration_ms>58126</duration_ms></usage>
</task-notification>`;

const CMD_FAILED = `<task-notification>
<task-id>bwlckg2n0</task-id>
<tool-use-id>toolu_014B3jhvB1ZMt1mzZRoSRfQE</tool-use-id>
<output-file>/tmp/claude-1000/-home-racel-capture-the-flag/afb1b80d/tasks/bwlckg2n0.output</output-file>
<status>failed</status>
<summary>Background command "Comprehensive Redis recon" failed with exit code 144</summary>
</task-notification>`;

const STOPPED = `<task-notification>
<task-id>b2zcdawx5</task-id>
<task-id>bi8zimi81</task-id>
<task-id>__orphan_summary__:shell</task-id>
<status>stopped</status>
<summary>2 background shell command task(s) from the previous session have no completion record. They have been marked stopped. Task ids: b2zcdawx5, bi8zimi81.</summary>
</task-notification>`;

const MONITOR = `<task-notification>
<task-id>bs3hdapj4</task-id>
<summary>Monitor event: "v1.3.3 docker release build"</summary>
<event>v1.3.3 docker build finished: completed success</event>
</task-notification>`;

const FORK = `<task-notification>
<fork-source>
This session began as a fork (copy) of another session that is still running: a session whose self-reported name is 'capgate-ui-ux-polish'.
</fork-source>
</task-notification>`;

test('a task-notification echo never renders as a user bubble', () => {
  for (const raw of [AGENT_DONE, CMD_FAILED, STOPPED, MONITOR, FORK]) {
    const s = reduce(initialState(), userEcho(raw), H);
    assert.equal(bubbles(s).length, 0, `echo leaked a bubble: ${raw.slice(0, 40)}`);
    for (const b of bubbles(s)) assert.ok(!/task-notification/.test(b.text));
  }
  // cleanUserText is the shared filter the server's session-list digest also uses.
  assert.equal(cleanUserText(AGENT_DONE), null);
  assert.equal(cleanUserText(FORK), null);
});

test('an agent-done echo completes its card and shows the outcome summary', () => {
  const s = reduceAll([taskStarted('a6995fe2d2e60f3fa', '配置状态栏'), userEcho(AGENT_DONE)], H);
  const cards = bgtasks(s);
  assert.equal(cards.length, 1, 'the echo must update the existing card, not add a second');
  assert.equal(cards[0].status, 'completed');
  assert.equal(cards[0].summary, 'Agent "配置状态栏" finished');
  assert.equal(say('en', cards[0].description), '配置状态栏', 'the task name from task_started is kept');
});

test('a failed background command surfaces its failure even with no prior card', () => {
  const s = reduce(initialState(), userEcho(CMD_FAILED), H);
  const cards = bgtasks(s);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'failed');
  assert.match(say('en', cards[0].description), /failed with exit code 144/);
});

test('the resume "stopped" sweep marks every real task interrupted, skipping orphan markers', () => {
  const s = reduceAll([taskStarted('b2zcdawx5', 'shell A', 'local_bash'), taskStarted('bi8zimi81', 'shell B', 'local_bash'), userEcho(STOPPED)], H);
  const cards = bgtasks(s);
  assert.equal(cards.length, 2, '__orphan_summary__ ids must not become cards');
  assert.ok(cards.every((c) => c.status === 'interrupted'));
});

test('a Monitor event is an informational line and never ends the still-running monitor', () => {
  // The Monitor keeps watching after an event fires: no <status>, so the card must NOT flip to done.
  const s = reduceAll([taskStarted('bs3hdapj4', 'watch the release build', 'local_bash'), userEcho(MONITOR)], H);
  const cards = bgtasks(s);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'running', 'an event notification must not terminate a live monitor');
  const status = s.items.filter((i) => i.kind === 'status') as Extract<Item, { kind: 'status' }>[];
  assert.equal(status.length, 1);
  assert.match(say('en', status[0].text), /docker build finished/);
});

test('a fork-source notice is a faint status line, not a bubble or a phantom card', () => {
  const s = reduce(initialState(), userEcho(FORK), H);
  assert.equal(bgtasks(s).length, 0, 'fork-source has no task id — it must not fabricate a card');
  assert.equal(bubbles(s).length, 0);
  const status = s.items.filter((i) => i.kind === 'status') as Extract<Item, { kind: 'status' }>[];
  assert.equal(status.length, 1);
  assert.match(say('en', status[0].text), /forked/);
});
