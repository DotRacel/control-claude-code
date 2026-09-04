/**
 * model.test.ts — the transcript reducer against REAL captured events.
 *
 * `test/fixtures/transcript-shapes.jsonl` is one instance of every payload shape a real
 * vibe-coding session produced (plus two shapes that session never hit — post_turn_summary and
 * stream_event — transcribed from docs/EVENTS.md). The assertions are invariants, not golden
 * output: what must never happen for the phone to read like Claude Code.
 *
 * Run: node --test test/model.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduce, reduceAll, initialState, localSend, turnActiveIn, type Item, type TranscriptState } from '../web/src/model.ts';
import { resultLine } from '../web/src/tools.ts';
import { verdictOf, SHAPES } from '../src/wire-shape.ts';
import { stripImageBlobs } from '../src/image-blob.ts';
// The reducer emits catalog keys, so the assertions below check descriptors (`keyOf`) and, where
// the wording is the point, render them in a named language (`say`) rather than the ambient one.
import { keyOf, say } from '../web/src/i18n/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const EVENTS: any[] = fs.readFileSync(path.join(here, 'fixtures/transcript-shapes.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const history = () => reduceAll(EVENTS, { isHistory: true });
const kinds = (s: TranscriptState) => s.items.map((i) => i.kind);
const only = <K extends Item['kind']>(s: TranscriptState, k: K) => s.items.filter((i) => i.kind === k) as Extract<Item, { kind: K }>[];

test('the fixture still covers every shape the reducer branches on', () => {
  const seen = new Set(EVENTS.map((e) => (e.type === 'system' ? `system:${e.subtype}` : e.type === 'control_request' ? `control_request:${e.request?.subtype}` : e.type)));
  for (const want of ['user', 'assistant', 'result', 'stream_event', 'control_request:can_use_tool',
    'system:init', 'system:thinking_tokens', 'system:task_started', 'system:task_notification',
    'system:background_tasks_changed', 'system:post_turn_summary',
    // shapes a real export proved the reducer was dropping (docs/HISTORY-EXPORT.md)
    'system:task_progress', 'system:task_updated', 'system:vcs_state_changed',
    'system:worker_shutting_down', 'conversation_reset', 'control_cancel_request',
    // and the three a 13846-event production census proved were undecided (npm run shape-report)
    'system:status', 'system:compact_boundary', 'rate_limit_event']) {
    assert.ok(seen.has(want), `fixture lost coverage of ${want}`);
  }
});

/**
 * The corpus is this project's memory of what production taught it. Every shape that was ever
 * adapted has a payload in the fixture, so a refactor cannot quietly un-learn one — and the check
 * is dynamic, which the list above is not: it needs no maintenance to keep covering a shape added
 * next month by `history-audit --promote`.
 */
test('nothing in the fixture is an undecided shape any more', () => {
  const s = history();
  assert.deepEqual(s.unhandled, {}, 'a shape in the corpus lost its handling');
  assert.equal(only(s, 'unknown').length, 0, 'and none of it renders as an unadapted marker');
});

test('no raw JSON ever reaches a rendered item', () => {
  const s = history();
  for (const it of s.items) {
    const texts: string[] = [];
    if (it.kind === 'user' || it.kind === 'prose' || it.kind === 'thinking') texts.push(it.text);
    // These three carry a Msg now, so they are rendered before being inspected — JSON leaking
    // through the wire-text arm is exactly what this test is looking for.
    if (it.kind === 'status') texts.push(say('en', it.text));
    if (it.kind === 'error') texts.push(say('en', it.title), it.detail ?? '');
    if (it.kind === 'bgtask') texts.push(say('en', it.description));
    for (const text of texts) {
      // `{"` or `[{` / `["` — not a bare bracket, since Claude's own copy contains lines like
      // "[Request interrupted by user]".
      assert.ok(!/^\s*[{[]\s*["{]/.test(text), `raw JSON rendered in a ${it.kind}: ${text.slice(0, 60)}`);
    }
  }
});

test('synthetic user messages never become a bubble', () => {
  const s = history();
  // The fixture contains a <local-command-caveat> and a <command-name>/clear payload.
  assert.ok(EVENTS.some((e) => typeof e.message?.content === 'string' && e.message.content.startsWith('<local-command-caveat')));
  assert.ok(EVENTS.some((e) => typeof e.message?.content === 'string' && e.message.content.startsWith('<command-name>')));
  for (const u of only(s, 'user')) {
    assert.ok(!/^</.test(u.text), `synthetic user text rendered: ${u.text.slice(0, 40)}`);
  }
});

test('every tool call is threaded to its result', () => {
  const s = history();
  const calls = only(s, 'tools').flatMap((t) => t.calls);
  assert.ok(calls.length >= 3, 'fixture should contain several tool calls');
  const settled = calls.filter((c) => c.status === 'ok' || c.status === 'error');
  assert.ok(settled.length >= 2, 'tool_results did not reach their cards');
  // A result that arrived is a string. A call the turn ended without one is settled anyway (so
  // the card cannot spin forever) and legitimately carries none — endTurn does not invent output.
  for (const c of settled) if (c.result !== undefined) assert.equal(typeof c.result, 'string');
  // One of the fixture's results is an error; it must be marked, not silently rendered as ok.
  assert.ok(calls.some((c) => c.status === 'error'), 'the is_error tool_result lost its error state');
});

test('AskUserQuestion is a question card, never a tool row', () => {
  const s = history();
  const qs = only(s, 'question');
  assert.equal(qs.length, 1);
  assert.ok(qs[0].questions.length >= 1);
  assert.ok(qs[0].questions[0].options.length >= 2, 'options must survive for the card to be answerable');
  const calls = only(s, 'tools').flatMap((t) => t.calls);
  assert.ok(!calls.some((c) => c.name === 'AskUserQuestion'), 'AskUserQuestion leaked into a tool group');
});

/**
 * Plan mode, against the payloads test/e2e-plan-mode.sh captured off a real 2.1.260 `/rc`
 * session. The generic permission sheet used to take this ask: it ran the plan through `toolArg`,
 * which truncates at 400 chars and renders monospace, and offered Allow/Deny — the exact one-tap
 * pair `requires_user_interaction:true` exists to forbid.
 */
test('ExitPlanMode is a plan card carrying the whole plan, never a permission sheet', () => {
  const s = history();
  const plans = only(s, 'plan');
  assert.equal(plans.length, 1, 'the plan ask did not become a plan card');
  const ask = EVENTS.find((e) => e.request?.tool_name === 'ExitPlanMode')!;
  assert.equal(plans[0].plan, ask.request.input.plan, 'the plan must reach the card whole — not truncated');
  assert.ok(plans[0].plan.length > 400, 'a plan this short would not prove the truncation is gone');
  assert.equal(plans[0].planFilePath, ask.request.input.planFilePath);
  const calls = only(s, 'tools').flatMap((t) => t.calls);
  assert.ok(!calls.some((c) => c.name === 'ExitPlanMode'), 'ExitPlanMode leaked into a tool group');
  assert.equal(s.live.permission, undefined, 'the plan ask must not also open the generic sheet');
});

test('an approved plan settles as approved, without printing the plan twice', () => {
  const card = only(history(), 'plan')[0];
  assert.equal(card.outcome, 'approved');
  assert.deepEqual(card.answered, { k: 'plan.approved' });
  // The wire's own result text appends the ENTIRE plan again; echoing it under the card would
  // render the plan a second time, which is what `answered` being a catalog key prevents.
  assert.ok(!say('en', card.answered!).includes('--version'), 'the tool_result text leaked into the card');
});

test('a plan ask with no tool_result stays answerable', () => {
  const withoutResult = EVENTS.filter((e) => !(e.type === 'user' && Array.isArray(e.message?.content)
    && e.message.content.some((b: any) => b.type === 'tool_result' && b.tool_use_id === 'toolu_01PlanExitFixture0001')));
  const open = only(reduceAll(withoutResult, { isHistory: true }), 'plan')[0];
  assert.equal(open.answered, undefined);
  assert.equal(open.outcome, undefined);
});

test('a plan answered in the terminal closes the card instead of stranding it', () => {
  const upTo = EVENTS.slice(0, EVENTS.findIndex((e) => e.request?.tool_name === 'ExitPlanMode') + 1);
  const s = reduceAll([...upTo, { type: 'control_cancel_request', request_id: 'req_plan_exit' }], { isHistory: true });
  assert.deepEqual(only(s, 'plan')[0].answered, { k: 'question.handledInTerminal' });
});

test('EnterPlanMode is a status line, never a tool card with an empty input', () => {
  const s = history();
  const calls = only(s, 'tools').flatMap((t) => t.calls);
  assert.ok(!calls.some((c) => c.name === 'EnterPlanMode'), 'EnterPlanMode leaked into a tool group');
  assert.ok(only(s, 'status').some((i) => keyOf(i.text) === 'plan.entered'), 'entering plan mode left no trace at all');
  // Its result is 200 words of instructions to the model. None of that belongs on screen.
  for (const it of s.items) {
    assert.ok(!JSON.stringify(it).includes('DO NOT write or edit any files yet'),
      "EnterPlanMode's instruction-shaped tool_result reached the transcript");
  }
});

/**
 * The mode is not pushed as an event of its own: the worker RE-SENDS `system:init` when it
 * changes, and on a /rc session that init carries `cwd:''` and `tools:[]`. So the same payload
 * that updates the mode must not blank out everything else the client learned.
 */
test('a re-sent init moves the permission mode and blanks nothing', () => {
  const upTo = (uuid: string) => reduceAll(EVENTS.slice(0, EVENTS.findIndex((e) => e.uuid === uuid) + 1), { isHistory: true });
  const entered = upTo('c1a7f2d0-0102-4000-8000-000000000102');
  assert.equal(entered.live.permissionMode, 'plan');
  const exited = upTo('c1a7f2d0-0106-4000-8000-000000000106');
  assert.equal(exited.live.permissionMode, 'default', 'exiting plan mode never reached the client');
  assert.ok(exited.live.slashCommands.length > 0, 'the re-sent init wiped the slash commands');
});

test('a question with a tool_result is settled; one without stays answerable', () => {
  const answered = reduceAll(EVENTS, { isHistory: true });
  // Drop the tool_result that answers it and the card must stay open — a replayed transcript
  // can legitimately carry a request the CLI is still blocked on.
  const withoutResult = EVENTS.filter((e) => !(e.type === 'user' && Array.isArray(e.message?.content)
    && e.message.content.some((b: any) => b.type === 'tool_result' && b.tool_use_id === answered.items.find((i) => i.kind === 'question')?.toolUseId)));
  const open = reduceAll(withoutResult, { isHistory: true });
  assert.equal(open.items.filter((i) => i.kind === 'question')[0]?.answered, undefined);
});

test('thinking blocks arrive textless and still produce a marker', () => {
  const block = EVENTS.find((e) => e.type === 'assistant' && e.message?.content?.some?.((b: any) => b.type === 'thinking'));
  assert.ok(block, 'fixture lost its thinking block');
  assert.equal(block.message.content.find((b: any) => b.type === 'thinking').thinking, '',
    'the data plane relays the signature only — if this ever carries text, expand the marker into prose');
  const s = history();
  assert.ok(only(s, 'thinking').length >= 1, 'a textless thinking block produced nothing at all');
});

test('adjacent tool calls merge into one group; prose splits them', () => {
  const call = (id: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } });
  let s = initialState();
  for (const p of [call('a'), call('b')]) s = reduce(s, p, { isHistory: true });
  assert.deepEqual(kinds(s), ['tools']);
  assert.equal(only(s, 'tools')[0].calls.length, 2);

  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '中间说了句话' }] } }, { isHistory: true });
  s = reduce(s, call('c'), { isHistory: true });
  assert.deepEqual(kinds(s), ['tools', 'prose', 'tools']);
});

test('streamed prose is replaced by the final message, not duplicated', () => {
  const s = history();
  const proses = only(s, 'prose').map((p) => p.text);
  assert.equal(proses.filter((t) => t === '流式第一段').length, 1, 'the streamed draft and the final message both rendered');
  assert.ok(!only(s, 'prose').some((p) => p.streaming), 'a prose item is still flagged streaming after message_stop');
});

test('history backfill never flips busy or opens a permission sheet', () => {
  const s = history();
  assert.equal(s.live.busy, false);
  // The fixture's can_use_tool is AskUserQuestion (a card), and its turn ended with a result.
  assert.equal(s.live.permission, undefined);
});

test('an unfinished turn is still recognisable in the backfill', () => {
  // The reducer keeps busy=false for history, so the view asks separately (ChatView re-derives
  // `busy` after each backfill) — otherwise reopening a running session shows no Stop button.
  // The fixture's tail deliberately shuts the session down, so the "no result yet" case is the
  // slice ending at its last assistant message.
  const midTurn = EVENTS.slice(0, EVENTS.map((e) => e.type).lastIndexOf('assistant') + 1);
  assert.equal(midTurn[midTurn.length - 1].type, 'assistant');
  assert.equal(turnActiveIn(midTurn), true, 'a turn with no result is still in flight');
  assert.equal(turnActiveIn([...midTurn, { type: 'result', subtype: 'success' }]), false);
  // The child going away, or the conversation being reset, ends the turn just as firmly: nobody
  // is left to produce the result, so the Stop button must not come back on reopen.
  assert.equal(turnActiveIn([...midTurn, { type: 'system', subtype: 'worker_shutting_down', reason: 'host_exit' }]), false);
  assert.equal(turnActiveIn([...midTurn, { type: 'conversation_reset' }]), false);
  assert.equal(turnActiveIn(EVENTS), false, 'the fixture ends with the worker shutting down');
  // Events that are not part of a turn must neither end one nor resurrect one.
  const finished = [...midTurn, { type: 'result', subtype: 'success' }, { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 12 }];
  assert.equal(turnActiveIn(finished), false);
  assert.equal(turnActiveIn([{ type: 'system', subtype: 'init' }, { type: 'keep_alive' }]), false);
  assert.equal(turnActiveIn([]), false);
});

test('a live can_use_tool opens the sheet and marks the call awaiting', () => {
  let s = initialState();
  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } }, { isHistory: false });
  s = reduce(s, {
    type: 'control_request', request_id: 'req1',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu1', input: { command: 'npm test' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }] },
  }, { isHistory: false });
  assert.equal(s.live.permission?.requestId, 'req1');
  assert.equal(s.live.permission?.suggestions.length, 1);
  assert.equal(only(s, 'tools')[0].calls[0].status, 'awaiting');

  s = reduce(s, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } }, { isHistory: false });
  assert.equal(s.live.permission, undefined, 'the sheet must close once the tool actually ran');
  assert.equal(only(s, 'tools')[0].calls[0].status, 'ok');
});

test('background tasks resolve; a task that drops off the list is done', () => {
  const s = history();
  const bg = only(s, 'bgtask');
  assert.ok(bg.length >= 1);
  assert.ok(!bg.some((b) => b.status === 'running'), 'a background task is still shown as running after the session ended');
});

test('an interrupted turn leaves nothing claiming to run', () => {
  let s = initialState();
  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'sleep 100' } }] } }, { isHistory: false });
  assert.equal(only(s, 'tools')[0].calls[0].status, 'running');
  s = reduce(s, { type: 'result', subtype: 'error_during_execution', is_error: true }, { isHistory: false });
  assert.equal(only(s, 'tools')[0].calls[0].status, 'error');
  assert.equal(s.live.busy, false);
  assert.ok(only(s, 'error').length === 1, 'a failed turn should surface, a successful one should not');
});

test('the thinking flag tracks reasoning only, not the whole turn', () => {
  const live = { isHistory: false } as const;
  let s = localSend(initialState(), '写个函数', false);
  assert.equal(s.live.thinking, false, 'a fresh turn has not reasoned yet');

  s = reduce(s, { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 40 }, live);
  assert.equal(s.live.thinking, true);
  // Prose taking over ends the reasoning, even though the turn is still busy.
  s = reduce(s, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '好的' } } }, live);
  assert.equal(s.live.thinking, false);
  assert.equal(s.live.busy, true, 'busy still spans the turn');

  // So does a tool call, which is what the activity line reports instead.
  s = reduce(s, { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 80 }, live);
  assert.equal(s.live.thinking, true);
  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }, live);
  assert.equal(s.live.thinking, false);
  assert.equal(s.live.running?.name, 'Bash');

  s = reduce(s, { type: 'result', subtype: 'success', is_error: false }, live);
  assert.equal(s.live.thinking, false);
  assert.equal(s.live.busy, false);

  // Blocks are ordered, so a message that reasoned and then answered ends on the answer.
  let t = reduce(initialState(), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '答案' }] } }, live);
  assert.equal(t.live.thinking, false);
  t = reduce(initialState(), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } }, live);
  assert.equal(t.live.thinking, true, 'a message that only reasoned is still reasoning');
});

test('a post_turn_summary ends the turn when no result arrives', () => {
  const live = { isHistory: false } as const;
  let s = localSend(initialState(), '跑测试', false);
  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }, live);
  assert.equal(s.live.busy, true);

  s = reduce(s, { type: 'system', subtype: 'post_turn_summary', status_detail: '跑完了测试' }, live);
  assert.equal(s.live.busy, false, 'the activity line must stop without a result');
  assert.equal(s.live.running, undefined);
  // But it knows nothing about how the call ended, so the card is left alone for a real result.
  assert.equal(only(s, 'tools')[0].calls[0].status, 'running');
  assert.deepEqual(only(s, 'status').map((i) => i.text), ['跑完了测试']);

  // Not a latch: a later TOOL CALL is a live turn again. Trailing prose is not — the worker
  // posts the turn's final text after the turn is over, and re-arming on it left the activity
  // line saying 运行中 forever (see 'the final text lands after the result…' below).
  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '收尾的文本' }] } }, live);
  assert.equal(s.live.busy, false, 'trailing prose must not re-arm the turn');
  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }] } }, live);
  assert.equal(s.live.busy, true);

  // The backfill rule agrees with the reducer.
  const toolMsg = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } };
  const textMsg = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '结束语' }] } };
  assert.equal(turnActiveIn([toolMsg, { type: 'system', subtype: 'post_turn_summary' }]), false);
  assert.equal(turnActiveIn([{ type: 'system', subtype: 'post_turn_summary' }, toolMsg]), true);
  assert.equal(turnActiveIn([{ type: 'system', subtype: 'post_turn_summary' }, textMsg]), false);
});

test('the final text lands after the result and must not restart the turn', () => {
  // The exact live order captured from a real session (cse_a70a91d1…): the worker delivers the
  // turn's final assistant text AFTER the result, same message id as the thinking that preceded
  // it. Re-arming busy on it kept the activity line saying 运行中 while the session sat idle.
  const live = { isHistory: false } as const;
  const seq = [
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 40 },
    { type: 'assistant', message: { role: 'assistant', id: 'msg_1', content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'result', subtype: 'success', is_error: false },
    { type: 'assistant', message: { role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: '修好了。' }] } },
  ];
  let s = localSend(initialState(), '修一下', false);
  for (const p of seq) s = reduce(s, p, live);
  assert.equal(s.live.busy, false, 'the trailing text re-armed the turn');
  assert.equal(s.live.thinking, false);
  assert.ok(only(s, 'prose').some((p) => p.text === '修好了。'), 'the trailing text must still render');
  // …and reopening the session must agree: the stored history ends on that trailing text.
  assert.equal(turnActiveIn([{ type: 'user', message: { role: 'user', content: '修一下' } }, ...seq]), false);
});

test('a result for one parallel call hands the activity line to its still-open sibling', () => {
  const live = { isHistory: false } as const;
  let s = localSend(initialState(), '并行跑', false);
  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'pa', name: 'Read', input: { file_path: '/a' } },
    { type: 'tool_use', id: 'pb', name: 'Bash', input: { command: 'sleep 5' } },
  ] } }, live);
  assert.equal(s.live.running?.name, 'Bash', 'the newest call is on display');
  // The DISPLAYED call settles first: the line falls back to the sibling still running.
  s = reduce(s, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pb', content: 'ok' }] } }, live);
  assert.equal(s.live.running?.name, 'Read', 'a sibling was still running — the line must not go quiet');
  // The last one settles: now nothing is open.
  s = reduce(s, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pa', content: 'ok' }] } }, live);
  assert.equal(s.live.running, undefined);
});

test('a successful turn leaves no marker at all', () => {
  let s = initialState();
  s = reduce(s, { type: 'result', subtype: 'success', is_error: false }, { isHistory: false });
  assert.deepEqual(kinds(s), []);
});

test('an optimistic web send is not rendered twice when the echo arrives', () => {
  let s = localSend(initialState(), '你好', false);
  assert.deepEqual(only(s, 'user').map((u) => u.text), ['你好']);
  s = reduce(s, { type: 'user', isReplay: true, message: { role: 'user', content: '你好' } }, { isHistory: false });
  assert.deepEqual(only(s, 'user').map((u) => u.text), ['你好']);
  // A turn typed in the terminal, by contrast, must show up.
  s = reduce(s, { type: 'user', isReplay: true, message: { role: 'user', content: '终端里敲的' } }, { isHistory: false });
  assert.deepEqual(only(s, 'user').map((u) => u.text), ['你好', '终端里敲的']);
});

test('a queued follow-up is marked queued while the agent holds the turn', () => {
  // A turn is armed by the user message that started it (text-only assistant prose never arms
  // one — the worker posts the final text after the turn is over).
  let s = reduce(initialState(), { type: 'user', isReplay: true, message: { role: 'user', content: '先干着' } }, { isHistory: false });
  assert.equal(s.live.busy, true);
  s = localSend(s, '再补一句', s.live.busy);
  assert.equal(only(s, 'user')[1].state, 'queued');
});

test('a queued bubble settles once the worker echoes that turn back', () => {
  let s = reduce(initialState(), { type: 'user', isReplay: true, message: { role: 'user', content: '先干着' } }, { isHistory: false });
  s = localSend(s, '再补一句', s.live.busy);
  assert.equal(only(s, 'user')[1].state, 'queued');
  // The echo is the agent saying it has taken the turn — the bubble stops being queued, and
  // is still not duplicated.
  s = reduce(s, { type: 'user', isReplay: true, message: { role: 'user', content: '再补一句' } }, { isHistory: false });
  assert.deepEqual(only(s, 'user').map((u) => [u.text, u.state]), [['先干着', 'sent'], ['再补一句', 'sent']]);
});

test('identical queued texts settle oldest-first, one echo at a time', () => {
  let s = initialState();
  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '在做了' }] } }, { isHistory: false });
  s = localSend(s, '继续', true);
  s = localSend(s, '继续', true);
  s = reduce(s, { type: 'user', isReplay: true, message: { role: 'user', content: '继续' } }, { isHistory: false });
  assert.deepEqual(only(s, 'user').map((u) => u.state), ['sent', 'queued']);
  s = reduce(s, { type: 'user', isReplay: true, message: { role: 'user', content: '继续' } }, { isHistory: false });
  assert.deepEqual(only(s, 'user').map((u) => u.state), ['sent', 'sent']);
});

test('result lines summarise instead of dumping output', () => {
  const call = (name: string, input: any, result: string) => ({ toolUseId: 't', name, input, status: 'ok' as const, result });
  // The descriptor, not the sentence: these used to pin '读了 3 行', so rewording four characters
  // of copy failed a test about summarising tool output. What matters is the key and the count.
  assert.deepEqual(resultLine(call('Read', { file_path: '/a/b.ts' }, '1\tone\n2\ttwo\n3\tthree'))!.text, { k: 'tool.readMany', p: { n: 3 } });
  // A count of 1 must pick the singular key, or English reads "Read 1 lines".
  assert.deepEqual(resultLine(call('Read', { file_path: '/a/b.ts' }, 'only one line'))!.text, { k: 'tool.readOne', p: { n: 1 } });
  // Numerals with no words around them stay a bare string — nothing here needs a language.
  assert.equal(resultLine(call('Edit', { old_string: 'a\nb', new_string: 'a\nb\nc\nd' }, ''))!.text, '+4 −2');
  assert.deepEqual(resultLine(call('Write', { content: 'x\ny' }, ''))!.text, { k: 'tool.wroteMany', p: { n: 2 } });
  assert.deepEqual(resultLine({ toolUseId: 't', name: 'Bash', input: {}, status: 'running' })!.text, { k: 'tool.running' });
  // And it is still English in the Chinese UI, which is a decision (tools.ts's copy rule), not a
  // gap in the catalog — so it is pinned in both languages.
  assert.equal(say('zh', { k: 'tool.running' }), 'Running…');
  assert.equal(say('en', { k: 'tool.running' }), 'Running…');
  const long = resultLine(call('Bash', { command: 'ls' }, 'a'.repeat(500)))!;
  // A tool's own output is wire text, so it arrives as the bare-string arm rather than a key.
  assert.equal(typeof long.text, 'string');
  assert.ok((long.text as string).length < 130, 'a result line must never carry the whole output');
});

/**
 * The two halves of what used to be one test asserting "unknown types are inert". Inertness was
 * the bug, not the invariant: a shape nobody had decided about vanished, and the only way to find
 * out was for someone to notice a hole in a transcript on their phone. What must stay true is
 * narrower — an unrecognised payload may never disturb what is already rendered — and declared
 * noise must stay genuinely free.
 */
test('declared noise is inert, and returns the same state object', () => {
  // Built here rather than from the corpus: promoting a newly discovered shape into the fixture
  // must turn exactly ONE test red (the corpus one), not every test that happens to read it.
  const before = reduceAll([
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
  ]);
  let s = before;
  for (const p of [{ type: 'keep_alive' }, { type: 'control_response', response: { subtype: 'success' } }, null, 'nope']) {
    s = reduce(s, p, { isHistory: true });
  }
  assert.equal(s, before, 'identity preserved — ChatView re-renders the transcript on every new object');
  assert.deepEqual(s.unhandled, {}, 'noise is not backlog');
});

test('an undecided shape is marked and counted, and disturbs nothing', () => {
  const before = reduceAll([
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
  ]);
  let s = reduce(before, { type: 'system', subtype: 'a_brand_new_subtype', anything: 1 }, { isHistory: true });
  s = reduce(s, { type: 'who_knows' }, { isHistory: true });

  assert.deepEqual(s.unhandled, { 'system:a_brand_new_subtype': 1, who_knows: 1 }, 'both land in the backlog');
  const marks = only(s, 'unknown');
  assert.deepEqual(marks.map((m) => m.shape), ['system:a_brand_new_subtype', 'who_knows']);
  // Everything that was already on screen is untouched, item for item.
  assert.deepEqual(kinds(s).filter((k) => k !== 'unknown'), kinds(before));
  assert.deepEqual(s.items.slice(0, before.items.length), before.items, 'earlier items are the same objects');
  assert.deepEqual(s.live, before.live, 'no live flag moved');
});

test('a run of the same undecided shape merges instead of flooding the transcript', () => {
  let s = initialState();
  for (let i = 0; i < 5; i++) s = reduce(s, { type: 'chatty_new_thing' }, { isHistory: true });
  const marks = only(s, 'unknown');
  assert.equal(marks.length, 1, 'one marker, not five');
  assert.equal(marks[0].count, 5);
  assert.deepEqual(s.unhandled, { chatty_new_thing: 5 }, 'the count is still exact');
});

test('an unhandled content block is counted but never marked — the message itself rendered', () => {
  const s = reduce(initialState(), {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }, { type: 'redacted_thinking', data: 'zz' }] },
  }, { isHistory: true });
  assert.deepEqual(kinds(s), ['prose'], 'the prose is there and no marker was added');
  assert.deepEqual(s.unhandled, { 'block:redacted_thinking': 1 });
});

test('every shape the reducer branches on is declared handled, and vice versa', () => {
  // The reducer's `case` labels and src/wire-shape.ts are two lists that must not drift. Read the
  // source rather than trusting a hand-kept copy: a new branch added without a rule would
  // otherwise render fine and still be reported as an unadapted shape by shape-report.
  const src = fs.readFileSync(path.join(here, '../web/src/model.ts'), 'utf8');
  const systemSubtypes = src.slice(src.indexOf('function system(')).match(/case '([a-z_]+)'/g) ?? [];
  for (const m of systemSubtypes) {
    const shape = `system:${m.slice(6, -1)}`;
    assert.equal(verdictOf(shape), 'handled', `${shape} has a reducer branch but is not declared handled`);
  }
  for (const [shape, rule] of Object.entries(SHAPES)) {
    if (rule.verdict === 'ignored') assert.ok(rule.why, `${shape} is ignored without saying why`);
  }
});

// ── shapes a real 6298-event export proved were being dropped (docs/HISTORY-EXPORT.md) ──

test('an image tool_result becomes an attachment, never JSON in the card', () => {
  const call = only(history(), 'tools').flatMap((t) => t.calls).find((c) => c.images?.length);
  assert.ok(call, "the fixture's Read of a screenshot lost its image");
  assert.equal(call!.images!.length, 1);
  assert.equal(call!.images![0].mediaType, 'image/png');
  assert.ok((call!.images![0].bytes ?? 0) > 0, 'the placeholder needs a size before the bytes load');
  // The whole point: 600 KB of base64 used to be stringified into this string.
  assert.equal(call!.result, '', 'an image-only result carries no text');
  assert.deepEqual(resultLine(call!)!.text, { k: 'tool.imageOne' });
});

test('a stripped image survives as a reference the card can fetch', () => {
  // What the phone actually receives: the server replaced the base64 on the way out.
  const s = reduceAll(EVENTS.map(stripImageBlobs), { isHistory: true });
  const img = only(s, 'tools').flatMap((t) => t.calls).find((c) => c.images?.length)!.images![0];
  assert.ok(img.ref, 'without a ref the image can never be loaded');
  assert.equal(img.dataUrl, undefined, 'stripped means the bytes are NOT in the transcript');
  assert.ok((img.bytes ?? 0) > 0, 'the size survives the strip so the card can show it');
});

test('a withdrawn permission request closes the sheet', () => {
  const open = reduce(initialState(), {
    type: 'control_request', request_id: 'r1',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu1', input: { command: 'git push' }, description: '命令包含 push' },
  });
  assert.equal(open.live.permission?.requestId, 'r1');
  // The observed field is `description`; reading only `decision_reason` left this empty.
  assert.equal(open.live.permission?.reason, '命令包含 push');

  const other = reduce(open, { type: 'control_cancel_request', request_id: 'someone_else' });
  assert.equal(other.live.permission?.requestId, 'r1', 'an unrelated cancel must not close the sheet');

  const cancelled = reduce(open, { type: 'control_cancel_request', request_id: 'r1' });
  assert.equal(cancelled.live.permission, undefined, 'a withdrawn request cannot stay answerable');
});

test('a withdrawn question card settles instead of waiting forever', () => {
  const asked = reduce(initialState(), {
    type: 'control_request', request_id: 'q1',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'tq1', input: { questions: [{ question: '继续吗', options: [{ label: '好' }, { label: '不' }] }] } },
  });
  assert.equal(only(asked, 'question').length, 1);
  const cancelled = reduce(asked, { type: 'control_cancel_request', request_id: 'q1' });
  assert.equal(keyOf(only(cancelled, 'question')[0].answered!), 'question.handledInTerminal');
});

test('task progress fills the card in; a matching task_updated finishes it', () => {
  const s = history();
  const task = only(s, 'bgtask').find((t) => t.taskId === 'bzendrcgd');
  assert.ok(task, 'the fixture task lost its card');
  assert.equal(task!.detail, 'Review: review:injector', 'the current step is the only news a long task gives');
  assert.deepEqual(task!.phases, ['Review', 'Verify']);
  assert.equal(task!.tools, 3);
  assert.equal(task!.ms, 2553);
  assert.equal(task!.status, 'completed', 'a matching task_updated must settle the card');

  // Progress for a task we never saw start must not invent a card out of nothing.
  const before = only(s, 'bgtask').length;
  const stray = reduce(s, { type: 'system', subtype: 'task_progress', task_id: 'never_started', description: 'x' });
  assert.equal(only(stray, 'bgtask').length, before);

  // …and a late frame must not revive a card that already finished.
  const late = reduce(s, { type: 'system', subtype: 'task_progress', task_id: 'bzendrcgd', description: '又开始了' });
  assert.equal(only(late, 'bgtask').find((t) => t.taskId === 'bzendrcgd')!.detail, 'Review: review:injector');

  // A task the worker never got to finish is neither completed nor failed. The fixture starts one
  // after the background-task list is emptied, so worker_shutting_down is what settles it.
  const orphan = only(s, 'bgtask').find((t) => t.taskId === 'wf7run');
  assert.ok(orphan, 'the fixture lost its still-running task');
  assert.equal(orphan!.status, 'interrupted', 'the worker went away mid-task');
  assert.equal(orphan!.detail, 'Verify: verify:gate-rebind', 'the step it stopped on is the useful part');
  assert.ok(!only(s, 'bgtask').some((t) => t.status === 'running'), 'nothing may still claim to run');
});

test('a conversation reset breaks the transcript and drops the task list', () => {
  assert.ok(only(history(), 'divider').some((d) => keyOf(d.label) === 'divider.reset'));

  let s = reduce(initialState(), {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: '写测试' } }] },
  });
  assert.equal(s.todos.length, 1);
  s = reduce(s, { type: 'conversation_reset', new_conversation_id: 'c2' });
  assert.equal(s.todos.length, 0, '/clear must not carry tasks into the next conversation');
  assert.equal(s.live.busy, false);
  assert.equal(only(s, 'todo').length, 1, 'the old todo card stays as history, it just stops growing');
});

test('the worker shutting down ends the turn and says so', () => {
  assert.ok(only(history(), 'divider').some((d) => keyOf(d.label)?.startsWith('divider.disconnected')));

  let s = reduce(initialState(), { type: 'user', message: { role: 'user', content: '跑一下测试' } });
  assert.equal(s.live.busy, true);
  s = reduce(s, { type: 'system', subtype: 'worker_shutting_down', reason: 'host_exit' });
  assert.equal(s.live.busy, false, 'nothing is left to finish this turn');
  assert.equal(s.live.running, undefined);
  // The reason is a nested descriptor, so a known reason is translatable rather than pasted in.
  assert.deepEqual(only(s, 'divider')[0].label, { k: 'divider.disconnectedWhy', p: { reason: { k: 'divider.hostExit' } } });

  // An unrecognised reason is the worker's own string and must survive verbatim.
  const odd = reduce(initialState(), { type: 'system', subtype: 'worker_shutting_down', reason: 'sigkill' });
  assert.deepEqual(only(odd, 'divider')[0].label, { k: 'divider.disconnectedWhy', p: { reason: 'sigkill' } });
});

test('a commit or a push is worth one status line', () => {
  assert.ok(only(history(), 'status').some((x) => say('zh', x.text) === '已提交 · main'));
  const pushed = reduce(initialState(), { type: 'system', subtype: 'vcs_state_changed', kind: 'push', branch: 'main' });
  // Structure first — the verb is ours, the branch name is git's.
  assert.deepEqual(only(pushed, 'status')[0].text, { k: 'status.vcs', p: { label: { k: 'status.pushed' }, branch: ' · main' } });
  assert.equal(say('en', only(pushed, 'status')[0].text), 'Pushed · main');
  const nameless = reduce(initialState(), { type: 'system', subtype: 'vcs_state_changed' });
  assert.equal(only(nameless, 'status').length, 0, 'a kindless event says nothing worth a line');
});

// ── shapes a 13846-event production census proved were undecided (npm run shape-report) ──

test('a compaction reports while it runs and leaves one divider with the numbers', () => {
  // The stretch matters: the sampled compactions took up to 228s, during which no tool is open and
  // the model is not reasoning, so `compacting` is the only thing that can explain the wait.
  let s = reduce(initialState(), { type: 'system', subtype: 'status', status: 'compacting' });
  assert.equal(s.live.compacting, true);
  assert.deepEqual(kinds(s), [], 'a transient flag, not a transcript line');

  s = reduce(s, { type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  assert.equal(s.live.compacting, false, 'the spinner has to stop when it lands');
  assert.deepEqual(kinds(s), [], 'the boundary carries the news, so a success says nothing twice');

  s = reduce(s, { type: 'system', subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 167265, post_tokens: 25515 } });
  // Both halves matter, so both are pinned: the descriptor the reducer chose, and the two
  // sentences a reader actually gets out of it.
  const label = only(s, 'divider')[0].label;
  assert.deepEqual(label, { k: 'divider.compacted', p: { why: { k: 'compact.auto' }, size: ' · 167k → 26k' } });
  assert.equal(say('zh', label), '上下文已压缩 · 自动 · 167k → 26k');
  assert.equal(say('en', label), 'Context compacted · auto · 167k → 26k');
  assert.equal(s.unhandled['system:status'], undefined, 'and none of it counts as backlog');
});

test('a compaction that fails is not silent, and a lost completion cannot wedge the spinner', () => {
  const failed = reduceAll([
    { type: 'system', subtype: 'status', status: 'compacting' },
    { type: 'system', subtype: 'status', status: null, compact_result: 'context_overflow' },
  ], { isHistory: true });
  assert.equal(failed.live.compacting, false);
  assert.equal(only(failed, 'error')[0].detail, 'context_overflow', 'a non-success has to surface');

  // idle() owns every live flag the activity line reads, so anything that ends a turn clears it —
  // otherwise a compaction whose completion never arrived spins for the rest of the session.
  const wedged = reduceAll([
    { type: 'system', subtype: 'status', status: 'compacting' },
    { type: 'result', subtype: 'success' },
  ], { isHistory: true });
  assert.equal(wedged.live.compacting, false);
});

test('a status notice nobody has looked at still reaches the backlog', () => {
  // `system:status` is a generic notice subtype; declaring it handled must not swallow the rest.
  const s = reduce(initialState(), { type: 'system', subtype: 'status', status: 'reticulating_splines' });
  assert.deepEqual(s.unhandled, { 'system:status:reticulating_splines': 1 });
  assert.equal(only(s, 'unknown')[0].shape, 'system:status:reticulating_splines');
});

test('a quota event is quiet while it is allowed, and speaks when it is not', () => {
  const allowed = { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1787334600 };
  const quiet = reduce(initialState(), { type: 'rate_limit_event', rate_limit_info: allowed });
  assert.deepEqual(kinds(quiet), [], 'a request that went through must not grow a 额度受限 line');
  assert.deepEqual(quiet.unhandled, {}, 'quiet by decision, not by omission');

  const hit = reduce(initialState(), { type: 'rate_limit_event',
    rate_limit_info: { ...allowed, status: 'exceeded' } });
  const line = only(hit, 'status')[0];
  assert.ok(line, 'a real limit is why the session stopped — it has to be visible');
  assert.equal(keyOf(line.text), 'status.rateLimit');
  // The window name is ours and translates; `status` is the worker's own enum and does not. The
  // reset time is a `{ t }` param, which is what removed the hardcoded 'zh-CN' from the reducer —
  // so this is asserted per language rather than as one frozen string.
  assert.match(say('zh', line.text), /5 小时额度/);
  assert.match(say('en', line.text), /5-hour quota/);
  for (const l of ['zh', 'en'] as const) assert.match(say(l, line.text), /exceeded/);
});

test('a payload carries the image twice, and both copies are stripped', () => {
  // `tool_use_result` is Claude's own record of the call and holds a second full copy of the
  // base64. Nothing here reads it, and leaving it in shipped every screenshot anyway.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const payload = {
    type: 'user', uuid: 'u-twice',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ] }] },
    tool_use_result: { type: 'image', file: { type: 'image/png', base64: PNG } },
  };
  const out = stripImageBlobs(payload);
  const wire = JSON.stringify(out);
  assert.ok(!wire.includes(PNG), 'both copies of the image must leave the wire');
  assert.ok(wire.includes('u-twice:0'), 'the content block keeps the reference the card fetches');
  // The surrounding structure survives, so nothing downstream trips over a missing field.
  assert.equal(out.tool_use_result.type, 'image');
  assert.equal(out.tool_use_result.file.type, 'image/png');
  assert.equal(JSON.stringify(payload).includes(PNG), true, 'the input is never mutated');

  // Payloads without the extra copy, or with a shape we did not expect, pass through untouched.
  assert.doesNotThrow(() => stripImageBlobs({ type: 'user', uuid: 'u2', tool_use_result: 'a string' }));
  assert.doesNotThrow(() => stripImageBlobs({ type: 'user', uuid: 'u3', tool_use_result: { file: null } }));
  const plain = { type: 'user', uuid: 'u4', message: { role: 'user', content: 'hi' } };
  assert.equal(stripImageBlobs(plain), plain, 'nothing to strip means the same object back');
});

