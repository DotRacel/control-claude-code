/**
 * surface-parts.tsx — the contents of the five modal surfaces, with no container around them.
 *
 * A phone puts each of these in a bottom sheet with a drag handle; a desktop puts four in a
 * centred modal and one in a popover. The container is the only difference — the permission
 * buttons, the output's copy action, the mode list and the install instructions are the same
 * words either way, and having two copies would mean fixing the next wording change twice.
 *
 * The markup here is byte-for-byte what Sheets.tsx used to emit inline, so the phone's DOM (and
 * therefore its screenshots) is unchanged by the extraction.
 */
import { useState } from 'react';
import type { PermissionRequest, ToolCall } from '../model.ts';
import type { PermissionAnswer } from '../ws.ts';
import { toolDisplayName, toolArg, durationLabel } from '../tools.ts';
import { haptic } from '../haptics.ts';
import { useCopy } from '../clipboard.ts';
import { Lock, Copy, Info, Gear, Pencil, Globe } from '../icons.tsx';
import { t, setLocale, LOCALES, type MsgKey } from '../i18n/index.ts';
import { useT, useLocale, tNode } from '../i18n/react.ts';

/** The worker's own suggestion, phrased as a button. Only ever what it offered — the client
 * never invents a rule, and it cannot reach the machine's settings.json. */
function suggestionLabel(s: any): string | null {
  if (!s || typeof s !== 'object') return null;
  if (s.type === 'addRules') {
    const r = Array.isArray(s.rules) ? s.rules[0] : undefined;
    if (!r) return null;
    return r.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r.toolName ?? '');
  }
  if (s.type === 'setMode') return s.mode === 'acceptEdits' ? t({ k: 'mode.acceptEdits' }) : String(s.mode ?? '');
  if (s.type === 'addDirectories') return (Array.isArray(s.directories) ? s.directories[0] : '') || t({ k: 'perm.thisDir' });
  return null;
}

export function PermissionBody({ req, cwd, onAnswer }: {
  req: PermissionRequest;
  cwd?: string;
  onAnswer: (a: PermissionAnswer) => void;
}) {
  const t = useT();
  const name = req.displayName || toolDisplayName(req.toolName);
  const arg = toolArg(req.toolName, req.input);
  const suggestion = req.suggestions.map((s) => ({ s, label: suggestionLabel(s) })).find((x) => x.label);

  return (
    <div className="sheet-pad">
      <div className="perm-head">
        <span className="perm-icon"><Lock size={19} stroke="#e5895f" /></span>
        <div>
          <div className="t1">{t({ k: 'perm.wantsToRun', p: { name } })}</div>
          {cwd && <div className="t2">{t({ k: 'perm.inDir', p: { cwd } })}</div>}
        </div>
      </div>
      <div className="perm-cmd">{arg || JSON.stringify(req.input, null, 2)}</div>
      {req.reason && <div className="perm-why"><Info size={13} />{req.reason}</div>}
      <div className="perm-actions">
        <button className="btn primary tall" onClick={() => { haptic('light'); onAnswer({ behavior: 'allow' }); }}>{t({ k: 'perm.allowOnce' })}</button>
        {suggestion && (
          <button className="btn tall" onClick={() => { haptic('light'); onAnswer({ behavior: 'allow', updatedPermissions: [suggestion.s] }); }}>
            {t({ k: 'perm.alwaysAllow' })}<span className="rule">{suggestion.label}</span>
          </button>
        )}
        <button className="btn tall danger" onClick={() => { haptic('medium'); onAnswer({ behavior: 'deny' }); }}>{t({ k: 'perm.deny' })}</button>
      </div>
    </div>
  );
}

export function OutputBody({ call }: { call: ToolCall }) {
  const t = useT();
  const dur = durationLabel(call.endedAt && call.startedAt ? call.endedAt - call.startedAt : undefined);
  const body = call.result ?? '';
  const { label, failed, copy } = useCopy(body);
  return (
    <>
      <div className="out-head">
        <div>
          <div className="t1">{toolDisplayName(call.name)}</div>
          <div className="t2">{toolArg(call.name, call.input)}</div>
        </div>
        <div className="out-meta">
          {call.status === 'error' ? <span style={{ color: 'var(--danger)' }}>{t({ k: 'tool.failed' })}</span> : t({ k: 'tool.done' })}
          {dur && <><br />{dur}</>}
        </div>
      </div>
      <div className="sheet-scroll">
        <div className={`out-body${call.status === 'error' ? ' fail' : ''}`}>{body || t({ k: 'output.empty' })}</div>
      </div>
      <div className="out-actions">
        <button className={`btn${failed ? ' fail' : ''}`} style={{ flex: 1 }} onClick={copy}><Copy size={15} />{label}</button>
      </div>
    </>
  );
}

/** The `id` is the worker's own mode string and stays verbatim; only the label has a language. */
const MODES: Array<{ id: string; label: MsgKey }> = [
  { id: 'default', label: 'mode.default' },
  { id: 'acceptEdits', label: 'mode.acceptEdits' },
  { id: 'plan', label: 'mode.plan' },
  { id: 'bypassPermissions', label: 'mode.bypassPermissions' },
];

export function MenuBody({ meta, mode, onMode, onEnd, onDismiss }: {
  meta: string;
  mode?: string;
  onMode: (m: string) => void;
  onEnd: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  // One `page` instead of the old boolean, now that there are two sub-pages to drill into.
  const [page, setPage] = useState<'root' | 'modes' | 'lang'>('root');
  const modeLabel = MODES.find((m) => m.id === mode)?.label;
  return (
    <>
      <div className="menu-meta">{meta}</div>
      {page === 'modes' ? (
        <>
          <div className="menu-label">{t({ k: 'menu.permMode' })}</div>
          <div className="menu-group">
            {MODES.map((m) => (
              <button key={m.id} className="menu-row" onClick={() => { haptic('light'); onMode(m.id); onDismiss(); }}>
                <Gear size={18} />{t({ k: m.label })}
                {mode === m.id && <span className="val">{t({ k: 'menu.current' })}</span>}
              </button>
            ))}
          </div>
        </>
      ) : page === 'lang' ? (
        <>
          <div className="menu-label">{t({ k: 'menu.language' })}</div>
          <div className="menu-group">
            {/* No onDismiss: the point of switching language is to SEE it happen, and closing the
                sheet on the tap would hide the one screen that just changed. */}
            {LOCALES.map((l) => (
              <button key={l.id} className="menu-row" onClick={() => { haptic('light'); setLocale(l.id); }}>
                <Globe size={18} />{t({ k: l.name })}
                {locale === l.id && <span className="val">{t({ k: 'menu.current' })}</span>}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="menu-group">
          <button className="menu-row" onClick={() => setPage('modes')}>
            <Gear size={18} />{t({ k: 'menu.permMode' })}<span className="val">{modeLabel ? t({ k: modeLabel }) : mode ?? '—'}</span>
          </button>
          <button className="menu-row" onClick={() => setPage('lang')}>
            <Globe size={18} />{t({ k: 'menu.language' })}<span className="val">{t({ k: locale === 'zh' ? 'lang.zh' : 'lang.en' })}</span>
          </button>
          {/* Rename needs a column the sessions table does not have yet. */}
          <button className="menu-row" disabled style={{ opacity: .4 }}><Pencil size={18} />{t({ k: 'menu.renameSession' })}<span className="val">{t({ k: 'menu.nextVersion' })}</span></button>
          <button className="menu-row danger" onClick={() => { haptic('medium'); onEnd(); onDismiss(); }}>
            <span style={{ width: 15, height: 15, borderRadius: 3, background: 'var(--danger)', display: 'block' }} />{t({ k: 'menu.stopTurn' })}
          </button>
        </div>
      )}
    </>
  );
}

/** A command block. It scrolls rather than wraps (a wrapped command gets pasted wrong), which on
 * a phone makes selecting it by hand hopeless — hence the copy button rather than a bare block. */
function Cmd({ text }: { text: string }) {
  const { label, failed, copy } = useCopy(text);
  return (
    <div className="help-cmd">
      <button className={`md-copy${failed ? ' fail' : ''}`} type="button" onClick={copy}>{label}</button>
      <pre>{text}</pre>
    </div>
  );
}

/**
 * What used to be the home screen's dashed "要开一个新会话？" card, now behind the ? button and
 * long enough to actually be instructions: a client cannot start claude on your machine, so the
 * only useful answer is how to install and run the thing that can.
 */
export function HelpBody() {
  const t = useT();
  return (
    <>
      <div className="menu-meta">{t({ k: 'help.meta' })}</div>
      <div className="sheet-scroll">
        <div className="sheet-pad">
          <ol className="help-steps">
            <li>
              <b>{t({ k: 'help.step1Title' })}</b>
              {/* tNode, not t: the <code> spans are structure, and splitting the sentence into
                  three keys would leave every language to reassemble it in the right order. */}
              <p>{tNode({ k: 'help.step1Body' }, { code: <code>claude</code> })}</p>
              <Cmd text="npm i -g control-claude-code" />
            </li>
            <li>
              <b>{t({ k: 'help.step2Title' })}</b>
              <p>{tNode({ k: 'help.step2Body' }, {
                config: <code>~/.config/control-claude-code/config.json</code>,
                login: <code>--login</code>,
              })}</p>
              <Cmd text="control-claude" />
            </li>
            <li>
              <b>{t({ k: 'help.step3Title' })}</b>
              <p>{t({ k: 'help.step3Body' })}</p>
              <Cmd text={t({ k: 'help.rcCmd' })} />
            </li>
          </ol>
          <p className="help-note">
            {t({ k: 'help.note' })}
          </p>
        </div>
      </div>
    </>
  );
}

/** A destructive action asked twice. Dismissing (drag, backdrop, Esc) is always the "no". */
export function ConfirmBody({ title, body, confirmLabel, onConfirm, onDismiss }: {
  title: string;
  body?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <div className="sheet-pad">
      <div className="confirm-head">
        <div className="t1">{title}</div>
        {body && <div className="t2">{body}</div>}
      </div>
      <div className="perm-actions">
        <button className="btn tall danger" onClick={() => { haptic('medium'); onConfirm(); }}>{confirmLabel}</button>
        <button className="btn tall" onClick={onDismiss}>{t({ k: 'confirm.cancel' })}</button>
      </div>
    </div>
  );
}
