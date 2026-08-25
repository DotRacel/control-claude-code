/**
 * deeplink.test.ts — the phone half of the `/rc` QR: web/src/deeplink.ts.
 *
 * The module captures at import time and rewrites the URL immediately, so each case needs a fresh
 * instance. A cache-busting query on the specifier gives one; `location`/`history` are planted on
 * `globalThis` first, which is all the module touches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Loaded {
  taken: string | null;
  href: string;
  replaced: number;
}

let seq = 0;

async function load(href: string): Promise<Loaded> {
  let current = href;
  let replaced = 0;
  (globalThis as any).location = { get href() { return current; } };
  (globalThis as any).history = {
    replaceState(_s: unknown, _t: string, url: string) {
      current = new URL(url, 'https://ccc.racel.dev').href;
      replaced++;
    },
  };
  const mod = await import(`../web/src/deeplink.ts?case=${seq++}`);
  return { taken: mod.takeDeepLinkSession(), href: current, replaced };
}

test('the id the server redirect leaves in the query is picked up, and the query is cleaned', async () => {
  const r = await load('https://ccc.racel.dev/?s=session_5927e50246ee2379');
  assert.equal(r.taken, 'session_5927e50246ee2379');
  assert.equal(r.replaced, 1);
  assert.equal(new URL(r.href).search, '', 'the id must not survive a reload');
});

test('the raw /code path works too, for a proxy that swallows the redirect', async () => {
  const r = await load('https://ccc.racel.dev/code/cse_5927e50246ee2379');
  assert.equal(r.taken, 'cse_5927e50246ee2379');
  assert.equal(new URL(r.href).pathname, '/', 'must land on the root, where the assets resolve');
});

test('an unrelated query param is left alone', async () => {
  const r = await load('https://ccc.racel.dev/?s=session_dead0000beef1111&debug=1');
  assert.equal(r.taken, 'session_dead0000beef1111');
  assert.equal(new URL(r.href).search, '?debug=1');
});

test('it is consumed exactly once, so backing out to the list is not undone', async () => {
  const mod = await (async () => {
    (globalThis as any).location = { href: 'https://ccc.racel.dev/?s=session_5927e50246ee2379' };
    (globalThis as any).history = { replaceState() {} };
    return import(`../web/src/deeplink.ts?case=${seq++}`);
  })();
  assert.equal(mod.takeDeepLinkSession(), 'session_5927e50246ee2379');
  assert.equal(mod.takeDeepLinkSession(), null);
});

test('nothing that is not a session id is honoured, and nothing throws', async () => {
  for (const href of [
    'https://ccc.racel.dev/',
    'https://ccc.racel.dev/?s=',
    'https://ccc.racel.dev/?s=../../etc/passwd',
    'https://ccc.racel.dev/?s=session_x',
    'https://ccc.racel.dev/?s=' + 'session_' + 'a'.repeat(65),
    'https://ccc.racel.dev/?s=<script>alert(1)</script>',
    'https://ccc.racel.dev/code/',
    'https://ccc.racel.dev/code/not-a-session',
    'https://ccc.racel.dev/code/session_5927e50246ee2379/extra',
  ]) {
    const r = await load(href);
    assert.equal(r.taken, null, href);
    assert.equal(r.replaced, 0, `${href} must not rewrite the URL`);
  }
});

test('cse_ and session_ name the same session', async () => {
  const { sessionIdBody } = await import(`../web/src/deeplink.ts?case=${seq++}`);
  assert.equal(sessionIdBody('cse_5927e50246ee2379'), '5927e50246ee2379');
  assert.equal(sessionIdBody('session_5927e50246ee2379'), '5927e50246ee2379');
  assert.equal(sessionIdBody('ses-1234'), 'ses-1234', 'a headless session id is left as it is');
});
