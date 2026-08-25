/**
 * db.test.ts — the PostgreSQL persistence layer against a REAL database.
 * Needs DATABASE_URL; without it every test here is skipped (so `npm test` still runs
 * zero-dependency for anyone who hasn't started the container).
 *
 * These tests TRUNCATE between cases, so they run in their own `ccc_test` schema — the same
 * database as the server, but never its tables. Pointing them at `public` would delete real
 * sessions.
 *
 * Run: docker compose up -d db
 *      DATABASE_URL=postgres://ccc:ccc@127.0.0.1:5432/ccc node --test test/db.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { createPool, ensureSchema, selectHistory, selectShapeStats, backfillShapes, runBackfills, type Pool } from '../src/server/db.ts';
import { verdictOf } from '../src/wire-shape.ts';
import { createControllerServer } from '../src/server/index.ts';
import { resolveImageBlob } from '../src/image-blob.ts';

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set (docker compose up -d db)';
/** Fine as a bare partition key for the Store-level tests — only the HTTP paths need an account. */
const CRED = 'test-cred-DB';
const TEST_SCHEMA = 'ccc_test'; // isolated from the server's `public` tables

let pool: Pool | undefined;
async function db(): Promise<Pool> {
  if (!pool) {
    pool = createPool(URL!, { schema: TEST_SCHEMA });
    await ensureSchema(pool, TEST_SCHEMA);
  }
  // Every test starts from a clean slate; events go with the sessions (ON DELETE CASCADE).
  // Schema-qualified so a stray search_path can never point this at production tables.
  await pool.query(`truncate ${TEST_SCHEMA}.sessions, ${TEST_SCHEMA}.environments, ${TEST_SCHEMA}.users cascade`);
  return pool;
}
test.after(async () => { await pool?.end(); });

test('write-through: env + session survive a fresh Store (restart)', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const env = await a.createEnv({ credential: CRED, machineName: 'box', dir: '/proj', branch: 'main' });
  const pushed = (await a.pushSessionWork(env.id, 'http://127.0.0.1:1'))!;
  await a.close();

  const b = new Store({ pool }); // simulates a process restart
  const loaded = await b.load();
  assert.equal(loaded.sessions, 1);
  assert.equal(loaded.envs, 1);
  const s = b.getSession(pushed.session.id)!;
  assert.ok(s, 'session came back');
  assert.equal(s.credential, CRED);
  assert.equal(s.machineName, 'box');
  assert.equal(s.dir, '/proj');
  assert.equal(s.branch, 'main');
  assert.equal(s.ingressToken, pushed.session.ingressToken, 'ingress token is stable across restart');
  assert.equal(b.sessionByIngressToken(pushed.session.ingressToken)?.id, s.id, 'token index rebuilt');
  // Runtime state must NOT come back as connected.
  assert.equal(s.wsConnected, false);
  assert.equal(s.sseRes, null);
  assert.equal(b.view(s).status, 'offline');
  // A restart invalidates in-flight leases: the work queue is memory-only by design.
  assert.equal(b.getEnv(env.id)!.queue.length, 0);
  await b.close();
});

test('meta updates and /rc sessions write through', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { title: 'box', dir: '/proj' }, 'cse_dbtest1');
  assert.equal(await a.applyEventMeta(s.id, { type: 'system', subtype: 'init', cwd: '/home/racel/app' }), true);
  await a.close();

  const b = new Store({ pool });
  await b.load();
  const loaded = b.getSession('cse_dbtest1')!;
  assert.equal(loaded.machineName, 'box');
  assert.equal(loaded.dir, '/home/racel/app', 'system:init cwd was persisted');
  assert.equal(loaded.credential, CRED);
  await b.close();
});

test('transcript persists and replays oldest-first', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { dir: '/x' });
  await a.appendEvents(s.id, [
    { type: 'user', message: { role: 'user', content: 'one' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } },
  ]);
  await a.appendEvents(s.id, [{ type: 'result', subtype: 'success' }]);
  await a.close();

  const b = new Store({ pool });
  await b.load();
  const h = (await b.historyFor(s.id)) as any[];
  assert.deepEqual(h.map((e) => e.type), ['user', 'assistant', 'result'], 'chronological');
  assert.equal(h[0].message.content, 'one', 'jsonb round-trips the payload');
  await b.close();
});

test('every stored event carries its wire shape, and old rows can be backfilled', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { dir: '/x' });
  await a.appendEvents(s.id, [
    { type: 'system', subtype: 'init', cwd: '/x' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'system', subtype: 'a_subtype_from_the_future' },
  ]);
  await a.close();

  const shapes = await selectShapeStats(pool);
  const seen = new Map(shapes.map((x) => [x.shape, x]));
  assert.deepEqual([...seen.keys()].sort(), ['assistant:[text]', 'system:a_subtype_from_the_future', 'system:init']);
  // The point of the column: the backlog is a query, and it needs no verdict stored alongside.
  assert.equal(verdictOf('system:init'), 'handled');
  assert.equal(verdictOf('system:a_subtype_from_the_future'), 'unknown');
  // A pointer back to one real payload, so inspecting an unadapted shape costs one row.
  assert.ok(seen.get('system:a_subtype_from_the_future')!.firstId > 0, 'stat carries a sample id');

  // Rows stored before the column existed: NULL until backfilled, then identical to a fresh write.
  await pool.query(`update ${TEST_SCHEMA}.events set shape = null`);
  assert.equal((await selectShapeStats(pool)).length, 1, 'all rows collapse into one <not backfilled> bucket');
  assert.equal(await backfillShapes(pool, 1000), 3, 'three rows stamped');
  assert.equal(await backfillShapes(pool, 1000), 0, 'idempotent — nothing left to do');
  assert.deepEqual(
    (await selectShapeStats(pool)).map((x) => x.shape).sort(),
    ['assistant:[text]', 'system:a_subtype_from_the_future', 'system:init'],
    'backfill reproduces exactly what insertEvents writes',
  );
});

test('the boot hook stamps old rows by itself, and says nothing when there is nothing to do', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { dir: '/x' });
  await a.appendEvents(s.id, [{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'success' }]);
  await a.close();
  // Rows as they would look on a deployment that upgraded into the shape column.
  await pool.query(`update ${TEST_SCHEMA}.events set shape = null`);

  const said: string[] = [];
  await runBackfills(pool, (m) => said.push(m));
  assert.deepEqual(
    (await selectShapeStats(pool)).map((x) => x.shape).sort(),
    ['result:success', 'system:init'],
    'a boot with unstamped rows needs no manual command',
  );
  assert.ok(said.some((m) => m.includes('2 rows')), `expected a completion line, got ${JSON.stringify(said)}`);

  said.length = 0;
  await runBackfills(pool, (m) => said.push(m));
  assert.deepEqual(said, [], 'every boot after the first is silent');
});

test('an image blob stays resolvable by its payload uuid', { skip }, async () => {
  const pool = await db();
  // The blob route resolves `<uuid>:<n>` against stored payloads, so the lookup needs an index —
  // otherwise every tapped thumbnail scans the session's history.
  const idx = await pool.query(
    `select indexname from pg_indexes where schemaname = $1 and tablename = 'events'`, [TEST_SCHEMA],
  );
  assert.ok(idx.rows.some((r: any) => r.indexname === 'events_uuid_idx'), 'no index for the blob lookup');

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { dir: '/x' });
  await a.appendEvents(s.id, [
    { type: 'user', uuid: 'uuid-with-image', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
    ] } },
    { type: 'user', uuid: 'uuid-plain', message: { role: 'user', content: 'no image here' } },
  ]);
  await a.close();

  // A restart must not lose the bytes: they are what the phone fetches when a thumbnail is tapped.
  const b = new Store({ pool });
  await b.load();
  const found = await b.eventByUuid(s.id, 'uuid-with-image');
  assert.ok(found, 'the payload behind a blob reference went missing');
  assert.deepEqual(resolveImageBlob(found, 0), { data: PNG, mediaType: 'image/png' });
  assert.equal(resolveImageBlob(found, 1), null, 'there is no second image in that payload');
  assert.equal(await b.eventByUuid(s.id, 'uuid-nobody-has'), null);

  // A reference is scoped to its session, so one account's uuid cannot read another's transcript.
  const other = await b.createReplSession(CRED, { dir: '/y' });
  assert.equal(await b.eventByUuid(other.id, 'uuid-with-image'), null, 'a reference must not cross sessions');
  await b.close();
});

test('stream_event is relayed but never stored', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { dir: '/x' });
  await a.appendEvents(s.id, [
    { type: 'stream_event', event: { delta: { text: 'to' } } },
    { type: 'stream_event', event: { delta: { text: 'ken' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'token' }] } },
  ]);
  const rows = await pool.query('select type from events where session_id = $1', [s.id]);
  assert.deepEqual(rows.rows.map((r) => r.type), ['assistant'], 'only the semantic event landed');
  // A batch of nothing but stream_events must not issue an INSERT at all.
  await a.appendEvents(s.id, [{ type: 'stream_event' }]);
  assert.equal((await pool.query('select count(*)::int c from events where session_id = $1', [s.id])).rows[0].c, 1);
  await a.close();
});

test('last_activity is batched by close(), not written per event', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { dir: '/x' });
  const created = (await pool.query('select last_activity from sessions where id = $1', [s.id])).rows[0].last_activity;

  await new Promise((r) => setTimeout(r, 15));
  a.touch(s.id); // memory only — the flush timer is 30s away
  const midway = (await pool.query('select last_activity from sessions where id = $1', [s.id])).rows[0].last_activity;
  assert.equal(midway.getTime(), created.getTime(), 'touch() did not hit the database');

  await a.close(); // flushes what accumulated
  const after = (await pool.query('select last_activity from sessions where id = $1', [s.id])).rows[0].last_activity;
  assert.ok(after.getTime() > created.getTime(), 'flush persisted the bump');
});

test('the session-list digest rides the same batch and survives a restart', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { dir: '/x' });
  await a.appendEvents(s.id, [
    { type: 'user', timestamp: '2026-08-14T10:00:00.000Z', message: { role: 'user', content: '修一下登录' } },
    { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't1' } },
  ]);
  a.touch(s.id);
  assert.equal((await pool.query('select digest from sessions where id = $1', [s.id])).rows[0].digest, null, 'digest is not written per event');
  await a.close(); // one batched UPDATE with last_activity

  const b = new Store({ pool }); // restart
  await b.load();
  const d = b.view(b.getSession(s.id)!).digest;
  assert.equal(d.prompt, '修一下登录');
  assert.equal(d.tool, 'Bash');
  assert.equal(d.toolArg, 'npm test');
  assert.equal(d.toolCalls, 1);
  // An in-flight approval dies with the process that held the request — the badge must not
  // come back stuck on after a restart.
  assert.equal(d.pendingApproval, false);
  assert.equal(d.turnActive, false);
  await b.close();
});

test('server end-to-end: /rc session + events survive a restart', { skip }, async () => {
  const pool = await db();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const s1 = await createControllerServer({ pool });
  // A real account, so the control plane accepts it — and so the restart below also proves the
  // account itself was persisted and reloaded (s2 would 401 otherwise).
  const cred = (await s1.store.createUser('dbtester', 'pw-12345678'))!.token;
  const cs = await fetch(`${s1.baseUrl}/v1/code/sessions`, {
    method: 'POST', headers: auth(cred), body: JSON.stringify({ config: { cwd: '/proj' } }),
  }).then((r) => r.json());
  const creds = await fetch(`${s1.baseUrl}/v1/code/sessions/${cs.session.id}/bridge`, {
    method: 'POST', headers: auth(cred), body: '{}',
  }).then((r) => r.json());
  await fetch(`${s1.baseUrl}/v1/code/sessions/${cs.session.id}/worker/events`, {
    method: 'POST', headers: { ...auth(creds.worker_jwt), 'content-type': 'application/json' },
    body: JSON.stringify({ events: [
      { payload: { type: 'user', message: { role: 'user', content: 'hi' } } },
      { payload: { type: 'stream_event', event: { delta: { text: 'x' } } } },
      { payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'yo' }] } } },
    ] }),
  });
  s1.close();
  await s1.store.close();

  const s2 = await createControllerServer({ pool }); // restart
  try {
    assert.equal(s2.store.userByToken(cred)?.username, 'dbtester', 'account restored');
    const list = s2.store.sessionsForCredential(cred);
    assert.equal(list.length, 1, 'session list restored');
    assert.equal(list[0].id, cs.session.id);
    const h = (await s2.store.historyFor(cs.session.id)) as any[];
    assert.deepEqual(h.map((e) => e.type), ['user', 'assistant'], 'transcript restored, no stream_event');
    assert.equal((await selectHistory(pool, cs.session.id, 1)).length, 1, 'history limit honoured');
  } finally {
    s2.close();
    await s2.store.close();
  }
});

test('deleting a session takes its whole transcript with it (ON DELETE CASCADE)', { skip }, async () => {
  const pool = await db();
  const store = new Store({ pool });
  const s = await store.createReplSession(CRED, { dir: '/x' });
  await store.appendEvents(s.id, [
    { type: 'user', message: { role: 'user', content: '删之前先写三条' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    { type: 'result', subtype: 'success', is_error: false },
  ]);
  assert.equal((await selectHistory(pool, s.id, 100)).length, 3);

  assert.equal(await store.deleteSession(s.id), 'ok');
  assert.equal((await pool.query('select 1 from sessions where id = $1', [s.id])).rowCount, 0);
  // The point of the cascade: one DELETE, and no orphaned rows keeping the conversation alive.
  assert.equal((await pool.query('select 1 from events where session_id = $1', [s.id])).rowCount, 0, '记录成了孤儿行');
  await store.close();
});

test('the retention sweep reaches rows the read cache never loaded', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const old = await a.createReplSession(CRED, { dir: '/old' });
  const keep = await a.createReplSession(CRED, { dir: '/keep' });
  await a.appendEvents(old.id, [{ type: 'user', message: { role: 'user', content: '很久以前' } }]);
  await pool.query(`update sessions set last_activity = now() - interval '30 days' where id = $1`, [old.id]);
  await a.close();

  // A load window shorter than the backdate: `old` is in PG and in nobody's cache, which is
  // exactly the case a cache-only sweep would miss forever.
  const b = new Store({ pool });
  await b.load(7);
  assert.equal(b.getSession(old.id), undefined, '前置条件：这一行不该在读缓存里');

  const gone = await b.sweepStale(7);
  assert.deepEqual(gone, [{ id: old.id, credential: CRED }]);
  assert.equal((await pool.query('select 1 from events where session_id = $1', [old.id])).rowCount, 0, '事件没跟着走');
  assert.ok(b.getSession(keep.id), '今天的会话被扫掉了');
  await b.close();
});

test('a connected session is exempt from the sweep however old PG thinks it is', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const live = await a.createReplSession(CRED, { dir: '/live' });
  await pool.query(`update sessions set last_activity = now() - interval '30 days' where id = $1`, [live.id]);
  await a.close();

  const b = new Store({ pool });
  await b.load(365); // wide enough to hold the backdated row
  // Attached, but deliberately NOT via markWsConnected: that touches the session, and the row
  // would then survive for the wrong reason. This is the case `keepIds` exists for — a child that
  // has been quiet for a month, not one that has been gone for a month.
  b.getSession(live.id)!.wsConnected = true;

  assert.deepEqual(await b.sweepStale(7), []);
  assert.equal((await pool.query('select 1 from sessions where id = $1', [live.id])).rowCount, 1, '在线会话被扫掉了');
  await b.close();
});

test('the server sweeps at boot, before it answers anything', { skip }, async () => {
  const pool = await db();
  const prev = process.env.CCC_SESSION_TTL_DAYS;
  process.env.CCC_SESSION_TTL_DAYS = '7'; // pinned: a runner with retention off would flake this
  const a = new Store({ pool });
  const stale = await a.createReplSession(CRED, { dir: '/stale' });
  await pool.query(`update sessions set last_activity = now() - interval '30 days' where id = $1`, [stale.id]);
  await a.close();

  const announced: string[] = [];
  const srv = await createControllerServer({ pool, onEvent: (e) => { if (e.type === 'session.delete') announced.push(e.sessionId); } });
  try {
    // The event matters as much as the delete: it is what makes an open web client redraw.
    assert.deepEqual(announced, [stale.id], 'boot sweep deleted without telling anyone');
    assert.equal(srv.store.getSession(stale.id), undefined);
    assert.equal((await pool.query('select 1 from sessions where id = $1', [stale.id])).rowCount, 0);
  } finally {
    srv.close();
    await srv.store.close();
    if (prev === undefined) delete process.env.CCC_SESSION_TTL_DAYS; else process.env.CCC_SESSION_TTL_DAYS = prev;
  }
});
