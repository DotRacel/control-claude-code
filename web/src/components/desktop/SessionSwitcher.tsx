/**
 * SessionSwitcher.tsx — ⌘K. Type a few letters, hit Enter, you are in the other session.
 *
 * Deliberately NOT part of `LiveSurfaces`. That contract exists so a surface driven by shared
 * state cannot go missing on one platform; this one is driven by a key combination, and a phone has
 * no keyboard shortcut to trigger it. Forcing a phone implementation would mean writing something
 * that can never open — the opposite of what the contract is for.
 *
 * Matching is a subsequence, not a prefix: "rd" finds racel-dev, "ctl" finds a session whose
 * directory ends in claude-code-controller. That is what a ⌘K palette is expected to do, and it is
 * a different job from the composer's slash picker, which completes an exact command name and so
 * stays a prefix match.
 */
import { useMemo, useState } from 'react';
import type { SessionView } from '../../ws.ts';
import { Modal } from './Modal.tsx';
import { toolDisplayName } from '../../tools.ts';
// Only the hook is imported, not the bare `t`: `score()` below has a local `t` for its lowercased
// text, and a module-level one of the same name would be shadowed there in a confusing way.
import { useT } from '../../i18n/react.ts';

/** Subsequence match, scored so earlier and tighter runs win. null = no match. */
function score(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  let first = -1;
  let gaps = 0;
  let prev = -1;
  for (const ch of q) {
    const at = t.indexOf(ch, i);
    if (at < 0) return null;
    if (first < 0) first = at;
    if (prev >= 0 && at > prev + 1) gaps++;
    prev = at;
    i = at + 1;
  }
  return first + gaps * 2;
}

/** Everything about a session worth typing at: its machine, its directory, its branch. */
const haystack = (s: SessionView) => [s.machine, s.dir, s.branch].filter(Boolean).join(' ');

export function SessionSwitcher({ sessions, activeId, onOpen, onDismiss }: {
  sessions: SessionView[];
  activeId: string | null;
  onOpen: (s: SessionView) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);

  const hits = useMemo(() => {
    const scored = sessions
      .map((s) => ({ s, n: score(q, haystack(s)) }))
      .filter((x): x is { s: SessionView; n: number } => x.n !== null);
    // Ties break on recency, so an empty query lists what you were last in.
    scored.sort((a, b) => a.n - b.n || b.s.lastActivity - a.s.lastActivity);
    return scored.slice(0, 8).map((x) => x.s);
  }, [sessions, q]);

  const at = Math.min(sel, Math.max(0, hits.length - 1));

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length) setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = hits[at];
      if (pick) { onOpen(pick); onDismiss(); }
    }
    // Escape is Modal's, and it already stops there.
  };

  return (
    <Modal onDismiss={onDismiss} label={t({ k: 'switcher.title' })} width={520} align="top">
      <div className="palette">
        <input
          className="palette-input"
          autoFocus
          placeholder={t({ k: 'switcher.placeholder' })}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={keys}
        />
        <div className="palette-list">
          {hits.length === 0 && <div className="palette-empty">{t({ k: 'switcher.empty' })}</div>}
          {hits.map((s, i) => {
            const d = s.digest;
            const sub = d?.pendingApproval ? t({ k: 'list.needsApproval' })
              : d?.toolStatus === 'running' && d.tool ? t({ k: 'switcher.toolRunning', p: { tool: toolDisplayName(d.tool) } })
              : s.status === 'active' ? (s.dir || t({ k: 'list.online' })) : t({ k: 'list.offline' });
            return (
              <button
                key={s.id}
                className={`palette-row${i === at ? ' on' : ''}${s.id === activeId ? ' current' : ''}`}
                // Highlight follows the pointer as well, so the mouse and the keyboard never
                // disagree about which row Enter would take.
                onMouseEnter={() => setSel(i)}
                onClick={() => { onOpen(s); onDismiss(); }}
              >
                <span className="l ellipsis">{s.machine || t({ k: 'list.unknownDevice' })}</span>
                <span className="r ellipsis">{sub}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
