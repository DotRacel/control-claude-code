/**
 * Sidebar.tsx — the session list, permanently on screen.
 *
 * On a phone the list IS a screen and opening a session replaces it; here it is a rail beside the
 * transcript, so switching sessions is a glance and a click rather than a back-and-forward. That
 * changes what a row has to say: the phone's `SessionCard` is a digest because it is all you get
 * before you open something, while here the transcript is already on screen — so the rail uses
 * `SessionRow` instead (dot, name, time, one line) and marks the open session, which a
 * one-screen-at-a-time layout never needed.
 *
 * The filter lives in DesktopShell rather than here, because ⌘↑/⌘↓ step through this list and they
 * have to step through what is actually on screen — landing in a session the rail is filtering out
 * would leave nothing highlighted and no way to see where you went.
 */
import { useEffect, useState } from 'react';
import type { SessionView } from '../../ws.ts';
import { SessionRow, type Filter } from '../SessionList.tsx';
import { desktopSurfaces } from '../../render/desktop.tsx';
import { Help, SignOut } from '../../icons.tsx';
import { notifyPermission, requestNotifyPermission } from '../../notify.ts';
import { useT } from '../../i18n/react.ts';

export function Sidebar({ shown, activeId, connection, filter, onFilter, onOpen, onLogout }: {
  /** Already filtered by DesktopShell, in render order. */
  shown: SessionView[];
  activeId: string | null;
  connection: string;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onOpen: (s: SessionView) => void;
  onLogout: () => void;
}) {
  const t = useT();
  const [perm, setPerm] = useState(notifyPermission());
  const [help, setHelp] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [, tick] = useState(0);

  // Keep "3 分钟前" honest. Every 30s, not every second: the rows no longer show a running tool's
  // stopwatch, and the coarsest thing on screen is a whole minute.
  useEffect(() => {
    // `id`, not `t` — that name is the translator now.
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const Help_ = desktopSurfaces.help;
  const Confirm = desktopSurfaces.confirm;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h1>{t({ k: 'list.title' })}</h1>
        <div className="sidebar-tools">
          {/* Same data-testid as the phone's pair in SessionList.tsx: ui-shot drives whichever of
              the two is on screen for the device it is shooting. */}
          <button className="icon-btn" data-testid="help" aria-label={t({ k: 'a11y.help' })} onClick={() => setHelp(true)}><Help size={16} /></button>
          <button className="icon-btn" data-testid="logout" aria-label={t({ k: 'a11y.logout' })} onClick={() => setConfirmLogout(true)}><SignOut size={16} /></button>
        </div>
      </div>
      <div className="chips">
        {(['active', 'all'] as Filter[]).map((f) => (
          <button key={f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => onFilter(f)}>
            {t({ k: f === 'active' ? 'list.filterActive' : 'list.filterAll' })}
          </button>
        ))}
      </div>
      {perm === 'default' && (
        <button className="notify-banner" onClick={async () => { await requestNotifyPermission(); setPerm(notifyPermission()); }}>
          {t({ k: 'list.notifyOnApproval' })}
        </button>
      )}
      <div className="sidebar-scroll">
        <div className="session-list">
          {shown.length === 0 && (
            <div className="empty">
              {t({ k: connection === 'online' ? 'list.emptySidebar' : 'list.connecting' })}
            </div>
          )}
          {shown.map((s) => <SessionRow key={s.id} s={s} onOpen={onOpen} active={s.id === activeId} />)}
        </div>
      </div>
      {help && <Help_ onDismiss={() => setHelp(false)} />}
      {confirmLogout && (
        /* One key set with the phone's confirm in SessionList.tsx — this copy used to be
           duplicated verbatim in both files, so a wording change meant two edits. */
        <Confirm
          title={t({ k: 'list.logoutTitle' })}
          body={t({ k: 'list.logoutBody' })}
          confirmLabel={t({ k: 'a11y.logout' })}
          onConfirm={onLogout}
          onDismiss={() => setConfirmLogout(false)}
        />
      )}
    </aside>
  );
}
