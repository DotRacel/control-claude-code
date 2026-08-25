/**
 * AuthGate.tsx — register / log in, and hand the App the account token.
 *
 * The token IS the credential (凭证A) the websocket connects with, so a successful login here
 * replaces what used to be "paste the string the CLI printed". Pasting is still available as a
 * third mode: moving to a second device is legitimately faster that way, and the token is
 * verified against /v1/auth/me before it is stored either way.
 */
import { useState, type FormEvent } from 'react';
import { register, login, checkToken, AuthError, type Account } from '../auth.ts';
import { ClaudeMark } from '../icons.tsx';
import { setLocale, LOCALES } from '../i18n/index.ts';
import { useT, useLocale } from '../i18n/react.ts';

type Mode = 'login' | 'register' | 'token';

export function AuthGate({ onAuthed }: { onAuthed: (a: Account) => void }) {
  const t = useT();
  const locale = useLocale();
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = mode === 'token'
    ? token.trim().length > 0
    : username.trim().length > 0 && password.length > 0 && (mode === 'login' || invite.trim().length > 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'token') {
        // `tok`, not `t` — that name is the translator in this component now.
        const tok = token.trim();
        const check = await checkToken(tok);
        if (check.status === 'ok') onAuthed({ token: tok, username: check.username });
        else setError(t({ k: check.status === 'rejected' ? 'auth.tokenRejected' : 'auth.network' }));
      } else if (mode === 'login') {
        onAuthed(await login(username.trim(), password));
      } else {
        onAuthed(await register(username.trim(), password, invite.trim()));
      }
    } catch (err) {
      setError(err instanceof AuthError ? err.message : t({ k: 'auth.unknown' }));
    } finally {
      setBusy(false);
    }
  }

  const switchTo = (m: Mode) => { setMode(m); setError(''); };

  return (
    <div className="center-screen">
      <form className="panel" onSubmit={submit}>
        <div className="logo-mark"><ClaudeMark size={34} fill="#fefcfb" /></div>
        <h1>Claude Remote</h1>

        <div className="auth-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'}
            className={mode === 'login' ? 'on' : ''} onClick={() => switchTo('login')}>{t({ k: 'auth.tabLogin' })}</button>
          {/* data-testid: ui-shot used to find this by matching textContent === '注册' exactly,
              which was the most brittle selector in the whole harness. */}
          <button type="button" role="tab" aria-selected={mode === 'register'} data-testid="auth-register"
            className={mode === 'register' ? 'on' : ''} onClick={() => switchTo('register')}>{t({ k: 'auth.tabRegister' })}</button>
        </div>

        {mode === 'token' ? (
          <>
            <p>{t({ k: 'auth.pasteToken' })}</p>
            <input className="cred-input" placeholder="ccc_…" value={token} autoFocus
              onChange={(e) => setToken(e.target.value)}
              autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </>
        ) : (
          <>
            <input className="cred-input text" placeholder={t({ k: 'auth.username' })} value={username}
              onChange={(e) => setUsername(e.target.value)} autoComplete="username"
              autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <input className="cred-input text" type="password" placeholder={t({ k: 'auth.password' })} value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            {mode === 'register' && (
              <input className="cred-input text" placeholder={t({ k: 'auth.invite' })} value={invite}
                onChange={(e) => setInvite(e.target.value)}
                autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            )}
          </>
        )}

        {error && <p className="auth-error" role="alert">{error}</p>}

        <button className="btn primary block" type="submit" disabled={!ready || busy}>
          {t({ k: busy ? 'auth.busy' : mode === 'register' ? 'auth.registerAndConnect' : 'auth.connect' })}
        </button>

        <button type="button" className="auth-alt" onClick={() => switchTo(mode === 'token' ? 'login' : 'token')}>
          {t({ k: mode === 'token' ? 'auth.switchToPassword' : 'auth.switchToToken' })}
        </button>

        {mode === 'register' && <p>{t({ k: 'auth.inviteNote' })}</p>}

        {/*
          The switcher has to exist HERE and not only in the session menu: the menu is behind a
          login, and someone whose browser negotiated the wrong language cannot read the form that
          would get them there. This is the one screen where being stuck is unrecoverable.
        */}
        <div className="auth-langs">
          {LOCALES.map((l) => (
            <button key={l.id} type="button" className={`auth-lang${locale === l.id ? ' on' : ''}`}
              onClick={() => setLocale(l.id)}>{t({ k: l.name })}</button>
          ))}
        </div>
      </form>
    </div>
  );
}
