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
  const [perm, setPerm] = useState(notifyPermission());
  const [help, setHelp] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [, tick] = useState(0);

  // Keep "3 分钟前" honest. Every 30s, not every second: the rows no longer show a running tool's
  // stopwatch, and the coarsest thing on screen is a whole minute.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const Help_ = desktopSurfaces.help;
  const Confirm = desktopSurfaces.confirm;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h1>会话</h1>
        <div className="sidebar-tools">
          <button className="icon-btn" aria-label="帮助" onClick={() => setHelp(true)}><Help size={16} /></button>
          <button className="icon-btn" aria-label="退出登录" onClick={() => setConfirmLogout(true)}><SignOut size={16} /></button>
        </div>
      </div>
      <div className="chips">
        {(['active', 'all'] as Filter[]).map((f) => (
          <button key={f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => onFilter(f)}>
            {f === 'active' ? '活跃' : '全部'}
          </button>
        ))}
      </div>
      {perm === 'default' && (
        <button className="notify-banner" onClick={async () => { await requestNotifyPermission(); setPerm(notifyPermission()); }}>
          需要审批时通知我
        </button>
      )}
      <div className="sidebar-scroll">
        <div className="session-list">
          {shown.length === 0 && (
            <div className="empty">
              {connection === 'online' ? '还没有会话。点上面的 ? 看怎么开一个。' : '正在连接…'}
            </div>
          )}
          {shown.map((s) => <SessionRow key={s.id} s={s} onOpen={onOpen} active={s.id === activeId} />)}
        </div>
      </div>
      {help && <Help_ onDismiss={() => setHelp(false)} />}
      {confirmLogout && (
        <Confirm
          title="退出登录？"
          body="这台设备会忘掉密钥，下次要重新登录。电脑上的会话不受影响，继续跑。"
          confirmLabel="退出登录"
          onConfirm={onLogout}
          onDismiss={() => setConfirmLogout(false)}
        />
      )}
    </aside>
  );
}
