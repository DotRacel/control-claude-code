/**
 * auth.ts — the account REST calls (see /v1/auth/* in src/server/index.ts).
 *
 * A token is issued once at registration and never rotates, so "logging in" is really just
 * fetching the token again — which is why the same value can be pasted into a second device.
 */

// The bare module `t`, not the hook: this file is not a component. A thrown AuthError is caught and
// rendered by AuthGate immediately, so there is no window in which its wording could go stale.
import { t, type MsgKey } from './i18n/index.ts';

export interface Account {
  token: string;
  username: string;
}

/**
 * Carries a message this CLIENT worded, chosen by the error TYPE.
 *
 * It used to prefer `data.error.message`, on the reasoning that the server had already explained
 * the failure "in the user's language". That stopped being true the moment there were two
 * languages: the server's strings are Chinese (src/server/index.ts:184-204), so an English UI
 * showed a Chinese sentence for every rejected login. The `type` is the stable half of that
 * contract — it is what the server actually promises — so the catalog is keyed on it, and the
 * server's own words survive only as the fallback for a type this client has never heard of.
 */
export class AuthError extends Error {
  constructor(message: string, readonly type: string) { super(message); }
}

/**
 * Every `error.type` /v1/auth/* can answer with.
 *
 * Two of these deliberately lose a number the server had: it writes the password minimum and the
 * retry delay into the SENTENCE ("密码至少 8 位", "请 42 秒后再试") and nowhere else in the body, so
 * a client keyed on `type` cannot recover them. Digging them back out with a regex would couple
 * this file to the server's exact wording; the real fix is a structured `min_length` / `retry_after`
 * field, which is a server change and out of scope here. The generic wording is what the client's
 * own fallback already said, so this is no worse than the path it replaces.
 */
const AUTH_ERRORS: Record<string, MsgKey> = {
  registration_closed: 'auth.registrationClosed',
  bad_invite_code: 'auth.badInviteCode',
  bad_username: 'auth.badUsername',
  weak_password: 'auth.weakPassword',
  username_taken: 'auth.usernameTaken',
  bad_credentials: 'auth.badCredentials',
  too_many_attempts: 'auth.tooManyAttempts',
};

async function post(path: string, body: unknown): Promise<Account> {
  let r: Response;
  try {
    r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new AuthError(t({ k: 'auth.network' }), 'network');
  }
  const data = await r.json().catch(() => ({} as any));
  if (!r.ok) {
    const type = data?.error?.type ?? 'unknown';
    const key = AUTH_ERRORS[type];
    throw new AuthError(key ? t({ k: key }) : (data?.error?.message || t({ k: 'auth.failed', p: { status: r.status } })), type);
  }
  return { token: String(data.token), username: String(data.username) };
}

export const register = (username: string, password: string, inviteCode: string): Promise<Account> =>
  post('/v1/auth/register', { username, password, invite_code: inviteCode });

export const login = (username: string, password: string): Promise<Account> =>
  post('/v1/auth/login', { username, password });

/**
 * Is this token still good?
 *
 * The three outcomes are deliberately distinct: a 401 means the token is dead and the user must
 * log in again, but a network failure means we simply cannot tell — and kicking someone back to
 * the login screen because the server was briefly unreachable would lose a perfectly good
 * session. Only 'rejected' clears the cookie.
 */
export async function checkToken(token: string): Promise<{ status: 'ok'; username: string } | { status: 'rejected' } | { status: 'unreachable' }> {
  try {
    const r = await fetch('/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) return { status: 'rejected' };
    if (!r.ok) return { status: 'unreachable' };
    const data = await r.json().catch(() => ({} as any));
    return { status: 'ok', username: String(data.username ?? '') };
  } catch {
    return { status: 'unreachable' };
  }
}
