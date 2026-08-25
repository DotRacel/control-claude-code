/**
 * web-channel.test.ts — what the phone is allowed to send back, and what the session list is
 * told without subscribing.
 *
 * The permission shape matters more than it looks: the 2.1.232 worker validates a bridge
 * permission response against `{behavior, updatedInput?, updatedPermissions?, message?}` and
 * silently DROPS the whole updatedPermissions array if one entry is malformed — which would
 * turn a user's "Always allow" into a one-off allow with no error anywhere. So the server
 * filters entries itself instead of trusting the browser.
 *
 * Run: node --test test/web-channel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControllerServer, type ControllerServer } from '../src/server/index.ts';
import { attachWebChannel } from '../src/server/web-channel.ts';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A server with the web channel attached, a session, and a fake child on the SSE data-plane. */
async function withLoop(fn: (ctx: {
  server: ControllerServer;
  cred: string;
  sid: string;
  ws: WebSocket;
  frames: () => any[];
  post: (payloads: unknown[]) => Promise<void>;
  sessionsFrame: () => any[];
  /** Close the child's SSE stream and wait for the server to notice — i.e. take the session
   * offline, which is the state in which it becomes deletable. */
  dropChild: () => Promise<void>;
}) => Promise<void>) {
  const server = await createControllerServer({ onEvent: (e) => web.handleEvent(e) });
  const web = attachWebChannel(server.server, server, server.store);
  try {
    // /ws/client only accepts a token that belongs to an account, so the session's owner has
    // to be a real one.
    const cred = (await server.store.createUser('webtester', 'pw-12345678'))!.token;
    const s = await server.store.createReplSession(cred, { dir: '/proj', title: 'box' });
    const ac = new AbortController();
    const sse = await fetch(`${server.baseUrl}/v1/code/sessions/${s.id}/worker/events/stream`, { headers: auth(s.ingressToken), signal: ac.signal });
    const chunks: string[] = [];
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(dec.decode(value)); } })().catch(() => {});

    let sessions: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/client?credential=${cred}`);
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === 'sessions') sessions = m.sessions; };
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws')); });
    await sleep(50);

    await fn({
      server, cred, sid: s.id, ws,
      frames: () => chunks.join('').split('\n').filter((l) => l.startsWith('data: '))
        .map((l) => { try { return JSON.parse(l.slice(6)).payload; } catch { return null; } }).filter(Boolean),
      post: async (payloads) => {
        await fetch(`${server.baseUrl}/v1/code/sessions/${s.id}/worker/events`, {
          method: 'POST', headers: auth(s.ingressToken),
          body: JSON.stringify({ worker_epoch: 1, events: payloads.map((p) => ({ payload: p })) }),
        });
        await sleep(40);
      },
      sessionsFrame: () => sessions,
      dropChild: async () => { ac.abort(); await sleep(80); },
    });
    ac.abort();
    ws.close();
  } finally { server.close(); }
}

test('an allow carries updatedInput and updatedPermissions through to the child', async () => {
  await withLoop(async ({ sid, ws, frames }) => {
    const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' };
    ws.send(JSON.stringify({
      type: 'permission_response', sessionId: sid, requestId: 'rq1', behavior: 'allow',
      updatedInput: { questions: [{ question: '继续吗' }], answers: { 继续吗: '是' } },
      updatedPermissions: [suggestion],
    }));
    await sleep(60);
    const cr = frames().find((p: any) => p.type === 'control_response');
    assert.ok(cr, 'no control_response reached the child');
    assert.equal(cr.response.request_id, 'rq1');
    assert.deepEqual(cr.response.response, {
      behavior: 'allow',
      updatedInput: { questions: [{ question: '继续吗' }], answers: { 继续吗: '是' } },
      updatedPermissions: [suggestion],
    });
  });
});

test('a browser cannot smuggle extra keys, and a malformed rule is dropped, not forwarded', async () => {
  await withLoop(async ({ sid, ws, frames }) => {
    ws.send(JSON.stringify({
      type: 'permission_response', sessionId: sid, requestId: 'rq2', behavior: 'deny',
      message: '不要跑这个',
      updatedInput: 'not-an-object',           // wrong type → dropped
      updatedPermissions: [{ type: 'nonsense' }, 'nope'], // unknown type → whole array dropped
      toolName: 'Bash', evil: { rm: '-rf' },   // not part of the contract → never forwarded
    }));
    await sleep(60);
    const cr = frames().find((p: any) => p.type === 'control_response');
    assert.ok(cr);
    assert.deepEqual(cr.response.response, { behavior: 'deny', message: '不要跑这个' });
  });
});

test('an empty updatedInput is omitted (the worker treats {} as absent anyway)', async () => {
  await withLoop(async ({ sid, ws, frames }) => {
    ws.send(JSON.stringify({ type: 'permission_response', sessionId: sid, requestId: 'rq3', behavior: 'allow', updatedInput: {} }));
    await sleep(60);
    const cr = frames().find((p: any) => p.type === 'control_response');
    assert.deepEqual(cr.response.response, { behavior: 'allow' });
  });
});

test('the session list gets a digest without subscribing to the transcript', async () => {
  await withLoop(async ({ sid, post, sessionsFrame, server }) => {
    await post([
      { type: 'system', subtype: 'init', model: 'claude-opus-5', permissionMode: 'default', cwd: '/proj' },
      { type: 'user', timestamp: '2026-08-14T10:00:00.000Z', message: { role: 'user', content: '修一下登录' } },
      { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } },
    ]);
    let d = server.store.view(server.store.getSession(sid)!).digest;
    assert.equal(d.prompt, '修一下登录');
    assert.equal(d.tool, 'Bash');            // raw wire name; the web maps it for display
    assert.equal(d.toolArg, 'npm test');
    assert.equal(d.toolStatus, 'running');
    assert.equal(d.toolCalls, 1);
    assert.equal(d.model, 'claude-opus-5');
    assert.equal(d.turnActive, true);
    assert.ok(d.toolStartedAt! > 0);

    await post([{ type: 'control_request', request_id: 'rq', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu1' } }]);
    assert.equal(server.store.view(server.store.getSession(sid)!).digest.pendingApproval, true);

    // Answering clears the badge immediately, without waiting for the tool to finish.
    server.sendControlResponse(sid, 'rq', 'allow');
    assert.equal(server.store.view(server.store.getSession(sid)!).digest.pendingApproval, false);

    await post([
      { type: 'user', timestamp: '2026-08-14T10:00:09.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ]);
    d = server.store.view(server.store.getSession(sid)!).digest;
    assert.equal(d.toolStatus, 'ok');
    assert.equal(d.turnActive, false);

    // …and the phone sees it: the list frame is pushed on session changes.
    await sleep(30);
    assert.ok(sessionsFrame().some((s: any) => s.id === sid && s.digest));
  });
});

test('synthetic user messages never become the list preview', async () => {
  await withLoop(async ({ sid, post, server }) => {
    await post([{ type: 'user', message: { role: 'user', content: '真实提示' } }]);
    await post([
      { type: 'user', isSynthetic: true, message: { role: 'user', content: '<local-command-caveat>ignore me</local-command-caveat>' } },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    ]);
    assert.equal(server.store.view(server.store.getSession(sid)!).digest.prompt, '真实提示');
  });
});

/** A real 1x1 PNG. Small, but its base64 is distinctive enough to grep the wire for. */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const imageEvent = (uuid: string) => ({
  type: 'user', uuid,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_shot', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } },
  ] }] },
});

test('a phone is never sent image data — not in the backfill, not live', async () => {
  await withLoop(async ({ server, sid, ws, post }) => {
    const got: any[] = [];
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));

    // Backfill: the image is already in history when the phone subscribes.
    await post([imageEvent('uuid-backfill')]);
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
    await sleep(120);
    const history = got.find((m) => m.type === 'history');
    assert.ok(history, 'no history frame arrived');
    const backfill = JSON.stringify(history);
    assert.ok(!backfill.includes(PNG_1PX), 'the backfill must not carry base64 image data');
    assert.ok(backfill.includes('uuid-backfill:0'), 'it carries the reference the card fetches instead');

    // Live: the same must hold for an image that arrives while the phone is watching.
    got.length = 0;
    await post([imageEvent('uuid-live')]);
    await sleep(80);
    const event = got.find((m) => m.type === 'event');
    assert.ok(event, 'no live event arrived');
    const live = JSON.stringify(event);
    assert.ok(!live.includes(PNG_1PX), 'the live relay must not carry base64 either');
    assert.ok(live.includes('uuid-live:0'));

    // Stripping happens on the way out only: storage still holds the real image.
    const stored = JSON.stringify(await server.store.historyFor(sid));
    assert.ok(stored.includes(PNG_1PX), 'storage must keep the payload verbatim');
  });
});

test('a phone can fetch the image behind the reference it was given', async () => {
  await withLoop(async ({ server, cred, sid, ws, post }) => {
    const got: any[] = [];
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
    await post([imageEvent('uuid-roundtrip')]);
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
    await sleep(120);

    // Take the reference out of the transcript exactly as the card does.
    const history = got.find((m) => m.type === 'history');
    const block = history.events
      .flatMap((p: any) => (Array.isArray(p?.message?.content) ? p.message.content : []))
      .find((b: any) => b?.type === 'tool_result')
      .content.find((b: any) => b?.type === 'image');
    assert.equal(block.source.type, 'blob_ref');
    assert.ok(block.source.bytes > 0);

    // …and load it the way an <img> would: same origin, cookie only, no Authorization header.
    const url = `${server.baseUrl}/v1/blob?session=${encodeURIComponent(sid)}&ref=${encodeURIComponent(block.source.ref)}`;
    const r = await fetch(url, { headers: { cookie: `ccc_credential=${encodeURIComponent(cred)}` } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(PNG_1PX, 'base64'), 'the bytes must survive the round trip');
    assert.equal(bytes.length, block.source.bytes, 'the size the card showed was the real one');
  });
});


// ── deleting a session ──

test('a live session is not deletable: its child is holding an ingress token that would go dead', async () => {
  await withLoop(async ({ sid, ws, server }) => {
    assert.equal(server.store.getSession(sid)!.wsConnected, true, '前置条件：会话应当在线');
    ws.send(JSON.stringify({ type: 'session_delete', sessionId: sid }));
    await sleep(80);
    assert.ok(server.store.getSession(sid), '在线会话被删掉了');
  });
});

test('an offline session goes, history and all, and the list is pushed without it', async () => {
  await withLoop(async ({ sid, ws, server, post, dropChild, sessionsFrame }) => {
    await post([{ type: 'user', message: { role: 'user', content: '删我之前先记一笔' } }]);
    assert.equal(((await server.store.historyFor(sid)) as any[]).length, 1);

    await dropChild();
    assert.equal(server.store.getSession(sid)!.wsConnected, false, '前置条件：会话应当已离线');

    ws.send(JSON.stringify({ type: 'session_delete', sessionId: sid }));
    await sleep(80);
    assert.equal(server.store.getSession(sid), undefined, '会话没被删掉');
    assert.equal(((await server.store.historyFor(sid)) as any[]).length, 0, '记录还留着');
    // The row disappearing from a pushed list IS the acknowledgement — there is no reply frame.
    assert.equal(sessionsFrame().some((x: any) => x.id === sid), false, '推来的列表里还有已删除的会话');
  });
});

test('another account cannot delete a session it does not own', async () => {
  await withLoop(async ({ sid, server, dropChild }) => {
    // Offline first, so that ownership is the ONLY thing left that can refuse this.
    await dropChild();
    const other = (await server.store.createUser('intruder', 'pw-12345678'))!.token;
    const evil = new WebSocket(`ws://127.0.0.1:${server.port}/ws/client?credential=${other}`);
    await new Promise<void>((res, rej) => { evil.onopen = () => res(); evil.onerror = () => rej(new Error('ws')); });
    evil.send(JSON.stringify({ type: 'session_delete', sessionId: sid }));
    await sleep(80);
    evil.close();
    assert.ok(server.store.getSession(sid), '别人的会话被删掉了');
  });
});
