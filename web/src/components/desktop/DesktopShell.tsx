/**
 * DesktopShell.tsx — the two-pane layout: session rail on the left, one session on the right.
 *
 * The socket, the session list and which session is open all live a level up in App.tsx, shared
 * with the phone layout — so dragging the window across the breakpoint keeps the session you were
 * reading instead of dropping you back at a list.
 *
 * It also owns the shell's keys, because it is the one place that has both the session list and
 * which one is open:
 *
 *   ⌘/Ctrl+K      the session switcher
 *   ⌘/Ctrl+↑ ↓    previous / next session
 *
 * Every binding takes a modifier on purpose. The composer is a textarea and it is where the
 * caret almost always is, so a bare letter would either be swallowed or would have to fight the
 * thing people are typing into. With a modifier they work from anywhere, including mid-sentence,
 * and nothing has to be blurred first — which is also why there is no mode to be in and no
 * indicator to keep honest.
 */
import { useEffect, useState } from 'react';
import type { ControlSocket, SessionView, Connection } from '../../ws.ts';
import { Sidebar } from './Sidebar.tsx';
import { DesktopChat } from './DesktopChat.tsx';
import { SessionSwitcher } from './SessionSwitcher.tsx';
import { filterSessions, type Filter } from '../SessionList.tsx';
import { ClaudeMark } from '../../icons.tsx';

export function DesktopShell({ sessions, activeId, connection, sock, onOpen, onLogout, onDelete, registerEvent, registerHistory }: {
  sessions: SessionView[];
  activeId: string | null;
  connection: Connection;
  sock: ControlSocket;
  onOpen: (s: SessionView) => void;
  onLogout: () => void;
  onDelete?: (s: SessionView) => void;
  registerEvent: (cb: (sid: string, p: any) => void) => void;
  registerHistory: (cb: (sid: string, events: any[]) => void) => void;
}) {
  const active = activeId ? sessions.find((s) => s.id === activeId) ?? null : null;
  const [switching, setSwitching] = useState(false);
  const [filter, setFilter] = useState<Filter>('active');
  const shown = filterSessions(sessions, filter);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === 'k' || e.key === 'K') {
        // Ctrl+K is Firefox's web-search shortcut and ⌘K is the omnibox's; both yield to the page.
        e.preventDefault();
        setSwitching((v) => !v);
        return;
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      // The FILTERED list, in the rail's own order: stepping into a session the rail is hiding
      // would leave nothing highlighted and no clue where you had gone. This is why the filter
      // lives here and not in Sidebar.
      const order = shown;
      if (order.length < 2) return;
      e.preventDefault();
      const i = order.findIndex((s) => s.id === activeId);
      const next = e.key === 'ArrowDown'
        ? order[(i + 1 + order.length) % order.length]
        : order[(i - 1 + order.length) % order.length];
      if (next) onOpen(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, activeId, onOpen]);

  return (
    <div className="dshell">
      <Sidebar
        shown={shown}
        activeId={activeId}
        connection={connection}
        filter={filter}
        onFilter={setFilter}
        onOpen={onOpen}
        onLogout={onLogout}
        onDelete={onDelete}
      />
      <main className="dmain">
        {active ? (
          <DesktopChat
            key={active.id}
            session={active}
            sock={sock}
            connection={connection}
            registerEvent={registerEvent}
            registerHistory={registerHistory}
          />
        ) : (
          <div className="dempty">
            <ClaudeMark size={34} fill="#3a3936" />
            <p>{sessions.length ? '从左边选一个会话' : '还没有会话。左上角的 ? 说明怎么开一个。'}</p>
          </div>
        )}
      </main>
      {switching && (
        <SessionSwitcher
          /* Searches every session, filter or not: typing a name is an explicit request for that
             session, and silently not finding it because a chip is set to 活跃 would be worse. */
          sessions={sessions}
          activeId={activeId}
          onOpen={onOpen}
          onDismiss={() => setSwitching(false)}
        />
      )}
    </div>
  );
}
