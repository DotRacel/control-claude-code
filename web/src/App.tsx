import { useState, useEffect, useRef } from 'react';
import { ControlSocket, getCredential, setCredential, clearCredential, type SessionView, type Connection } from './ws';
import { showPushNotification, pushNotificationFrom } from './notify';
import { checkToken } from './auth.ts';
import { SessionList } from './components/SessionList.tsx';
import { ChatView } from './components/ChatView.tsx';
import { AuthGate } from './components/AuthGate.tsx';
import { DesktopShell } from './components/desktop/DesktopShell.tsx';
import { takeDeepLinkSession, sessionIdBody } from './deeplink.ts';

/**
 * Where the two layouts part company. Live, not once at startup: the breakpoint has to be
 * crossable by dragging a window, both because people do that and because `ui-shot` proves each
 * form by resizing one browser.
 */
const WIDE = '(min-width: 900px)';
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia?.(WIDE).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(WIDE);
    if (!mq) return;
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export function App() {
  const [credential, setCred] = useState<string | null>(getCredential());
  // Until the stored token has been checked, showing either screen would be a guess: the login
  // form flashes for a user who is signed in, the session list hangs for one who is not.
  const [checked, setChecked] = useState(!credential);

  useEffect(() => {
    if (checked || !credential) return;
    let live = true;
    void checkToken(credential).then((r) => {
      if (!live) return;
      // Only an outright rejection logs the user out. If the server is merely unreachable the
      // token is still presumed good — the socket's own reconnect loop handles the outage.
      if (r.status === 'rejected') { clearCredential(); setCred(null); }
      setChecked(true);
    });
    return () => { live = false; };
  }, []);

  if (!checked) return <div className="center-screen" />;
  if (!credential) return <AuthGate onAuthed={({ token }) => { setCredential(token); setCred(token); }} />;
  return <Home credential={credential} onLogout={() => { clearCredential(); setCred(null); }} />;
}

function Home({ credential, onLogout }: { credential: string; onLogout: () => void }) {
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const wide = useWide();
  const sockRef = useRef<ControlSocket | null>(null);
  const eventCb = useRef<(sid: string, payload: any) => void>(() => {});
  const historyCb = useRef<(sid: string, events: any[]) => void>(() => {});

  useEffect(() => {
    const sock = new ControlSocket(credential, {
      onSessions: setSessions,
      onEvent: (sid, p) => {
        const note = pushNotificationFrom(p);
        if (note) showPushNotification(note.message, { force: note.ready || document.visibilityState !== 'visible' });
        eventCb.current(sid, p);
      },
      onHistory: (sid, evs) => historyCb.current(sid, evs),
      onNotify: (_sid, message, ready) => showPushNotification(message, { force: !!ready || document.visibilityState !== 'visible' }),
      onStatus: setConnection,
    });
    sock.connect();
    sockRef.current = sock;
    return () => sock.close();
  }, [credential]);

  // Re-subscribe after a reconnect so the transcript backfills instead of going quiet.
  useEffect(() => {
    if (connection === 'online' && activeId) sockRef.current?.subscribe(activeId);
  }, [connection]);

  /**
   * A session id scanned off the `/rc` QR (or typed from the link). It arrives before the socket
   * does, so it waits here until the session list names it.
   *
   * It lives in `Home`, above the layout branch, because `activeId` is the one piece of state both
   * layouts read — so the deep link behaves identically wide and narrow, and cannot fight the
   * breakpoint. The lazy `useState` initialiser matters: consuming the id in a `useRef(...)`
   * argument would re-run and throw the value away on the second render.
   *
   * Matching is on the id BODY, not the prefix: claude's `toCompatSessionId` is behind a runtime
   * shim, so the URL can legitimately carry either `cse_` or `session_` for the same session.
   */
  const [wanted, setWanted] = useState(() => takeDeepLinkSession());
  useEffect(() => {
    if (!wanted || activeId) return;
    const hit =
      sessions.find((s) => s.id === wanted) ??
      sessions.find((s) => sessionIdBody(s.id) === sessionIdBody(wanted));
    if (hit) {
      setWanted(null);
      setActiveId(hit.id);
    }
  }, [sessions, activeId, wanted]);

  const active = activeId ? sessions.find((s) => s.id === activeId) ?? null : null;

  /**
   * Delete a session, server-side and for good. There is no optimistic removal: the server answers
   * by pushing the whole list again, which is also what makes the row vanish in every other tab
   * open on this account. Closing it first is only about not leaving `activeId` pointing at
   * something that no longer exists — the list push would strand the desktop rail on an empty
   * pane a beat later anyway, and doing it here makes that instant instead of a flicker.
   */
  const deleteSession = (s: SessionView) => {
    if (activeId === s.id) setActiveId(null);
    sockRef.current?.deleteSession(s.id);
  };

  if (wide && sockRef.current) {
    return (
      <DesktopShell
        sessions={sessions}
        activeId={activeId}
        connection={connection}
        sock={sockRef.current}
        onOpen={(s) => setActiveId(s.id)}
        onLogout={onLogout}
        onDelete={deleteSession}
        registerEvent={(cb) => (eventCb.current = cb)}
        registerHistory={(cb) => (historyCb.current = cb)}
      />
    );
  }
  if (active && sockRef.current) {
    return (
      <ChatView
        key={active.id}
        session={active}
        sock={sockRef.current}
        connection={connection}
        onBack={() => setActiveId(null)}
        registerEvent={(cb) => (eventCb.current = cb)}
        registerHistory={(cb) => (historyCb.current = cb)}
      />
    );
  }
  return <SessionList sessions={sessions} connection={connection} onOpen={(s) => setActiveId(s.id)} onLogout={onLogout} onDelete={deleteSession} />;
}
