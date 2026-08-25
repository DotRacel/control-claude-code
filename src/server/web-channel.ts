/**
 * web-channel.ts — the browser-facing WebSocket channel (`/ws/client`).
 *
 * A phone connects with its credential (凭证A) via query or cookie; we authenticate it against
 * the account registry, push the session list it owns, and relay: web→child (user messages,
 * permission answers, host controls) and child→web (the `claude.event` payloads it subscribed
 * to). All routing is scoped to the credential — a socket can only touch sessions it owns, and
 * a token belonging to no account never gets a socket at all.
 */
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Store } from './store.ts';
import type { ServerEvent, ControllerServer, PermissionDecision } from './index.ts';
import { cookieCredential } from './index.ts';
import { pushNotificationFrom } from '../push-event.ts';
import { stripImageBlobs } from '../image-blob.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const acceptKey = (k: string) => crypto.createHash('sha1').update(k + WS_GUID).digest('base64');

interface WebSock {
  credential: string;
  subscribed: string | null; // sessionId currently being viewed
  /** Non-null while a history backfill is in flight: live events queue here so they are
   * delivered after the transcript instead of racing ahead of it. */
  pending: unknown[] | null;
  socket: Duplex;
  send: (obj: unknown) => void;
}

type WebApi = Pick<ControllerServer, 'sendUserMessage' | 'sendControlResponse' | 'sendControl'>;

/** Permission-update shapes the worker offers in `permission_suggestions` (2.1.232). */
const PERMISSION_UPDATE_TYPES = new Set(['addRules', 'replaceRules', 'removeRules', 'setMode', 'addDirectories', 'removeDirectories']);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Build a permission decision from a browser frame. Everything here is untrusted input, so
 * only the four keys the worker's own schema accepts survive, and `updatedPermissions` entries
 * must at least carry a known `type` — a malformed one would make the worker drop the whole
 * array (and with it a legitimate "Always allow").
 */
function decisionFrom(m: any): PermissionDecision {
  const d: PermissionDecision = { behavior: m?.behavior === 'deny' ? 'deny' : 'allow' };
  if (isPlainObject(m?.updatedInput)) d.updatedInput = m.updatedInput;
  if (Array.isArray(m?.updatedPermissions)) {
    const ups = m.updatedPermissions.filter((u: unknown) => isPlainObject(u) && typeof u.type === 'string' && PERMISSION_UPDATE_TYPES.has(u.type));
    if (ups.length) d.updatedPermissions = ups;
  }
  if (typeof m?.message === 'string' && m.message.trim()) d.message = m.message.slice(0, 2000);
  return d;
}

export function attachWebChannel(server: Server, api: WebApi, store: Store) {
  const socks = new Set<WebSock>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/ws/client') return; // not ours; leave it
    const key = req.headers['sec-websocket-key'];
    const credential = url.searchParams.get('credential') || cookieCredential(req);
    // store.userByToken is a synchronous cache read precisely so this check fits here — an
    // upgrade handler has nowhere to await.
    if (typeof key !== 'string' || !credential || !store.userByToken(credential)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);

    const ws: WebSock = { credential, subscribed: null, pending: null, socket: socket as Duplex, send: (obj) => sendFrame(socket as Duplex, JSON.stringify(obj)) };
    socks.add(ws);
    ws.send({ type: 'sessions', sessions: store.sessionsForCredential(credential).map((s) => store.view(s)) });

    let buf: Buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    const parts: Buffer[] = [];
    let op = 0;
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const f = takeFrame(buf);
        if (!f) break;
        buf = f.rest;
        if (f.opcode === 0x8) { try { (socket as Duplex).end(); } catch {} return; }
        if (f.opcode === 0x9) { sendPong(socket as Duplex, f.payload); continue; }
        if (f.opcode === 0xa) continue;
        if (f.opcode !== 0x0) op = f.opcode;
        parts.push(f.payload);
        if (f.fin) {
          const full = parts.length === 1 ? parts[0] : Buffer.concat(parts);
          parts.length = 0;
          if (op === 0x1) void handleMsg(ws, full.toString('utf8')).catch(() => {});
        }
      }
    });
    const done = () => { socks.delete(ws); };
    socket.on('close', done);
    socket.on('error', done);
  });

  // Synchronous — runs on every inbound frame, served from the store's read cache.
  const owns = (ws: WebSock, sid: string) => store.getSession(sid)?.credential === ws.credential;

  async function handleMsg(ws: WebSock, text: string) {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    switch (m?.type) {
      case 'subscribe':
        if (owns(ws, m.sessionId)) {
          // Subscribe first (so nothing is dropped), buffer, backfill, then drain.
          ws.subscribed = m.sessionId;
          ws.pending = [];
          // Image data is replaced by a `<uuid>:<n>` reference here and fetched on demand from
          // /v1/blob — a real session measured 14.7 MB of base64 across 39 screenshots, and a
          // phone reopening it would have downloaded all of them to draw thumbnails.
          const events = (await store.historyFor(m.sessionId)).map(stripImageBlobs);
          ws.send({ type: 'history', sessionId: m.sessionId, events });
          const buffered = ws.pending;
          ws.pending = null;
          for (const payload of buffered) ws.send({ type: 'event', sessionId: m.sessionId, payload });
        }
        break;
      case 'user_message':
        if (owns(ws, m.sessionId) && typeof m.text === 'string') api.sendUserMessage(m.sessionId, m.text);
        break;
      case 'permission_response':
        if (owns(ws, m.sessionId)) api.sendControlResponse(m.sessionId, m.requestId, decisionFrom(m));
        break;
      case 'control':
        if (owns(ws, m.sessionId) && typeof m.subtype === 'string') api.sendControl(m.sessionId, m.subtype, m.extra || {});
        break;
      /**
       * Forget a session and its whole transcript. `owns` is the same check every other frame
       * gets — a guessed id belonging to another account is not deletable — and the store refuses
       * a session whose child is still connected, so this cannot be used to knock a running
       * claude off its own control plane.
       *
       * The list is pushed to EVERY socket on the credential, not just this one: a second tab
       * showing a row that no longer exists would 404 the moment it was clicked.
       */
      case 'session_delete':
        if (owns(ws, m.sessionId) && (await store.deleteSession(m.sessionId)) === 'ok') pushList(ws.credential);
        break;
    }
  }

  function pushList(credential: string) {
    const list = store.sessionsForCredential(credential).map((s) => store.view(s));
    for (const ws of socks) if (ws.credential === credential) ws.send({ type: 'sessions', sessions: list });
  }

  return {
    /** Fan a ServerEvent out to the right web sockets. */
    handleEvent(e: ServerEvent) {
      if (e.type === 'claude.event') {
        const note = pushNotificationFrom(e.payload);
        // Stripped once for the whole fan-out, not per socket — same reason as the backfill.
        const payload = stripImageBlobs(e.payload);
        for (const ws of socks) {
          if (ws.credential !== e.credential) continue;
          if (ws.subscribed === e.sessionId) {
            if (ws.pending) ws.pending.push(payload); // mid-backfill: keep the order
            else ws.send({ type: 'event', sessionId: e.sessionId, payload });
          } else if (note) ws.send({ type: 'notify', sessionId: e.sessionId, message: note.message, status: note.status, ready: note.ready });
        }
      } else if ('credential' in e && (e as any).credential) {
        pushList((e as any).credential); // env.register / session.create / ws.connect / ws.close / env.deregister
      }
    },
  };
}

// ── minimal RFC6455 server-side framing ──
function takeFrame(b: Buffer): { fin: boolean; opcode: number; payload: Buffer; rest: Buffer } | null {
  if (b.length < 2) return null;
  const fin = (b[0] & 0x80) !== 0;
  const opcode = b[0] & 0x0f;
  const masked = (b[1] & 0x80) !== 0;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  let mask: Buffer | null = null;
  if (masked) { if (b.length < off + 4) return null; mask = b.subarray(off, off + 4); off += 4; }
  if (b.length < off + len) return null;
  let payload = b.subarray(off, off + len);
  if (mask) { const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
  return { fin, opcode, payload, rest: b.subarray(off + len) };
}
function sendFrame(socket: Duplex, text: string): void {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 0x10000) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x81;
  try { socket.write(Buffer.concat([header, payload])); } catch {}
}
function sendPong(socket: Duplex, payload: Buffer): void {
  try { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length & 0x7f]), payload])); } catch {}
}
