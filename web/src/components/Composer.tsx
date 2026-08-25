/**
 * Composer.tsx — the one control the whole product runs through (design 1i).
 *
 * States: idle · typing (send turns accent) · agent running (send becomes a Stop square) ·
 * offline (read-only, the transcript is never cleared — 1g's rule) · slash picker.
 * The input's font-size matches .bubble-user exactly so sending never reflows the text.
 *
 * Keys, all of which have to coexist with a textarea that swallows almost everything:
 *   Enter        send (not on touch, where it inserts a newline and the button sends)
 *   Shift+Enter  newline
 *   ⌘/Ctrl+Enter send even with the slash picker open, which Enter would otherwise complete into
 *   ↑ ↓          move the picker's highlight — it used to paint the first row as selected while
 *                nothing could actually select it, so Enter sent the raw text instead
 *   Tab / Enter  take the highlighted command
 *   Esc          close the picker; pressed again with no picker, leave the field
 */
import { useEffect, useRef, useState } from 'react';
import { Plus, ArrowUp, ArrowDown } from '../icons.tsx';
import { haptic } from '../haptics.ts';
import { useT } from '../i18n/react.ts';

export function Composer({ busy, offline, slashCommands, skills, onSend, onStop, showToBottom, onToBottom }: {
  busy: boolean;
  offline: boolean;
  slashCommands: string[];
  skills: string[];
  onSend: (text: string) => void;
  onStop: () => void;
  showToBottom: boolean;
  onToBottom: () => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const [sel, setSel] = useState(0);
  // The picker is derived from the text, so "closed" needs its own flag — and it has to clear on
  // the next keystroke, or dismissing it once would keep it shut for the rest of the command.
  const [pickerOff, setPickerOff] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Grow to five lines, then scroll internally (0c, Dynamic Type up to XXL).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 7.5 * 16)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || offline) return;
    haptic('light');
    onSend(t);
    setText('');
    setSel(0);
    setPickerOff(false);
  };

  const slashQuery = pickerOff ? null : /^\/([\w:-]*)$/.exec(text);
  const matches = slashQuery
    ? [...new Set([...slashCommands, ...skills])].filter((c) => c.startsWith(slashQuery[1])).slice(0, 6)
    : [];
  const at = Math.min(sel, Math.max(0, matches.length - 1));

  const take = (c: string) => {
    setText(`/${c} `);
    setSel(0);
    ref.current?.focus();
  };

  return (
    <>
      {matches.length > 0 && (
        <div className="picker">
          {matches.map((c, i) => (
            <button key={c} className={`picker-row${i === at ? ' on' : ''}`} onClick={() => take(c)}>
              <span className="cmd">/{c}</span>
              <span className="desc">{t({ k: skills.includes(c) ? 'composer.skill' : 'composer.slash' })}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-wrap">
        {showToBottom && (
          <button className="to-bottom" onClick={onToBottom} aria-label={t({ k: 'a11y.toBottom' })}><ArrowDown size={20} /></button>
        )}
        <div className={`composer${focus ? ' focus' : ''}${offline ? ' readonly' : ''}`}>
          <textarea
            ref={ref}
            className="composer-input"
            rows={1}
            placeholder={t({ k: offline ? 'composer.offline' : busy ? 'composer.busy' : 'composer.idle' })}
            value={text}
            disabled={offline}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onChange={(e) => { setText(e.target.value); setPickerOff(false); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // A cascade, not a single meaning: shed the picker first, and only leave the field
                // once there is nothing left to shed.
                if (matches.length) { e.preventDefault(); setPickerOff(true); }
                else ref.current?.blur();
                return;
              }
              if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (matches.length && e.key === 'Tab') { e.preventDefault(); take(matches[at]); return; }
              if (e.key !== 'Enter' || e.shiftKey) return;
              // ⌘/Ctrl+Enter sends past the picker; a bare Enter completes it, since a half-typed
              // command is the likelier intent when the list is open.
              if (e.metaKey || e.ctrlKey) { e.preventDefault(); submit(); return; }
              // Completing applies on touch too — deliberately. Enter does not SEND on a phone
              // (that is the button's job), but a newline in the middle of `/rc` is no use to
              // anyone, and the picker was otherwise unreachable from a phone keyboard.
              if (matches.length) { e.preventDefault(); take(matches[at]); return; }
              if (!('ontouchstart' in window)) { e.preventDefault(); submit(); }
            }}
          />
          <div className="composer-row">
            <div className="composer-mode">
              <span className="sig">&lt;/&gt;</span>
              <span className="lbl">Code</span>
            </div>
            <div className="composer-actions">
              {/* `v`, not `t` — the updater's old parameter name now collides with the translator.
                  This is also the second aria-label="More" on a chat screen, hence the testid on
                  the header's one in ChatView.tsx. */}
              <button aria-label={t({ k: 'a11y.more' })} onClick={() => setText((v) => (v ? v : '/'))}><Plus size={22} /></button>
              {busy && !text.trim() ? (
                <button className="send" aria-label={t({ k: 'a11y.stop' })} onClick={() => { haptic('medium'); onStop(); }}>
                  <span className="send-square" />
                </button>
              ) : (
                <button className={`send${text.trim() ? ' ready' : ''}`} aria-label={t({ k: 'a11y.send' })} disabled={!text.trim() || offline} onClick={submit}>
                  <ArrowUp size={20} stroke="#fff" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
