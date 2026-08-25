/**
 * deeplink.ts — open the session named in the URL the CLI printed.
 *
 * `/rc` prints (and QRs) `<origin>/code/session_<hex>`. The server answers that with a 302 to
 * `/?s=<id>` — see the `/rc` deep link arm in src/server/index.ts for why it cannot serve the SPA
 * at `/code/*` directly. This module reads the id back out.
 *
 * Two things are deliberate:
 *
 * 1. **Capture at module load, before React mounts, and rewrite the URL immediately.** Otherwise a
 *    reload would keep re-forcing the session after the user had navigated back to the list, and an
 *    installed PWA would end up bookmarking a per-session start_url. The value lives in memory from
 *    then on, which is what lets it survive the AuthGate → Home transition on a phone that has to
 *    log in first (AuthGate resolves by setState, never by reloading).
 *
 * 2. **The raw `/code/<id>` path is accepted too.** The redirect is the normal route, but this way
 *    the app still works behind a proxy that rewrites or swallows it.
 */

const ID_RE = /^(?:cse|session)_[0-9A-Za-z]{4,64}$/;

let pending: string | null = null;

/** The requested session id, once. Reading it consumes it. */
export function takeDeepLinkSession(): string | null {
  const v = pending;
  pending = null;
  return v;
}

/** `cse_abc` and `session_abc` name the same session — claude's prefix shim can go either way. */
export const sessionIdBody = (id: string): string => id.replace(/^(?:cse|session)_/, '');

(function capture() {
  try {
    if (typeof location === 'undefined' || typeof history === 'undefined') return;
    const u = new URL(location.href);
    const raw = u.searchParams.get('s') ?? /^\/code\/([^/?#]+)\/?$/.exec(u.pathname)?.[1] ?? null;
    if (!raw || !ID_RE.test(raw)) return;
    pending = raw;
    u.searchParams.delete('s');
    const path = u.pathname.startsWith('/code/') ? '/' : u.pathname;
    history.replaceState(null, '', path + (u.searchParams.size ? '?' + u.searchParams : '') + u.hash);
  } catch {
    // A hostile or exotic URL must not stop the app from booting.
  }
})();
