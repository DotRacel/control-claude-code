/**
 * protocol.test.ts — unit tests for the store / wire-protocol pieces (no claude needed).
 * Run: node --test test/protocol.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, encodeWorkSecret } from '../src/server/store.ts';

test('encodeWorkSecret round-trips into the v1 shape AVl() decodes', () => {
  const secret = encodeWorkSecret('tok123', 'http://127.0.0.1:9999');
  const decoded = JSON.parse(Buffer.from(secret, 'base64url').toString('utf8'));
  assert.equal(decoded.version, 1);
  assert.equal(decoded.session_ingress_token, 'tok123');
  assert.equal(decoded.api_base_url, 'http://127.0.0.1:9999');
});

test('pushSessionWork builds a valid session work item + session record', async () => {
  const store = new Store();
  const env = await store.createEnv({ credential: 'c1' });
  const r = await store.pushSessionWork(env.id, 'http://127.0.0.1:1');
  assert.ok(r);
  assert.equal(r.work.data.type, 'session');
  assert.equal(r.work.data.id, r.session.id); // work targets the session
  assert.match(r.work.id, /^work-/);
  const dec = JSON.parse(Buffer.from(r.work.secret, 'base64url').toString('utf8'));
  assert.equal(dec.session_ingress_token, r.session.ingressToken);
  assert.equal(dec.api_base_url, 'http://127.0.0.1:1');
});

test('nextWork moves queue→inflight; second poll is empty; ack clears inflight', async () => {
  const store = new Store();
  const env = await store.createEnv({ credential: 'c1' });
  await store.pushSessionWork(env.id, 'http://x');
  const w = store.nextWork(env.id);
  assert.ok(w);
  assert.equal(store.nextWork(env.id), null);
  assert.equal(env.inflight.size, 1);
  store.ackWork(env.id, w.id);
  assert.equal(env.inflight.size, 0);
});

test('sendToChild writes a well-formed client_event SSE frame', async () => {
  const store = new Store();
  const env = await store.createEnv({ credential: 'c1' });
  const r = (await store.pushSessionWork(env.id, 'http://x'))!;
  const writes: string[] = [];
  store.attachSse(r.session.id, { write: (s: string) => writes.push(s) } as any);

  const ok = store.sendToChild(r.session.id, { type: 'user', message: { role: 'user', content: 'hi' } });
  assert.equal(ok, true);
  assert.equal(writes.length, 1);

  const frame = writes[0];
  assert.match(frame, /^event: client_event\n/); // SSE event name the worker requires
  assert.match(frame, /\nid: 1\n\n$/); // sequence id + frame terminator
  const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
  const envelope = JSON.parse(dataLine.slice('data: '.length));
  assert.equal(envelope.sequence_num, 1);
  assert.equal(envelope.event_type, 'relay');
  assert.equal(envelope.payload.type, 'user');
  assert.equal(envelope.payload.message.content, 'hi');
});

test('sendToChild returns false when no SSE stream is attached', async () => {
  const store = new Store();
  const env = await store.createEnv({ credential: 'c1' });
  const r = (await store.pushSessionWork(env.id, 'http://x'))!;
  assert.equal(store.sendToChild(r.session.id, { type: 'user' }), false);
});

test('sequence_num / id increments per send', async () => {
  const store = new Store();
  const env = await store.createEnv({ credential: 'c1' });
  const r = (await store.pushSessionWork(env.id, 'http://x'))!;
  const writes: string[] = [];
  store.attachSse(r.session.id, { write: (s: string) => writes.push(s) } as any);
  store.sendToChild(r.session.id, {});
  store.sendToChild(r.session.id, {});
  assert.match(writes[0], /\nid: 1\n/);
  assert.match(writes[1], /\nid: 2\n/);
});

test('detachSse stops delivery', async () => {
  const store = new Store();
  const env = await store.createEnv({ credential: 'c1' });
  const r = (await store.pushSessionWork(env.id, 'http://x'))!;
  const writes: string[] = [];
  store.attachSse(r.session.id, { write: (s: string) => writes.push(s) } as any);
  store.detachSse(r.session.id);
  assert.equal(store.sendToChild(r.session.id, {}), false);
  assert.equal(writes.length, 0);
});

test('sessions are owned by their credential and looked up by ingress token', async () => {
  const store = new Store();
  const a = await store.createEnv({ credential: 'A', machineName: 'ma', dir: '/a' });
  const b = await store.createEnv({ credential: 'B' });
  const sa = (await store.pushSessionWork(a.id, 'http://x'))!.session;
  await store.pushSessionWork(b.id, 'http://x');
  assert.equal(store.sessionsForCredential('A').length, 1);
  assert.equal(store.sessionsForCredential('B').length, 1);
  assert.equal(sa.credential, 'A');
  assert.equal(sa.machineName, 'ma'); // inherited from env
  assert.equal(store.sessionByIngressToken(sa.ingressToken)?.id, sa.id);
  assert.equal(store.sessionByIngressToken('nope'), undefined);
  assert.equal(store.view(sa).status, 'offline'); // no SSE yet
});


// ── deletion & retention ──

test('deleteSession refuses a connected session, and forgets every trace of an offline one', async () => {
  const store = new Store();
  const env = await store.createEnv({ credential: 'A' });
  const s = (await store.pushSessionWork(env.id, 'http://x'))!.session;
  await store.appendEvents(s.id, [{ type: 'user', message: { role: 'user', content: 'hi' } }]);

  store.markWsConnected(s.id, true);
  assert.equal(await store.deleteSession(s.id), 'active', 'a live session must not be deletable');
  assert.ok(store.getSession(s.id));

  store.markWsConnected(s.id, false);
  assert.equal(await store.deleteSession(s.id), 'ok');
  assert.equal(store.getSession(s.id), undefined);
  // The ingress-token index is the one that matters: left behind, the child's old token would
  // still authenticate the data plane into a session nobody can see.
  assert.equal(store.sessionByIngressToken(s.ingressToken), undefined);
  assert.deepEqual(await store.historyFor(s.id), []);
  assert.equal(await store.deleteSession(s.id), 'missing');
});

test('the retention sweep drops idle sessions, spares fresh and connected ones, and can be turned off', async () => {
  const store = new Store();
  const env = await store.createEnv({ credential: 'A' });
  const stale = (await store.pushSessionWork(env.id, 'http://x'))!.session;
  const fresh = (await store.pushSessionWork(env.id, 'http://x'))!.session;
  const busy = (await store.pushSessionWork(env.id, 'http://x'))!.session;
  const eightDaysAgo = Date.now() - 8 * 86400_000;
  // markWsConnected touches the session, so the backdating has to come after it.
  store.markWsConnected(busy.id, true);
  stale.lastActivity = eightDaysAgo;
  busy.lastActivity = eightDaysAgo;

  assert.deepEqual(await store.sweepStale(0), [], '0 days means the sweep is off, not "delete everything"');
  assert.ok(store.getSession(stale.id));

  const gone = await store.sweepStale(7);
  assert.deepEqual(gone, [{ id: stale.id, credential: 'A' }], 'the caller needs the owner, to know whose list to redraw');
  assert.equal(store.getSession(stale.id), undefined);
  assert.ok(store.getSession(fresh.id), 'a session from today was swept');
  assert.ok(store.getSession(busy.id), 'a connected session is quiet, not stale');
});
