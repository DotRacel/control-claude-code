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
import { Lock, Check, Help, SignOut } from '../icons.tsx';
import { HelpSheet, ConfirmSheet } from './Sheets.tsx';
import { notifyPermission, requestNotifyPermission } from '../notify.ts';
import { t } from '../i18n/index.ts';
import { useT } from '../i18n/react.ts';

export type Filter = 'active' | 'all';

/** The one place that decides what "活跃" means, so the sidebar and the phone list agree. */
export const filterSessions = (sessions: SessionView[], f: Filter): SessionView[] =>
  sessions.filter((s) => (f === 'active' ? s.status === 'active' : true));

/** Exported so the sidebar reads the same clock; a plain function, so it uses the bare `t` and
 * relies on its calling component being subscribed. */
export function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return t({ k: 'time.justNow' });
  if (s < 3600) return t({ k: 'time.minutesAgo', p: { n: Math.round(s / 60) } });
  if (s < 86400) return t({ k: 'time.hoursAgo', p: { n: Math.round(s / 3600) } });
  return t({ k: 'time.daysAgo', p: { n: Math.round(s / 86400) } });
}

function elapsed(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function SessionList({ sessions, connection, onOpen, onLogout }: {
  sessions: SessionView[];
  connection: string;
  onOpen: (s: SessionView) => void;
  onLogout: () => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState<Filter>('active');
  const [perm, setPerm] = useState(notifyPermission());
  const [help, setHelp] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
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
        <h1>{t({ k: 'list.title' })}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          {/* data-testid, because test/ui-shot.ts drives these two and an aria-label that changes
              with the language is not something a screenshot script can hold on to. */}
          <button className="icon-btn" data-testid="help" aria-label={t({ k: 'a11y.help' })} onClick={() => setHelp(true)}><Help size={17} /></button>
          <button className="icon-btn" data-testid="logout" aria-label={t({ k: 'a11y.logout' })} onClick={() => setConfirmLogout(true)}><SignOut size={17} /></button>
        </div>
      </div>
      <div className="chips">
        {(['active', 'all'] as Filter[]).map((f) => (
          <button key={f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {t({ k: f === 'active' ? 'list.filterActive' : 'list.filterAll' })}
          </button>
        ))}
      </div>
      {perm === 'default' && (
        <button className="notify-banner" onClick={async () => { await requestNotifyPermission(); setPerm(notifyPermission()); }}>
          {t({ k: 'list.notifyOnApproval' })}
        </button>
      )}
      <div className="scroll">
        <div className="session-list">
          {shown.length === 0 && (
            <div className="empty">
              {t({ k: connection === 'online' ? 'list.emptyPhone' : 'list.connecting' })}
            </div>
          )}
          {shown.map((s) => <SessionCard key={s.id} s={s} onOpen={onOpen} />)}
        </div>
      </div>
      {help && <HelpSheet onDismiss={() => setHelp(false)} />}
      {confirmLogout && (
        <ConfirmSheet
          title={t({ k: 'list.logoutTitle' })}
          body={t({ k: 'list.logoutBody' })}
          confirmLabel={t({ k: 'a11y.logout' })}
          onConfirm={onLogout}
          onDismiss={() => setConfirmLogout(false)}
        />
      )}
    </div>
  );
}

export function SessionCard({ s, onOpen, active }: { s: SessionView; onOpen: (s: SessionView) => void; active?: boolean }) {
  const t = useT();
  const d = s.digest ?? ({ toolCalls: 0, pendingApproval: false, turnActive: false } as SessionView['digest']);
  const running = d.toolStatus === 'running' && s.status === 'active';
  const attention = d.pendingApproval;

  return (
    <button
      className={`session-card${attention ? ' attention' : ''}${!d.turnActive && s.status !== 'active' ? ' done' : ''}${active ? ' current' : ''}`}
      onClick={() => onOpen(s)}
    >
      <div className="session-top">
        <span className="session-name ellipsis">{s.machine || t({ k: 'list.unknownDevice' })}</span>
        {attention
          ? <span className="badge-approval"><Lock size={11} stroke="#e5895f" />{t({ k: 'list.needsApproval' })}</span>
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
          <><Check size={12} stroke="#8a8781" />{t({ k: d.toolCalls === 1 ? 'list.doneWithToolsOne' : 'list.doneWithToolsMany', p: { n: d.toolCalls } })}</>
        ) : (
          <><span className={`dot ${s.status === 'active' ? 'on' : 'off'}`} />{t({ k: s.status === 'active' ? 'list.online' : 'list.offline' })}{s.dir ? ` · ${s.dir}` : ''}</>
        )}
      </div>
    </button>
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
export function SessionRow({ s, onOpen, active }: { s: SessionView; onOpen: (s: SessionView) => void; active?: boolean }) {
  const t = useT();
  const d = s.digest ?? ({ toolCalls: 0, pendingApproval: false, turnActive: false } as SessionView['digest']);
  const running = d.toolStatus === 'running' && s.status === 'active';
  // One dot for four states, most urgent first: an approval outranks a running tool, which
  // outranks merely being online.
  const [state, label] = d.pendingApproval
    ? ['wait', t({ k: 'list.needsApproval' })]
    : running
      ? ['run', t({ k: 'list.runningTool', p: { tool: toolDisplayName(d.tool!) } })]
      : s.status === 'active' ? ['on', t({ k: 'list.online' })] : ['off', t({ k: 'list.offline' })];
  const name = s.machine || t({ k: 'list.unknownDevice' });

  return (
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
  );
}
