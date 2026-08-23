/**
 * ws-client.ts — zero-dependency client for Bun's debugger.
 *
 * Ported from cc-injector (src/inspector/ws-client.js). Bun's inspector speaks the
 * JavaScriptCore / WebKit Inspector Protocol over a WebSocket (a JSON-RPC-ish channel:
 * {id, method, params} -> {id, result|error}, plus unsolicited {method, params} events).
 * Node ships no WebSocket *client*, so we implement the RFC6455 client handshake +
 * framing over a raw TCP socket.
 *
 * Scope kept deliberately small: text frames, client masking, message reassembly across
 * continuation frames, ping/pong, and the 7/16/64-bit length encodings — everything the
 * inspector channel actually uses.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Every RPC gets a deadline. The pending-id map is the ONLY thing that ever settles a
// send() promise, so a request the target never answers leaves its awaiter hanging
// forever. Every healthy call is answered in ms, so this bound only fires on a broken one.
const RPC_TIMEOUT_MS = Number(process.env.CC_INSPECT_RPC_TIMEOUT_MS || 30000);
const RPC_TIMEOUT_CODE = 'INSPECTOR_RPC_TIMEOUT';
const rpcTimeoutError = (method: string, ms: number) =>
  Object.assign(new Error(`inspector rpc timeout after ${ms}ms (${method})`), { code: RPC_TIMEOUT_CODE, method });

const FRAME_HEADER_MAX = 14; // 2 + 8 (64-bit length) + 4 (mask key)

interface FrameHeader {
  fin: boolean;
  opcode: number;
  off: number;
  len: number;
  maskKey: Buffer | null;
}

/** Decode a frame header from the front of `b`, or null if it isn't all there yet. */
function frameHeader(b: Buffer): FrameHeader | null {
  if (b.length < 2) return null;
  const fin = (b[0] & 0x80) !== 0;
  const opcode = b[0] & 0x0f;
  const masked = (b[1] & 0x80) !== 0; // server->client is never masked
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < off + 2) return null;
    len = b.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (b.length < off + 8) return null;
    len = Number(b.readBigUInt64BE(off));
    off += 8;
  }
  let maskKey: Buffer | null = null;
  if (masked) {
    if (b.length < off + 4) return null;
    maskKey = b.subarray(off, off + 4);
    off += 4;
  }
  return { fin, opcode, off, len, maskKey };
}

/** XOR `payload` under the 4-byte `mask`. Byte loop is intentional — 2.2x faster than a
 *  32-bit-word loop here (measured in cc-injector). */
function maskInto(payload: Buffer, mask: Buffer, len: number): Buffer {
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
  return out;
}

export function parseWsUrl(url: string): { host: string; port: number; path: string } {
  const m = /^wss?:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
  if (!m) throw new Error(`not a ws url: ${url}`);
  return { host: m[1], port: Number(m[2] || 80), path: m[3] || '/' };
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

export class InspectorClient extends EventEmitter {
  private _sock: net.Socket | null = null;
  private _nextId = 1;
  private _rpcTimeoutMs: number;
  private _pending = new Map<number, Pending>();
  private _rx: Buffer = Buffer.alloc(0);
  private _rxPend: Buffer[] = [];
  private _rxLen = 0;
  private _msg: Buffer[] = [];
  private _msgOpcode = 0;
  private _closed = false;

  constructor({ rpcTimeoutMs = RPC_TIMEOUT_MS }: { rpcTimeoutMs?: number } = {}) {
    super();
    this._rpcTimeoutMs = Number(rpcTimeoutMs) || 0;
    // A post-handshake socket error re-emits as 'error'; an 'error' with no listener is an
    // uncaught exception that kills the process. Swallow — 'close' always follows and is
    // the actionable event.
    this.on('error', () => {});
  }

  /** Open the TCP socket + perform the WebSocket upgrade handshake. */
  connect(url: string, { timeout = 10000 }: { timeout?: number } = {}): Promise<InspectorClient> {
    const { host, port, path } = parseWsUrl(url);
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const expectAccept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

      const sock = net.createConnection({ host, port });
      this._sock = sock;
      let handshakeDone = false;
      let hsBuf = Buffer.alloc(0);

      const to = setTimeout(() => {
        if (!handshakeDone) {
          sock.destroy();
          reject(new Error(`ws handshake timeout after ${timeout}ms to ${url}`));
        }
      }, timeout);

      sock.on('error', (e) => {
        if (!handshakeDone) {
          clearTimeout(to);
          reject(e);
        } else {
          this.emit('error', e);
        }
      });

      sock.on('close', () => {
        this._closed = true;
        clearTimeout(to);
        this._rxPend = []; this._rxLen = 0; this._rx = Buffer.alloc(0); this._msg = [];
        for (const { reject: rj } of this._pending.values()) rj(new Error('inspector socket closed'));
        this._pending.clear();
        this.emit('close');
      });

      sock.on('data', (chunk: Buffer) => {
        if (handshakeDone) {
          this._onBytes(chunk);
          return;
        }
        hsBuf = Buffer.concat([hsBuf, chunk]);
        const sep = hsBuf.indexOf('\r\n\r\n');
        if (sep === -1) return;
        const header = hsBuf.subarray(0, sep).toString('utf8');
        const firstLine = header.split('\r\n')[0] || '';
        if (!/\b101\b/.test(firstLine)) {
          clearTimeout(to);
          sock.destroy();
          reject(new Error(`ws upgrade failed: ${firstLine}`));
          return;
        }
        const accept = /sec-websocket-accept:\s*(.+)\r?\n/i.exec(header);
        if (accept && accept[1].trim() !== expectAccept) {
          clearTimeout(to);
          sock.destroy();
          reject(new Error('ws accept key mismatch'));
          return;
        }
        handshakeDone = true;
        clearTimeout(to);
        const rest = hsBuf.subarray(sep + 4);
        this.emit('open');
        if (rest.length) this._onBytes(rest);
        resolve(this);
      });

      sock.setNoDelay(true);
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
  }

  // --- frame decoding -------------------------------------------------------
  /** Feed raw TCP bytes. Segments held UNCONCATENATED until a whole frame arrives (avoids
   *  O(n²) re-copy per TCP segment on large frames). */
  private _onBytes(chunk: Buffer): void {
    this._rxPend.push(chunk);
    this._rxLen += chunk.length;
    for (;;) {
      const total = this._rx.length + this._rxLen;
      if (total < 2) break;
      this._materialize(Math.min(total, FRAME_HEADER_MAX));
      const h = frameHeader(this._rx);
      if (!h) break;
      if (total < h.off + h.len) break;
      this._materialize(h.off + h.len);
      const frame = this._takeFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  private _materialize(n: number): void {
    if (this._rx.length >= n || !this._rxPend.length) return;
    if (this._rx.length === 0 && this._rxPend[0].length >= n) {
      this._rx = this._rxPend.shift()!;
      this._rxLen -= this._rx.length;
      return;
    }
    const parts = [this._rx];
    let have = this._rx.length;
    let i = 0;
    while (have < n && i < this._rxPend.length) {
      const seg = this._rxPend[i++];
      parts.push(seg);
      have += seg.length;
    }
    this._rxPend.splice(0, i);
    this._rxLen -= have - this._rx.length;
    this._rx = Buffer.concat(parts, have);
  }

  private _takeFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const b = this._rx;
    const h = frameHeader(b);
    if (!h) return null;
    const { fin, opcode, off, len, maskKey } = h;
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len);
    if (maskKey) payload = maskInto(payload, maskKey, len);
    this._rx = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  private _handleFrame(f: { fin: boolean; opcode: number; payload: Buffer }): void {
    switch (f.opcode) {
      case 0x0:
      case 0x1:
      case 0x2:
        if (f.opcode !== 0x0) this._msgOpcode = f.opcode;
        this._msg.push(f.payload);
        if (f.fin) {
          const full = this._msg.length === 1 ? this._msg[0] : Buffer.concat(this._msg);
          this._msg = [];
          if (this._msgOpcode === 0x1) this._onMessage(full.toString('utf8'));
        }
        break;
      case 0x8:
        this.close();
        break;
      case 0x9:
        this._send(0xa, f.payload);
        break;
      case 0xa:
        break;
      default:
        break;
    }
  }

  private _onMessage(text: string): void {
    let obj: any;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (obj.id != null && this._pending.has(obj.id)) {
      const { resolve, reject } = this._pending.get(obj.id)!;
      this._pending.delete(obj.id);
      if (obj.error) reject(Object.assign(new Error(obj.error.message || 'inspector error'), { data: obj.error }));
      else resolve(obj.result);
    } else if (obj.method) {
      this.emit('event', obj.method, obj.params);
      this.emit(obj.method, obj.params);
    }
  }

  // --- frame encoding (client frames MUST be masked) ------------------------
  private _send(opcode: number, payload: Buffer): void {
    if (this._closed || !this._sock) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 0x10000) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const masked = maskInto(payload, mask, len);
    this._sock.write(Buffer.concat([header, mask, masked], header.length + 4 + len));
  }

  sendText(str: string): void {
    this._send(0x1, Buffer.from(str, 'utf8'));
  }

  /** JSON-RPC call: resolves with `result`. Always bounded by a deadline. */
  send(method: string, params: Record<string, any> = {}, { timeoutMs = this._rpcTimeoutMs }: { timeoutMs?: number } = {}): Promise<any> {
    /*
     * Reject up front on a closed socket, because _send() drops writes SILENTLY (it returns early
     * rather than throwing, which is what close() itself needs when it writes its own close frame).
     * The try/catch below therefore catches nothing, and the request would sit in _pending until
     * the RPC deadline — and since that timer is unref'd, a caller with nothing else outstanding
     * exits first and the promise never settles at all. Same message the close handler uses, so a
     * request killed in flight and one sent too late read identically.
     */
    if (this._closed) {
      const dead = Promise.reject(new Error('inspector socket closed'));
      dead.catch(() => {}); // a fire-and-forget caller must not raise an unhandled rejection
      return dead;
    }
    const id = this._nextId++;
    const p = new Promise<any>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const clear = (fn: (v: any) => void) => (v: any) => { if (timer) { clearTimeout(timer); timer = null; } fn(v); };
      const entry: Pending = { resolve: clear(resolve), reject: clear(reject) };
      this._pending.set(id, entry);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timer = null;
          if (this._pending.get(id) !== entry) return;
          this._pending.delete(id);
          reject(rpcTimeoutError(method, timeoutMs));
        }, timeoutMs);
        if (timer.unref) timer.unref();
      }
      try {
        this.sendText(JSON.stringify({ id, method, params }));
      } catch (e) {
        this._pending.delete(id);
        entry.reject(e);
      }
    });
    p.catch(() => {});
    return p;
  }

  isClosed(): boolean {
    return this._closed;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    try {
      this._send(0x8, Buffer.alloc(0));
    } catch {}
    try {
      this._sock?.end();
    } catch {}
  }
}

export { RPC_TIMEOUT_MS, RPC_TIMEOUT_CODE };
