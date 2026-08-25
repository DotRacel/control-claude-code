/**
 * db.ts — the PostgreSQL persistence layer. Thin and explicit: a `pg.Pool`, parameterized
 * queries, no ORM.
 *
 * Division of labour with store.ts (single-instance design):
 *   PG is the source of truth for environments / sessions / events.
 *   store.ts keeps sessions+envs in an in-memory read cache (loaded here on boot, written
 *   through on every mutation), so read paths stay synchronous and never hit the database.
 *   Events are NOT cached — a multi-user server can't hold every transcript in memory — so
 *   history is a query.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { shapeOf } from '../wire-shape.ts';

export type Pool = pg.Pool;

/** An account row. `token` is the credential (凭证A) every other table is partitioned by. */
export interface UserRow {
  username: string;
  passwordHash: string;
  token: string;
  createdAt: number;
  lastLogin?: number;
}

/** Rows as store.ts's in-memory records want them (camelCase, epoch millis). */
export interface EnvRow {
  id: string;
  credential: string;
  machineName?: string;
  dir?: string;
  branch?: string;
  gitRepoUrl?: string;
  createdAt: number;
}
export interface SessionRow extends EnvRow {
  envId: string;
  ingressToken: string;
  workId: string;
  lastActivity: number;
  /** Session-list summary; shape owned by store.ts (SessionDigest). Null on rows written
   * before the column existed, or before the first event arrived. */
  digest?: unknown;
}

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * `schema` puts every connection in the pool on a different search_path, which is how the tests
 * get their own tables inside the same database — they TRUNCATE, and must never be able to wipe
 * real sessions in `public`.
 */
export function createPool(url: string, opts: { schema?: string } = {}): Pool {
  if (opts.schema && !SAFE_IDENT.test(opts.schema)) throw new Error(`unsafe schema name: ${opts.schema}`);
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30000,
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  });
  // A pool-level error (backend restart, network drop) is emitted on the pool, not on any
  // query. Without a listener Node treats it as an unhandled 'error' event and exits.
  pool.on('error', (e) => console.error(`[db] idle client error: ${e.message}`));
  return pool;
}

export async function ensureSchema(pool: Pool, schema?: string): Promise<void> {
  if (schema) {
    if (!SAFE_IDENT.test(schema)) throw new Error(`unsafe schema name: ${schema}`);
    // Must exist before any CREATE TABLE: a search_path naming only a missing schema fails
    // with "no schema has been selected to create in".
    await pool.query(`create schema if not exists ${schema}`);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ddl = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  await pool.query(ddl); // every statement is `if not exists` — safe to re-run
}

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v) || Date.now());
const opt = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Every account, with no time window — unlike sessions, an account never ages out: a token
 * issued years ago must still authenticate, and store.userByToken() is a synchronous read off
 * this cache (web-channel's upgrade handler cannot await).
 */
export async function loadUsers(pool: Pool): Promise<UserRow[]> {
  const r = await pool.query(`select username, password_hash, token, created_at, last_login from users`);
  return r.rows.map((u) => ({
    username: u.username, passwordHash: u.password_hash, token: u.token,
    createdAt: ms(u.created_at), lastLogin: u.last_login ? ms(u.last_login) : undefined,
  }));
}

/**
 * Register an account. Returns false when the username is taken — the uniqueness decision is
 * PG's, not the read cache's, so two simultaneous registrations cannot both win.
 */
export async function insertUser(pool: Pool, u: UserRow): Promise<boolean> {
  const r = await pool.query(
    `insert into users (username, password_hash, token, created_at)
     values ($1,$2,$3, to_timestamp($4/1000.0))
     on conflict (username) do nothing
     returning username`,
    [u.username, u.passwordHash, u.token, u.createdAt],
  );
  return r.rowCount === 1;
}

export async function updateLastLogin(pool: Pool, username: string, at: number): Promise<void> {
  await pool.query(`update users set last_login = to_timestamp($2/1000.0) where username = $1`, [username, at]);
}

/**
 * Load the recent working set into memory. Sessions older than the window are left in PG:
 * their ingress tokens are long dead, and a returning claude re-signs one via
 * POST /v1/code/sessions/{id}/bridge (index.ts already recreates unknown `cse_` ids), so a
 * cold session is recoverable rather than lost.
 */
export async function loadRecent(pool: Pool, windowDays: number): Promise<{ envs: EnvRow[]; sessions: SessionRow[] }> {
  const cutoff = `${windowDays} days`;
  const envs = await pool.query(
    `select id, credential, machine_name, dir, branch, git_repo_url, created_at
       from environments where created_at > now() - $1::interval`,
    [cutoff],
  );
  const sessions = await pool.query(
    `select id, credential, env_id, ingress_token, work_id, machine_name, dir, branch,
            git_repo_url, created_at, last_activity, digest
       from sessions where last_activity > now() - $1::interval
       order by last_activity desc`,
    [cutoff],
  );
  return {
    envs: envs.rows.map((r) => ({
      id: r.id, credential: r.credential, machineName: opt(r.machine_name), dir: opt(r.dir),
      branch: opt(r.branch), gitRepoUrl: opt(r.git_repo_url), createdAt: ms(r.created_at),
    })),
    sessions: sessions.rows.map((r) => ({
      id: r.id, credential: r.credential, envId: r.env_id ?? '', ingressToken: r.ingress_token,
      workId: r.work_id ?? '', machineName: opt(r.machine_name), dir: opt(r.dir),
      branch: opt(r.branch), gitRepoUrl: opt(r.git_repo_url),
      createdAt: ms(r.created_at), lastActivity: ms(r.last_activity),
      digest: r.digest ?? undefined,
    })),
  };
}

export async function upsertEnv(pool: Pool, e: EnvRow): Promise<void> {
  await pool.query(
    `insert into environments (id, credential, machine_name, dir, branch, git_repo_url, created_at)
     values ($1,$2,$3,$4,$5,$6, to_timestamp($7/1000.0))
     on conflict (id) do update set
       credential = excluded.credential, machine_name = excluded.machine_name,
       dir = excluded.dir, branch = excluded.branch, git_repo_url = excluded.git_repo_url`,
    [e.id, e.credential, e.machineName ?? null, e.dir ?? null, e.branch ?? null, e.gitRepoUrl ?? null, e.createdAt],
  );
}

export async function upsertSession(pool: Pool, s: SessionRow): Promise<void> {
  await pool.query(
    `insert into sessions (id, credential, env_id, ingress_token, work_id, machine_name, dir,
                           branch, git_repo_url, created_at, last_activity)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9, to_timestamp($10/1000.0), to_timestamp($11/1000.0))
     on conflict (id) do update set
       credential = excluded.credential, env_id = excluded.env_id,
       ingress_token = excluded.ingress_token, work_id = excluded.work_id,
       machine_name = excluded.machine_name, dir = excluded.dir, branch = excluded.branch,
       git_repo_url = excluded.git_repo_url, last_activity = excluded.last_activity`,
    [s.id, s.credential, s.envId, s.ingressToken, s.workId, s.machineName ?? null, s.dir ?? null,
      s.branch ?? null, s.gitRepoUrl ?? null, s.createdAt, s.lastActivity],
  );
}

/**
 * Batch the `last_activity` bumps that touch() accumulated (one UPDATE, not one per event).
 * The session digest changes on the same events, so it rides along in the same statement.
 */
export async function flushActivity(pool: Pool, rows: Array<{ id: string; lastActivity: number; digest?: unknown }>): Promise<void> {
  if (!rows.length) return;
  await pool.query(
    `update sessions s
        set last_activity = to_timestamp(v.ts/1000.0),
            digest = coalesce(v.digest::jsonb, s.digest)
       from (select * from unnest($1::text[], $2::float8[], $3::text[]) as t(id, ts, digest)) v
      where s.id = v.id`,
    [rows.map((r) => r.id), rows.map((r) => r.lastActivity), rows.map((r) => (r.digest === undefined ? null : JSON.stringify(r.digest)))],
  );
}

/**
 * One multi-row INSERT for everything that arrived in a single /worker/events POST.
 *
 * `shape` rides along in the same statement (no extra round trip): it is what makes the
 * unadapted-shape backlog a SQL query instead of a history export. Computed in Node with the real
 * shapeOf() rather than as a SQL expression on purpose — a second implementation of the
 * discriminator tree would be a second thing to keep in sync.
 */
export async function insertEvents(pool: Pool, sessionId: string, events: Array<{ type?: string; payload: unknown }>): Promise<void> {
  if (!events.length) return;
  await pool.query(
    `insert into events (session_id, type, payload, shape)
     select $1, t.type, t.payload::jsonb, t.shape
       from unnest($2::text[], $3::text[], $4::text[]) as t(type, payload, shape)`,
    [sessionId, events.map((e) => e.type ?? null), events.map((e) => JSON.stringify(e.payload)),
     events.map((e) => shapeOf(e.payload))],
  );
}

/** One row per payload shape this deployment has ever stored. Verdicts are applied by the caller. */
export interface ShapeStat { shape: string; count: number; firstId: number; firstSeen: string; lastSeen: string }

/**
 * The shape census, newest-activity first. `firstId` is a pointer back to one real payload, so
 * inspecting an unadapted shape costs one row instead of a dump of the whole history.
 */
export async function selectShapeStats(pool: Pool): Promise<ShapeStat[]> {
  const r = await pool.query(
    `select coalesce(shape, '<not backfilled>') as shape, count(*)::bigint as n,
            min(id)::bigint as first_id, min(created_at) as first_seen, max(created_at) as last_seen
       from events group by 1 order by n desc`,
  );
  // pg hands back a Date for timestamptz; ISO is what the callers format from.
  const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
  return r.rows.map((row: any) => ({
    shape: row.shape,
    count: Number(row.n),
    firstId: Number(row.first_id),
    firstSeen: iso(row.first_seen),
    lastSeen: iso(row.last_seen),
  }));
}

/**
 * Data backfills that run themselves on boot, so adding a derived column never needs a human to
 * remember a one-off command afterwards. `schema.sql` covers structure (every statement is
 * `if not exists`); this covers the rows that predate it.
 *
 * The pattern each one follows, and the reason for each part:
 *
 *  - **The work queue is a predicate, not a bookmark** (`shape is null`). No migration table to
 *    get out of sync, interrupting it costs nothing, and running it twice is a no-op.
 *  - **Batched, with a yield between batches.** The pool is 10 connections wide and the server is
 *    already serving; a single UPDATE over a large `events` table would hold one of them for the
 *    whole scan.
 *  - **Never fatal.** A backfill is a convenience, and a deployment that boots with some rows
 *    unstamped still works — `shape-report` just says so and offers `--backfill`.
 *  - **Silent when there is nothing to do**, which is every boot after the first.
 *
 * Two servers booting at once both scan the same rows and write the same values; the duplicated
 * work is wasted but the result is identical, so no locking.
 */
export async function runBackfills(pool: Pool, log: (msg: string) => void = () => {}): Promise<void> {
  // Deliberately modest: a batch holds that many whole payloads in memory, and one of them can be
  // a 600 KB screenshot. This runs once per deployment — throughput is not the thing to optimise.
  const BATCH = 500;
  const YIELD_MS = 25;
  let done = 0;
  try {
    for (;;) {
      const n = await backfillShapes(pool, BATCH);
      if (!n) break;
      if (!done) log('backfilling event shapes (one-time, in the background)…');
      done += n;
      await new Promise((r) => setTimeout(r, YIELD_MS));
    }
    if (done) log(`event shapes backfilled: ${done} row${done === 1 ? '' : 's'}`);
  } catch (e) {
    log(`⚠️  shape backfill stopped: ${(e as Error).message} — run: npm run shape-report -- --backfill`);
  }
}

/**
 * One batch of the shape backfill: the oldest `limit` rows with no shape yet, stamped with the
 * shape their stored payload implies. Returns how many were updated, so the caller can loop until
 * it returns 0. Idempotent — `shape is null` is the work queue, so an interrupted run just resumes.
 */
export async function backfillShapes(pool: Pool, limit: number): Promise<number> {
  const r = await pool.query(
    `select id, payload from events where shape is null order by id limit $1`,
    [limit],
  );
  if (!r.rows.length) return 0;
  await pool.query(
    `update events e set shape = v.shape
       from (select * from unnest($1::bigint[], $2::text[]) as t(id, shape)) v
      where e.id = v.id`,
    [r.rows.map((row: any) => row.id), r.rows.map((row: any) => shapeOf(row.payload))],
  );
  return r.rows.length;
}

/**
 * One event by its payload `uuid`, for the blob route: the transcript the web holds has image
 * data replaced by a `<uuid>:<n>` reference, and this is how the bytes are found again.
 * Scoped by session so a reference cannot be used to read another account's history.
 */
export async function selectEventByUuid(pool: Pool, sessionId: string, uuid: string): Promise<unknown | null> {
  const r = await pool.query(
    `select payload from events where session_id = $1 and payload->>'uuid' = $2 order by id desc limit 1`,
    [sessionId, uuid],
  );
  return r.rows.length ? r.rows[0].payload : null;
}

/** Newest `limit` events, returned oldest-first (the order the web replays them in). */
export async function selectHistory(pool: Pool, sessionId: string, limit: number): Promise<unknown[]> {
  const r = await pool.query(
    `select payload from (
       select id, payload from events where session_id = $1 order by id desc limit $2
     ) recent order by id asc`,
    [sessionId, limit],
  );
  return r.rows.map((row) => row.payload);
}

/**
 * Delete one session. Its whole transcript goes with it: `events.session_id` is
 * `references sessions(id) on delete cascade` (schema.sql), so this is one statement, not two —
 * and the history can never be orphaned by a half-finished delete.
 */
export async function deleteSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query(`delete from sessions where id = $1`, [sessionId]);
}

/**
 * The retention sweep: every session whose last activity predates `cutoff`, gone with its
 * history. `keepIds` is the set of sessions a child is currently connected to — those are exempt
 * however old their last event is, because an open SSE stream means quiet, not abandoned.
 *
 * Returns what was actually deleted (id + owner) rather than a count: the caller has to tell the
 * owning credential's web clients to redraw, and it cannot know which accounts were touched
 * without this. Rows older than the load window are in PG but not in any cache, which is exactly
 * why the WHERE clause runs here instead of over `store.sessions`.
 */
export async function deleteStaleSessions(pool: Pool, cutoff: number, keepIds: string[] = []): Promise<Array<{ id: string; credential: string }>> {
  const r = await pool.query(
    `delete from sessions
      where last_activity < to_timestamp($1/1000.0)
        and not (id = any($2::text[]))
      returning id, credential`,
    [cutoff, keepIds],
  );
  return r.rows.map((row) => ({ id: row.id, credential: row.credential }));
}
