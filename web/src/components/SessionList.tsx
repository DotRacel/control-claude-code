/**
 * SessionList.tsx — home (design 1a). Live sessions surface the running tool; a pending
 * permission is the only badge that ever gets accent colour.
 *
 * The row content comes from the server-derived digest (src/server/store.ts foldDigest), so the
 * list is accurate without subscribing to every transcript.
 *
 * The design's "New session" button is deliberately not here: a phone cannot start claude on
 * your machine — `control-claude` is launched from your terminal — so the ? button explains
 * how instead of offering a button that could not work.
 */
import { useEffect, useState } from 'react';
import type { SessionView } from '../ws.ts';
import { toolDisplayName } from '../tools.ts';
import { Lock, Check, Help, SignOut, Trash } from '../icons.tsx';
import { HelpSheet, ConfirmSheet } from './Sheets.tsx';
import { notifyPermission, requestNotifyPermission } from '../notify.ts';

export type Filter = 'active' | 'all';

/** The one place that decides what "活跃" means, so the sidebar and the phone list agree. */
export const filterSessions = (sessions: SessionView[], f: Filter): SessionView[] =>
  sessions.filter((s) => (f === 'active' ? s.status === 'active' : true));

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

/** One wording for both layouts, so the phone and the rail cannot drift apart on what delete means. */
export const deleteWarning = (s: SessionView): string =>
  `「${s.machine || '未知设备'}」的聊天记录会一起删掉，无法恢复。电脑上的 claude 不受影响。`;

function elapsed(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function SessionList({ sessions, connection, onOpen, onLogout, onDelete }: {
  sessions: SessionView[];
  connection: string;
  onOpen: (s: SessionView) => void;
  onLogout: () => void;
  onDelete?: (s: SessionView) => void;
}) {
  const [filter, setFilter] = useState<Filter>('active');
  const [perm, setPerm] = useState(notifyPermission());
  const [help, setHelp] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  /** The session whose delete is awaiting confirmation, held rather than its id so the sheet can
   * name it even if the list is re-pushed underneath. */
  const [confirmDelete, setConfirmDelete] = useState<SessionView | null>(null);
  const [, tick] = useState(0);

  // Keep "2m 14s" honest while a tool runs.
  useEffect(() => {
    const running = sessions.some((s) => s.digest?.toolStatus === 'running');
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [sessions]);

  const shown = filterSessions(sessions, filter);

  return (
    <div className="screen">
      <div className="topbar-lg">
        <h1>会话</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="icon-btn" aria-label="帮助" onClick={() => setHelp(true)}><Help size={17} /></button>
          <button className="icon-btn" aria-label="退出登录" onClick={() => setConfirmLogout(true)}><SignOut size={17} /></button>
        </div>
      </div>
      <div className="chips">
        {(['active', 'all'] as Filter[]).map((f) => (
          <button key={f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'active' ? '活跃' : '全部'}
          </button>
        ))}
      </div>
      {perm === 'default' && (
        <button className="notify-banner" onClick={async () => { await requestNotifyPermission(); setPerm(notifyPermission()); }}>
          需要审批时通知我
        </button>
      )}
      <div className="scroll">
        <div className="session-list">
          {shown.length === 0 && (
            <div className="empty">
              {connection === 'online' ? '还没有会话。点右上角的 ? 看怎么开一个。' : '正在连接…'}
            </div>
          )}
          {/* No handler while the socket is down: `deleteSession` would be dropped without a word,
              and a button that silently does nothing is worse than one that is not there. */}
          {shown.map((s) => (
            <SessionCard key={s.id} s={s} onOpen={onOpen} onDelete={onDelete && connection === 'online' ? setConfirmDelete : undefined} />
          ))}
        </div>
      </div>
      {help && <HelpSheet onDismiss={() => setHelp(false)} />}
      {confirmLogout && (
        <ConfirmSheet
          title="退出登录？"
          body="这台设备会忘掉密钥，下次要重新登录。电脑上的会话不受影响，继续跑。"
          confirmLabel="退出登录"
          onConfirm={onLogout}
          onDismiss={() => setConfirmLogout(false)}
        />
      )}
      {confirmDelete && (
        <ConfirmSheet
          title="删除这个会话？"
          body={deleteWarning(confirmDelete)}
          confirmLabel="删除"
          onConfirm={() => { onDelete?.(confirmDelete); setConfirmDelete(null); }}
          onDismiss={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

/**
 * The delete affordance, shared by both row shapes.
 *
 * A SIBLING of the card, never a child: the card is a `<button>` and nesting one button inside
 * another is invalid HTML — the browser hoists it out and the two click targets stop being
 * separable. Hence the `.session-item` wrapper, whose only job is to be the positioning context.
 *
 * Absolutely positioned rather than laid out in the row, so a list where only some sessions are
 * deletable still has one straight right edge, and so the desktop rail can fade it in on hover
 * without the row's width twitching under the pointer.
 */
function DeleteButton({ s, onDelete }: { s: SessionView; onDelete: (s: SessionView) => void }) {
  return (
    <button className="row-del" aria-label={`删除会话 ${s.machine || '未知设备'}`} title="删除会话" onClick={() => onDelete(s)}>
      <Trash size={15} />
    </button>
  );
}

/**
 * Deletable = offline, and only when the caller offered a handler at all (it withholds one while
 * the socket is down, since the frame would be dropped silently). A live session is refused by
 * the server — deleting it would void the ingress token its claude is holding — so a button on
 * that row could only ever fail.
 */
const isDeletable = (s: SessionView, onDelete?: (s: SessionView) => void): boolean =>
  !!onDelete && s.status !== 'active';

export function SessionCard({ s, onOpen, active, onDelete }: {
  s: SessionView;
  onOpen: (s: SessionView) => void;
  active?: boolean;
  onDelete?: (s: SessionView) => void;
}) {
  const d = s.digest ?? ({ toolCalls: 0, pendingApproval: false, turnActive: false } as SessionView['digest']);
  const running = d.toolStatus === 'running' && s.status === 'active';
  const attention = d.pendingApproval;
  const deletable = isDeletable(s, onDelete);

  return (
    <div className={`session-item${deletable ? ' deletable' : ''}`}>
      <button
        className={`session-card${attention ? ' attention' : ''}${!d.turnActive && s.status !== 'active' ? ' done' : ''}${active ? ' current' : ''}`}
        onClick={() => onOpen(s)}
      >
        <div className="session-top">
          <span className="session-name ellipsis">{s.machine || '未知设备'}</span>
          {attention
            ? <span className="badge-approval"><Lock size={11} stroke="#e5895f" />需要审批</span>
            : <span className="session-when">{relTime(s.lastActivity)}</span>}
        </div>
        {d.prompt && <div className="session-prompt">{d.prompt}</div>}
        <div className="session-meta">
          {running ? (
            <>
              <span className="dot run" />
              {toolDisplayName(d.tool!)}{d.toolArg ? ` · ${d.toolArg.split('\n')[0].slice(0, 40)}` : ''}
              {d.toolStartedAt ? ` · ${elapsed(d.toolStartedAt)}` : ''}
            </>
          ) : d.toolCalls > 0 ? (
            <><Check size={12} stroke="#8a8781" />完成 · {d.toolCalls} 次工具调用</>
          ) : (
            <><span className={`dot ${s.status === 'active' ? 'on' : 'off'}`} />{s.status === 'active' ? '在线' : '离线'}{s.dir ? ` · ${s.dir}` : ''}</>
          )}
        </div>
      </button>
      {deletable && <DeleteButton s={s} onDelete={onDelete!} />}
    </div>
  );
}

/**
 * SessionRow — the desktop rail's row: a dot, a name, a time, on one line.
 *
 * The phone's `SessionCard` is a digest because the list IS the screen there — it has to answer
 * "what is this session doing" before you commit to opening it. The rail never has to: the
 * transcript is already open one pane over. So the prompt excerpt and the tool line, ~115px of
 * card, bought nothing and cost the rail its whole point — four sessions filled it.
 *
 * The status WORD goes with them. The dot carries it (colour, plus a pulse while a tool runs) and
 * `title` + `.sr-only` keep the words for hover and for screen readers, so this is a smaller row
 * rather than a quieter one — the one place the design's "never a dot alone" rule (0c) bends,
 * because the label is still there, just not spending a line.
 */
export function SessionRow({ s, onOpen, active, onDelete }: {
  s: SessionView;
  onOpen: (s: SessionView) => void;
  active?: boolean;
  onDelete?: (s: SessionView) => void;
}) {
  const d = s.digest ?? ({ toolCalls: 0, pendingApproval: false, turnActive: false } as SessionView['digest']);
  const running = d.toolStatus === 'running' && s.status === 'active';
  // One dot for four states, most urgent first: an approval outranks a running tool, which
  // outranks merely being online.
  const [state, label] = d.pendingApproval
    ? ['wait', '需要审批']
    : running
      ? ['run', `运行中 · ${toolDisplayName(d.tool!)}`]
      : s.status === 'active' ? ['on', '在线'] : ['off', '离线'];
  const name = s.machine || '未知设备';
  const deletable = isDeletable(s, onDelete);

  return (
    <div className={`session-item${deletable ? ' deletable' : ''}`}>
      <button
        // No `attention` class: the border it used to colour is gone, so `.dot.wait` is the signal.
        className={`session-card compact${active ? ' current' : ''}`}
        onClick={() => onOpen(s)}
        title={`${name} · ${label}${s.dir ? ` · ${s.dir}` : ''}`}
      >
        <span className={`dot ${state}`} />
        <span className="session-name ellipsis">{name}</span>
        <span className="sr-only">{label}</span>
        <span className="session-when">{relTime(s.lastActivity)}</span>
      </button>
      {deletable && <DeleteButton s={s} onDelete={onDelete!} />}
    </div>
  );
}
