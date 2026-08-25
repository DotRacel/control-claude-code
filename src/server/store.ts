/**
 * store.ts — server state. Multi-tenant: every environment and session is owned by a
 * credential ("凭证A"); the web side lists/controls only its own.
 *
 * Single-instance design, so the split is:
 *   - PG (db.ts) is the source of truth for environments / sessions / events.
 *   - `envs` / `sessions` are an in-memory READ CACHE, loaded by load() on boot and written
 *     through on every mutation. Read paths therefore stay SYNCHRONOUS and never touch the
 *     database — `owns()` in web-channel.ts runs on every websocket frame.
 *   - Only mutations are async. Runtime state (sse handles, seq, connection liveness, the work
 *     queue) is memory-only by nature and never persisted.
 *   - Events are not cached (a multi-user server can't hold every transcript); history is a
 *     query. Without a pool they fall back to an in-memory ring, which is what the unit tests
 *     and the local `src/cli.ts` driver use.
 *
 * `new Store()` = pure memory (no persistence). `new Store({ pool })` = write-through to PG.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import type { ServerResponse } from 'node:http';
import {
  type Pool, type UserRow, upsertEnv, upsertSession, insertEvents, selectHistory, selectEventByUuid, flushActivity,
  loadRecent, loadUsers, insertUser, updateLastLogin,
  deleteSession as deleteSessionRow, deleteStaleSessions,
} from './db.ts';
import { userTextsFrom } from '../transcript-text.ts';
import { toolArg, HIDDEN_TOOLS } from '../tool-summary.ts';

/** Token-level deltas: high write volume, no replay value (the full `assistant` message
 * carries the final text), so they are relayed live but never stored. */
const UNSTORED_EVENT_TYPES = new Set(['stream_event']);
const HISTORY_LIMIT = 3000;
const ACTIVITY_FLUSH_MS = 30000;

export interface WorkItem {
  id: string;
  secret: string; // base64url(JSON {version:1, session_ingress_token, api_base_url})
  data: { type: 'session' | 'healthcheck'; id: string };
}

export interface EnvRecord {
  id: string;
  credential: string; // owner (凭证A)
  machineName?: string;
  dir?: string;
  branch?: string;
  gitRepoUrl?: string;
  createdAt: number;
  online: boolean; // false once the injector deregisters / bridge drops
  queue: WorkItem[]; // work not yet delivered
  inflight: Map<string, WorkItem>; // delivered, awaiting ack/stop
}

export interface SessionRecord {
  id: string; // sessionId (used in the code-sessions path)
  credential: string;
  envId: string;
  ingressToken: string; // the child authenticates the data-plane with this
  workId: string;
  // metadata (inherited from the environment) for the session list
  machineName?: string;
  dir?: string;
  branch?: string;
  gitRepoUrl?: string;
  createdAt: number;
  lastActivity: number;
  wsConnected: boolean; // child's SSE data-plane is open
  sseRes: ServerResponse | null; // server → child channel
  seq: number; // client_event sequence_num / id
  digest: SessionDigest; // derived from the event stream for the session list
  /** tool_use_ids whose can_use_tool is still unanswered. Runtime only — an in-flight
   * approval does not survive a restart (the child's request is lost with the process). */
  pendingTools: Set<string>;
  /** tool_use_id of the call the digest is currently reporting, so a late result from an
   * older call cannot overwrite the newer row. Runtime only. */
  currentToolUseId?: string;
}

/**
 * What the session list needs without subscribing to a transcript (design 1a/1h: prompt
 * preview, the running tool, a needs-approval badge, `Done · N tool calls`, model).
 * Derived incrementally in appendEvents — the single funnel every inbound payload passes.
 * Tool names are stored RAW; the web maps them through tool-summary.ts, so presentation
 * stays on the client.
 */
export interface SessionDigest {
  prompt?: string;        // last visible user prompt
  tool?: string;          // wire name of the most recent tool call
  toolArg?: string;       // its headline argument
  toolStatus?: 'running' | 'ok' | 'error';
  toolStartedAt?: number; // so the phone can render a live elapsed clock
  toolCalls: number;
  pendingApproval: boolean;
  turnActive: boolean;    // a turn is in flight (user sent, no result yet)
  model?: string;
  mode?: string;          // permissionMode
}

export const emptyDigest = (): SessionDigest => ({ toolCalls: 0, pendingApproval: false, turnActive: false });

/** `assistant` and `user` payloads carry an ISO `timestamp`; nothing else does. */
export function payloadTime(payload: any): number | undefined {
  const t = payload?.timestamp;
  if (typeof t !== 'string') return undefined;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Public shape sent to the web (no tokens / internals). */
export interface SessionView {
  id: string;
  machine?: string;
  dir?: string;
  branch?: string;
  gitRepoUrl?: string;
  status: 'active' | 'offline';
  createdAt: number;
  lastActivity: number;
  digest: SessionDigest;
}

/** Encode a bridge work secret exactly as AVl() in the target expects to decode it. */
export function encodeWorkSecret(sessionIngressToken: string, apiBaseUrl: string): string {
  const payload = { version: 1, session_ingress_token: sessionIngressToken, api_base_url: apiBaseUrl };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

// ── accounts ──

/** An account in the read cache. The password hash never leaves this file. */
export interface UserRecord {
  username: string;
  token: string;
  createdAt: number;
  lastLogin?: number;
}

/**
 * scrypt parameters. N=16384/r=8 costs ~16MB and ~50ms per hash — deliberately slow, and only
 * ever paid on register/login, never on a read path. Stored alongside the hash so raising the
 * cost later still verifies old passwords.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, saltLen: 16 };
const scrypt = (password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // maxmem must clear 128*N*r, which the default 32MB does not once N grows.
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err, dk) => (err ? reject(err) : resolve(dk)));
  });

/** `scrypt$N$r$p$salt$hash`, salt and hash base64url. */
export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, keylen, saltLen } = SCRYPT;
  const salt = crypto.randomBytes(saltLen);
  const dk = await scrypt(password, salt, N, r, p, keylen);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

/** Constant-time verify. A malformed or unknown-algorithm hash fails closed. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, sN, sr, sp, sSalt, sHash] = parts;
  const N = Number(sN), r = Number(sr), p = Number(sp);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const expected = Buffer.from(sHash, 'base64url');
  if (!expected.length) return false;
  try {
    const dk = await scrypt(password, Buffer.from(sSalt, 'base64url'), N, r, p, expected.length);
    return crypto.timingSafeEqual(dk, expected);
  } catch {
    return false; // absurd parameters (maxmem, N not a power of two) — not a valid password
  }
}

/** The credential (凭证A) an account owns. Issued once at registration, never rotated. */
export const issueToken = (): string => 'ccc_' + crypto.randomBytes(32).toString('base64url');

/** Strip the hash: nothing outside this file has any business holding it. */
const publicUser = (u: UserRow): UserRecord => ({ username: u.username, token: u.token, createdAt: u.createdAt, lastLogin: u.lastLogin });

/**
 * Hashed against when the username does not exist, so a login attempt costs the same ~50ms
 * either way and the response time stops answering "does this account exist?". Zero salt and
 * zero hash at the real parameters — it can never match a password.
 */
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${'A'.repeat(22)}$${'A'.repeat(43)}`;

export class Store {
  envs = new Map<string, EnvRecord>();
  sessions = new Map<string, SessionRecord>(); // by sessionId
  /** Accounts, keyed by username. Hashes live here and are never handed out. */
  private users = new Map<string, UserRow>();
  private byToken = new Map<string, string>(); // token → username
  private byIngressToken = new Map<string, string>(); // ingressToken → sessionId
  private memHistory = new Map<string, unknown[]>(); // no-pool fallback: capped ring
  private pool?: Pool;
  private dirtyActivity = new Set<string>(); // sessionIds whose last_activity needs flushing
  private flushTimer?: NodeJS.Timeout;

  constructor(opts: { pool?: Pool } = {}) {
    this.pool = opts.pool;
    if (this.pool) {
      // touch() fires on every inbound event; batch the bumps instead of one UPDATE each.
      this.flushTimer = setInterval(() => void this.flushActivity(), ACTIVITY_FLUSH_MS);
      this.flushTimer.unref?.();
    }
  }

  /** Hydrate the read cache from PG. No-op without a pool. */
  async load(windowDays = Number(process.env.CCC_LOAD_WINDOW_DAYS || 30)): Promise<{ envs: number; sessions: number; users: number }> {
    if (!this.pool) return { envs: 0, sessions: 0, users: 0 };
    for (const u of await loadUsers(this.pool)) {
      this.users.set(u.username, u);
      this.byToken.set(u.token, u.username);
    }
    const { envs, sessions } = await loadRecent(this.pool, windowDays);
    for (const e of envs) {
      this.envs.set(e.id, { ...e, online: false, queue: [], inflight: new Map() });
    }
    for (const s of sessions) {
      const { digest, ...rest } = s;
      this.sessions.set(s.id, {
        ...rest, wsConnected: false, sseRes: null, seq: 0,
        // A restart voids in-flight approvals, so the badge must not come back stuck on.
        digest: { ...emptyDigest(), ...(digest ?? {}), pendingApproval: false, turnActive: false },
        pendingTools: new Set(),
      });
      this.byIngressToken.set(s.ingressToken, s.id);
    }
    return { envs: envs.length, sessions: sessions.length, users: this.users.size };
  }

  // ── accounts ──

  get userCount(): number { return this.users.size; }

  /**
   * Register an account and issue its token. Returns undefined when the username is taken —
   * PG decides that (insertUser's ON CONFLICT), so a race cannot produce two owners of one name.
   * Without a pool the cache is the only authority, which is what the tests run on.
   */
  async createUser(username: string, password: string): Promise<UserRecord | undefined> {
    if (this.users.has(username)) return undefined;
    const row: UserRow = { username, passwordHash: await hashPassword(password), token: issueToken(), createdAt: Date.now() };
    if (this.pool && !(await insertUser(this.pool, row))) return undefined;
    this.users.set(username, row);
    this.byToken.set(row.token, username);
    return publicUser(row);
  }

  /** Synchronous by design — web-channel.ts authenticates inside a WS upgrade handler. */
  userByToken(token: string): UserRecord | undefined {
    const username = this.byToken.get(token);
    const row = username ? this.users.get(username) : undefined;
    return row ? publicUser(row) : undefined;
  }

  getUser(username: string): UserRecord | undefined {
    const row = this.users.get(username);
    return row ? publicUser(row) : undefined;
  }

  /**
   * Check a password. Returns the account (with its token) on success, undefined otherwise —
   * the caller must not distinguish "no such user" from "wrong password" to the client.
   * An unknown user still pays a hash so the response time does not leak which it was.
   */
  async verifyLogin(username: string, password: string): Promise<UserRecord | undefined> {
    const row = this.users.get(username);
    if (!row) { await verifyPassword(password, DUMMY_HASH); return undefined; }
    return (await verifyPassword(password, row.passwordHash)) ? publicUser(row) : undefined;
  }

  async touchLogin(username: string): Promise<void> {
    const row = this.users.get(username);
    if (!row) return;
    row.lastLogin = Date.now();
    if (this.pool) await updateLastLogin(this.pool, username, row.lastLogin).catch(() => {});
  }

  /** Flush pending last_activity bumps and stop the timer. */
  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    await this.flushActivity();
  }

  async createEnv(meta: { credential: string; machineName?: string; dir?: string; branch?: string; gitRepoUrl?: string; reuseId?: string }): Promise<EnvRecord> {
    const id = meta.reuseId && this.envs.has(meta.reuseId) ? meta.reuseId : meta.reuseId || 'env-' + crypto.randomUUID();
    const rec: EnvRecord = {
      id, credential: meta.credential, machineName: meta.machineName, dir: meta.dir,
      branch: meta.branch, gitRepoUrl: meta.gitRepoUrl, createdAt: Date.now(), online: true,
      queue: [], inflight: new Map(),
    };
    this.envs.set(id, rec);
    if (this.pool) await upsertEnv(this.pool, rec);
    return rec;
  }

  /** Queue a session work item for an environment; the session inherits the env's owner + metadata. */
  async pushSessionWork(envId: string, apiBaseUrl: string): Promise<{ work: WorkItem; session: SessionRecord } | null> {
    const env = this.envs.get(envId);
    if (!env) return null;
    const sessionId = 'ses-' + crypto.randomUUID();
    const ingressToken = 'sit_' + crypto.randomBytes(18).toString('hex');
    const work: WorkItem = {
      id: 'work-' + crypto.randomUUID(),
      secret: encodeWorkSecret(ingressToken, apiBaseUrl),
      data: { type: 'session', id: sessionId },
    };
    const now = Date.now();
    const session: SessionRecord = {
      id: sessionId, credential: env.credential, envId, ingressToken, workId: work.id,
      machineName: env.machineName, dir: env.dir, branch: env.branch, gitRepoUrl: env.gitRepoUrl,
      createdAt: now, lastActivity: now, wsConnected: false, sseRes: null, seq: 0,
      digest: emptyDigest(), pendingTools: new Set(),
    };
    this.sessions.set(sessionId, session);
    this.byIngressToken.set(ingressToken, sessionId);
    env.queue.push(work); // in-flight lease: memory only, invalid after a restart anyway
    if (this.pool) await upsertSession(this.pool, session);
    return { work, session };
  }

  /**
   * Create a session for the interactive REPL bridge (`/rc`): no environment/work item — the
   * interactive claude creates a code-session directly and then fetches worker creds. The
   * session id is the `cse_…` we return; `ingressToken` doubles as the `worker_jwt`.
   */
  async createReplSession(credential: string, meta: { dir?: string; title?: string; machineName?: string }, id?: string): Promise<SessionRecord> {
    const sid = id && id.startsWith('cse_') ? id : 'cse_' + crypto.randomBytes(8).toString('hex');
    const existing = this.sessions.get(sid);
    if (existing && existing.credential === credential) {
      this.patchSession(existing, meta);
      if (this.pool) await upsertSession(this.pool, existing);
      return existing;
    }
    const ingressToken = 'sit_' + crypto.randomBytes(18).toString('hex');
    const now = Date.now();
    const session: SessionRecord = {
      id: sid, credential, envId: '', ingressToken, workId: '',
      machineName: meta.machineName ?? meta.title ?? os.hostname(),
      dir: meta.dir,
      createdAt: now, lastActivity: now, wsConnected: false, sseRes: null, seq: 0,
      digest: emptyDigest(), pendingTools: new Set(),
    };
    this.sessions.set(sid, session);
    this.byIngressToken.set(ingressToken, sid);
    if (this.pool) await upsertSession(this.pool, session);
    return session;
  }

  /** Fill machine/dir when a later event (create body, system:init) knows more. */
  async updateSessionMeta(sessionId: string, meta: { dir?: string; title?: string; machineName?: string; branch?: string; gitRepoUrl?: string }): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const changed = this.patchSession(s, meta);
    if (changed && this.pool) await upsertSession(this.pool, s);
    return changed;
  }

  /** Pull cwd (and anything else useful) out of a data-plane payload. */
  async applyEventMeta(sessionId: string, payload: any): Promise<boolean> {
    if (!payload || payload.type !== 'system' || payload.subtype !== 'init') return false;
    const dir = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined;
    return this.updateSessionMeta(sessionId, { dir });
  }

  // ── deletion ──

  /**
   * Forget one session and everything it ever said.
   *
   * Refused while a claude is still connected. Deleting a live session voids the ingress token
   * its child is holding, and the child would then spend the rest of its life reconnecting into
   * a 401 — so `wsConnected` is the boundary. The web does not draw the button on a live row,
   * but the rule lives here as well: a row can come online between being drawn and being clicked.
   *
   * The transcript goes with the session (`events` is ON DELETE CASCADE) and none of it is
   * recoverable.
   */
  async deleteSession(sessionId: string): Promise<'ok' | 'active' | 'missing'> {
    const s = this.sessions.get(sessionId);
    if (!s) return 'missing';
    if (s.wsConnected) return 'active';
    this.forget(s);
    if (this.pool) await deleteSessionRow(this.pool, sessionId);
    return 'ok';
  }

  /**
   * Sessions nobody has touched in `days`, deleted with their history. Returns what went, so the
   * caller can tell the owning credential's web clients to redraw their list.
   *
   * Two details this depends on:
   *   - the pending `last_activity` bumps are flushed FIRST. touch() only marks a session dirty
   *     and the writer runs every 30s, so without this a session busy ten seconds ago still looks
   *     seven days idle in PG, and the sweep would delete it out from under a live transcript.
   *   - PG decides which rows are stale, not the cache. A session older than the load window was
   *     never read into memory, and those are precisely the ones most in need of sweeping.
   *
   * Connected sessions are exempt no matter how old their last event is — a child holding an open
   * SSE stream is not stale, it is quiet.
   */
  async sweepStale(days = Number(process.env.CCC_SESSION_TTL_DAYS || 7)): Promise<Array<{ id: string; credential: string }>> {
    if (!(days > 0)) return []; // 0 / negative / NaN — the sweep is off
    await this.flushActivity();
    const cutoff = Date.now() - days * 86400_000;
    const gone: Array<{ id: string; credential: string }> = [];
    if (this.pool) {
      const live = [...this.sessions.values()].filter((s) => s.wsConnected).map((s) => s.id);
      gone.push(...(await deleteStaleSessions(this.pool, cutoff, live)));
    } else {
      for (const s of this.sessions.values()) {
        if (!s.wsConnected && s.lastActivity < cutoff) gone.push({ id: s.id, credential: s.credential });
      }
    }
    for (const { id } of gone) {
      const s = this.sessions.get(id);
      if (s) this.forget(s);
    }
    return gone;
  }

  /** Drop every trace of a session from the read cache. PG is the caller's business. */
  private forget(s: SessionRecord): void {
    this.sessions.delete(s.id);
    this.byIngressToken.delete(s.ingressToken);
    this.memHistory.delete(s.id);
    // Left behind, the next flush would UPDATE a row that no longer exists. Harmless in itself,
    // but it would also keep re-queueing a deleted session's digest on every failed retry.
    this.dirtyActivity.delete(s.id);
  }

  // ── work queue (memory only: a lease is meaningless across a restart) ──
  nextWork(envId: string): WorkItem | null {
    const env = this.envs.get(envId);
    if (!env || env.queue.length === 0) return null;
    const w = env.queue.shift()!;
    env.inflight.set(w.id, w);
    return w;
  }

  ackWork(envId: string, workId: string): void {
    this.envs.get(envId)?.inflight.delete(workId);
  }

  // ── synchronous reads (served from the cache) ──
  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }
  getEnv(envId: string): EnvRecord | undefined {
    return this.envs.get(envId);
  }
  sessionByIngressToken(token: string): SessionRecord | undefined {
    const id = this.byIngressToken.get(token);
    return id ? this.sessions.get(id) : undefined;
  }
  sessionsForCredential(credential: string): SessionRecord[] {
    return [...this.sessions.values()].filter((s) => s.credential === credential).sort((a, b) => b.lastActivity - a.lastActivity);
  }
  view(s: SessionRecord): SessionView {
    return { id: s.id, machine: s.machineName, dir: s.dir, branch: s.branch, gitRepoUrl: s.gitRepoUrl, status: s.wsConnected ? 'active' : 'offline', createdAt: s.createdAt, lastActivity: s.lastActivity, digest: s.digest };
  }

  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.lastActivity = Date.now();
    if (this.pool) this.dirtyActivity.add(sessionId); // batched by the flush timer
  }

  private async flushActivity(): Promise<void> {
    if (!this.pool || this.dirtyActivity.size === 0) return;
    const ids = [...this.dirtyActivity];
    this.dirtyActivity.clear();
    // The digest changes on the same events that bump last_activity, so it rides the same batch.
    const rows = ids.map((id) => this.sessions.get(id)).filter(Boolean).map((s) => ({ id: s!.id, lastActivity: s!.lastActivity, digest: s!.digest }));
    try {
      await flushActivity(this.pool, rows);
    } catch (e: any) {
      for (const id of ids) this.dirtyActivity.add(id); // retry on the next tick
      console.error(`[store] last_activity flush failed: ${e.message}`);
    }
  }

  /**
   * Record child event payloads so a web client that subscribes later gets the transcript.
   * The REPL bridge replays the whole pre-/rc conversation on connect, so this captures it.
   * Batched: one multi-row INSERT per /worker/events POST.
   */
  async appendEvents(sessionId: string, payloads: unknown[]): Promise<void> {
    const storable = payloads.filter((p) => !UNSTORED_EVENT_TYPES.has((p as any)?.type));
    const session = this.sessions.get(sessionId);
    if (session) for (const p of storable) this.foldDigest(session, p);
    if (!storable.length) return;
    if (!this.pool) {
      let h = this.memHistory.get(sessionId);
      if (!h) { h = []; this.memHistory.set(sessionId, h); }
      h.push(...storable);
      if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
      return;
    }
    await insertEvents(this.pool, sessionId, storable.map((p) => ({ type: (p as any)?.type, payload: p })));
  }

  async historyFor(sessionId: string): Promise<unknown[]> {
    if (!this.pool) return this.memHistory.get(sessionId) ?? [];
    return selectHistory(this.pool, sessionId, HISTORY_LIMIT);
  }

  /**
   * The stored payload behind a blob reference, image data still in it. Kept separate from
   * historyFor because that path deliberately strips the bytes (src/image-blob.ts) — this is the
   * one place they are handed back, one image at a time, to whoever owns the session.
   */
  async eventByUuid(sessionId: string, uuid: string): Promise<unknown | null> {
    if (!this.pool) {
      const h = this.memHistory.get(sessionId) ?? [];
      for (let i = h.length - 1; i >= 0; i--) if ((h[i] as any)?.uuid === uuid) return h[i];
      return null;
    }
    return selectEventByUuid(this.pool, sessionId, uuid);
  }

  /**
   * Fold one payload into the session-list digest. Deliberately shallow: it answers "what is
   * this session doing" for a list row, not "what does the transcript look like" (that is the
   * web's reducer). Unknown types are no-ops so a new event type can never break the list.
   */
  private foldDigest(s: SessionRecord, payload: any): void {
    if (!payload || typeof payload !== 'object') return;
    const d = s.digest;
    /**
     * Nothing is in flight any more. Shared by the four events that mean it, because a row stuck
     * on "running" (or on a pending-approval badge) is the failure mode every one of them causes:
     * `result`, a post-turn summary, the child shutting down, and a conversation reset.
     */
    const settle = (failed = false): void => {
      d.turnActive = false;
      if (d.toolStatus === 'running') d.toolStatus = failed ? 'error' : 'ok';
      s.pendingTools.clear();
      d.pendingApproval = false;
    };
    switch (payload.type) {
      case 'system': {
        // A post-turn summary means the turn is over even when no `result` follows it — without
        // this the row (and the phone's activity line, which seeds from it) stays "running".
        // worker_shutting_down is the blunt version: the child is gone, so no result is coming.
        if (payload.subtype === 'post_turn_summary' || payload.subtype === 'worker_shutting_down') {
          settle();
          return;
        }
        if (payload.subtype !== 'init') return;
        if (typeof payload.model === 'string') d.model = payload.model;
        if (typeof payload.permissionMode === 'string') d.mode = payload.permissionMode;
        return;
      }
      case 'user': {
        const texts = userTextsFrom(payload);
        if (texts.length) {
          d.prompt = texts[texts.length - 1].slice(0, 400);
          d.turnActive = true;
        }
        const content = payload.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (b?.type !== 'tool_result') continue;
          if (typeof b.tool_use_id === 'string') s.pendingTools.delete(b.tool_use_id);
          // Only the newest call drives the row; an older result must not overwrite it.
          if (b.tool_use_id === s.currentToolUseId) d.toolStatus = b.is_error ? 'error' : 'ok';
        }
        d.pendingApproval = s.pendingTools.size > 0;
        return;
      }
      case 'assistant': {
        const content = payload.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (b?.type !== 'tool_use' || HIDDEN_TOOLS.has(b.name)) continue;
          d.toolCalls += 1;
          d.tool = b.name;
          d.toolArg = toolArg(b.name, b.input);
          d.toolStatus = 'running';
          d.toolStartedAt = payloadTime(payload) ?? Date.now();
          s.currentToolUseId = typeof b.id === 'string' ? b.id : undefined;
          d.turnActive = true;
        }
        return;
      }
      case 'control_request': {
        if (payload.request?.subtype !== 'can_use_tool') return;
        const id = payload.request?.tool_use_id;
        if (typeof id === 'string') s.pendingTools.add(id);
        d.pendingApproval = true;
        return;
      }
      case 'control_cancel_request': {
        // The child withdrew a permission request, usually because it was answered in the
        // terminal. Without this the list keeps its approval badge lit for a request nobody can
        // answer any more. The cancel carries only `request_id`, and can_use_tool is serialised
        // one at a time, so clearing the whole pending set is exact in practice.
        s.pendingTools.clear();
        d.pendingApproval = false;
        return;
      }
      case 'conversation_reset': {
        // /clear or a compaction: whatever the previous conversation was doing is over.
        settle();
        return;
      }
      case 'result': {
        settle(!!payload.is_error);
        return;
      }
    }
  }

  /** Called when we answer a permission request, so the list badge clears immediately. */
  clearPendingApproval(sessionId: string, toolUseId?: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (toolUseId) s.pendingTools.delete(toolUseId);
    else s.pendingTools.clear();
    s.digest.pendingApproval = s.pendingTools.size > 0;
  }

  // ── runtime connection state (memory only) ──
  markWsConnected(sessionId: string, connected: boolean): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.wsConnected = connected; this.touch(sessionId); }
  }

  /** Mark an environment (and its sessions) offline — injector gone / deregistered. */
  markEnvOffline(envId: string): void {
    const env = this.envs.get(envId);
    if (env) env.online = false;
    for (const s of this.sessions.values()) if (s.envId === envId) s.wsConnected = false;
  }

  attachSse(sessionId: string, res: ServerResponse): void {
    const s = this.sessions.get(sessionId);
    if (s) s.sseRes = res;
  }

  detachSse(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.sseRes = null;
  }

  private patchSession(s: SessionRecord, meta: { dir?: string; title?: string; machineName?: string; branch?: string; gitRepoUrl?: string }): boolean {
    let changed = false;
    const machine = meta.machineName ?? meta.title;
    if (machine && s.machineName !== machine) { s.machineName = machine; changed = true; }
    if (meta.dir && s.dir !== meta.dir) { s.dir = meta.dir; changed = true; }
    if (meta.branch && s.branch !== meta.branch) { s.branch = meta.branch; changed = true; }
    if (meta.gitRepoUrl && s.gitRepoUrl !== meta.gitRepoUrl) { s.gitRepoUrl = meta.gitRepoUrl; changed = true; }
    if (changed) s.lastActivity = Date.now();
    return changed;
  }

  /** Push one stream-json payload to the child over SSE. False if no open stream. */
  sendToChild(sessionId: string, payload: unknown): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || !s.sseRes) return false;
    const seq = ++s.seq;
    const data = JSON.stringify({ sequence_num: seq, event_id: `srv-${seq}`, event_type: 'relay', payload });
    try {
      s.sseRes.write(`event: client_event\ndata: ${data}\nid: ${seq}\n\n`);
      this.touch(sessionId);
      return true;
    } catch {
      return false;
    }
  }
}
