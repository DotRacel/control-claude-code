/** Client for the controller's /ws/client channel (see src/server/web-channel.ts). */
import type { SessionDigest } from '../../src/server/store.ts';

export type { SessionDigest };

export interface SessionView {
  id: string;
  machine?: string;
  dir?: string;
  branch?: string;
  gitRepoUrl?: string;
  status: 'active' | 'offline';
  createdAt: number;
  lastActivity: number;
  /** Server-derived summary for the list row (prompt preview, running tool, tool count). */
  digest: SessionDigest;
}

export type Connection = 'connecting' | 'online' | 'offline';

/**
 * What we answer a `can_use_tool` request with. Mirrors the worker's own bridge-permission
 * schema — `updatedInput` carries AskUserQuestion answers, `updatedPermissions` carries the
 * worker's own `permission_suggestions` back to make an allow stick ("Always allow").
 */
export interface PermissionAnswer {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
}

export interface Handlers {
  onSessions: (s: SessionView[]) => void;
  onEvent: (sessionId: string, payload: any) => void;
  onHistory?: (sessionId: string, events: any[]) => void;
  onNotify?: (sessionId: string, message: string, ready?: boolean) => void;
  onStatus?: (c: Connection) => void;
}

export class ControlSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;

  constructor(private credential: string, private h: Handlers) {}

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.h.onStatus?.('connecting');
    const ws = new WebSocket(`${proto}://${location.host}/ws/client?credential=${encodeURIComponent(this.credential)}`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.h.onStatus?.('online'); };
    ws.onmessage = (e) => {
      let m: any;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'sessions') this.h.onSessions(m.sessions);
      else if (m.type === 'event') this.h.onEvent(m.sessionId, m.payload);
      else if (m.type === 'history') this.h.onHistory?.(m.sessionId, m.events || []);
      else if (m.type === 'notify' && typeof m.message === 'string') this.h.onNotify?.(m.sessionId, m.message, !!m.ready);
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.h.onStatus?.('offline');
      // Back off a little, but stay responsive: a phone waking from sleep should reconnect fast.
      const wait = Math.min(1000 * 2 ** this.retry++, 15000);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => ws.close();
  }

  /** Force an immediate reconnect (the offline banner's Retry). */
  reconnect() {
    this.retry = 0;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
    else this.connect();
  }

  private send(o: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  get online(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  subscribe(sessionId: string) { this.send({ type: 'subscribe', sessionId }); }
  sendMessage(sessionId: string, text: string) { this.send({ type: 'user_message', sessionId, text }); }
  respondPermission(sessionId: string, requestId: string, answer: PermissionAnswer) {
    this.send({ type: 'permission_response', sessionId, requestId, ...answer });
  }
  control(sessionId: string, subtype: string, extra?: Record<string, unknown>) { this.send({ type: 'control', sessionId, subtype, extra }); }
  /**
   * Forget a session and its transcript, server-side and for good. There is no reply frame and
   * none is needed: the server answers by pushing the credential's whole session list again, so
   * the row disappearing IS the acknowledgement — in this tab and in every other one open on the
   * same account. The server refuses a session whose claude is still connected, which is why the
   * button is not drawn on a live row.
   */
  deleteSession(sessionId: string) { this.send({ type: 'session_delete', sessionId }); }

  close() { this.closed = true; this.ws?.close(); }
}

// ── credential cookie ──
export function getCredential(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)ccc_credential=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
export function setCredential(cred: string) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  // 10-year cookie; SameSite=Lax. Not httpOnly by design (the SPA reads it to open the WS).
  document.cookie = `ccc_credential=${encodeURIComponent(cred)}; Max-Age=${10 * 365 * 24 * 3600}; Path=/; SameSite=Lax${secure}`;
}
export function clearCredential() {
  document.cookie = 'ccc_credential=; Max-Age=0; Path=/';
}
