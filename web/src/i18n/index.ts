/**
 * i18n/index.ts — which language we are in, and the one function that turns a `Msg` into text.
 *
 * THIS FILE MUST NOT IMPORT REACT, and the reason is a runtime failure rather than taste: react
 * lives in `web/node_modules`, the root package has only `pg`/`esbuild`, and `test/render-history.ts`
 * runs from the repo root while needing `t()` to print a status line. The React binding therefore
 * lives next door in i18n/react.ts, and everything a Node tool needs is here.
 *
 * `t()` is a plain module function rather than only a hook because half the call sites are not
 * components either: auth.ts formats a fetch failure, tools.ts writes a tool's result line,
 * clipboard.ts labels a button.
 *
 * There is no React context anywhere in this feature, and that is deliberate — this app has never
 * had one (state is useState plus prop drilling all the way down), and threading a provider
 * through phone/desktop/render just to reach a string would be a lot of plumbing for a value that
 * is global by nature. A module-level store plus `useSyncExternalStore` is React 18's own answer.
 * It also means the language menu can flip the locale from inside `MenuBody` without
 * `LiveSurfaces.menu` growing a prop.
 *
 * Everything is guarded for a missing `document`/`navigator`, because the transcript tests and the
 * history dev tool import this in Node with no browser at all.
 */
import { ZH } from './zh.ts';
import { EN } from './en.ts';
import type { Msg, MsgKey, MsgParam, MsgParams } from './msg.ts';

export type { Msg, MsgKey, MsgParam, MsgParams };

export type Locale = 'zh' | 'en';

/** The switcher's rows. Each name is written in its own language, so it reads to the person who wants it. */
export const LOCALES: ReadonlyArray<{ id: Locale; name: MsgKey }> = [
  { id: 'zh', name: 'lang.zh' },
  { id: 'en', name: 'lang.en' },
];

const COOKIE = 'ccc_lang';
const TEN_YEARS = 10 * 365 * 24 * 3600;

// ── detection ──

/** An explicit choice, made in the session menu. Outranks the browser: the reader said so. */
function stored(): Locale | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)ccc_lang=([^;]+)/);
  const v = m ? decodeURIComponent(m[1]) : '';
  return v === 'zh' || v === 'en' ? v : null;
}

/**
 * The pure core of detection: BCP-47 tags in preference order → a locale we have.
 *
 * Exported and side-effect-free so test/i18n.test.ts can drive it with no browser. Tags are read in
 * order because someone whose phone is set to English with Chinese second is telling you both
 * things and the first match wins. Every `zh` tag collapses to Simplified — zh-TW and zh-HK readers
 * are far better served by Simplified than by English, and Traditional is a separate catalog for
 * another day.
 *
 * The separator is spelled out as `[-_]` rather than left to `\b`, which would have been the
 * obvious choice and would have been wrong: `_` is a word character, so `/^zh\b/` does not match
 * `zh_HK`. Both forms appear in the wild.
 */
export function negotiate(preferred: readonly string[]): Locale {
  for (const tag of preferred) if (tag && /^zh([-_]|$)/i.test(tag)) return 'zh';
  return 'en';
}

function fromBrowser(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  return negotiate(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

function detect(): Locale {
  return stored() ?? fromBrowser();
}

// ── the store ──

let current: Locale = detect();
const subs = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

/** The BCP-47 tag to hand `Intl`, which needs a region to format a clock time. */
export function localeTag(): string {
  return current === 'zh' ? 'zh-CN' : 'en-US';
}

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  if (typeof document !== 'undefined') {
    // Same shape as the credential cookie in ws.ts: ten years, Path=/, SameSite=Lax, Secure only
    // where it can be. A language preference is not a secret, it just has to survive a reload.
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${COOKIE}=${next}; Max-Age=${TEN_YEARS}; Path=/; SameSite=Lax${secure}`;
    document.documentElement.lang = next;
  }
  for (const f of subs) f();
}

/** Consumed by i18n/react.ts's `useSyncExternalStore`. Returns its own unsubscribe. */
export function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}

// ── formatting ──

const PLACEHOLDER = /\{(\w+)\}/g;

/** Falls back to English rather than to the raw key: a missing translation should still be readable. */
function lookup(key: MsgKey): string {
  return (current === 'zh' ? ZH[key] : EN[key]) ?? EN[key] ?? key;
}

function formatTime(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' });
}

function resolveParam(v: MsgParam): string {
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if ('t' in v) return formatTime(v.t);
  return t(v);
}

/**
 * A bare string passes straight through, untranslated — see the note in msg.ts about why that is
 * the contract and not an oversight. An unknown placeholder is left as written, so a mismatch
 * between a catalog string and its call site shows up on screen instead of vanishing.
 */
export function t(m: Msg): string {
  if (typeof m === 'string') return m;
  const tpl = lookup(m.k);
  const p = m.p;
  if (!p) return tpl;
  return tpl.replace(PLACEHOLDER, (whole, name: string) => (name in p ? resolveParam(p[name]) : whole));
}

/**
 * `say(locale, msg)` — render in a NAMED language, without touching the store.
 *
 * This is what lets one reducer output be asserted in both languages in the same test, and what
 * lets test/render-history.ts print stable English regardless of the shell it runs in.
 */
export function say(locale: Locale, m: Msg): string {
  const before = current;
  current = locale;
  try { return t(m); } finally { current = before; }
}

/** The catalog key a Msg names, or null when it is wire text deliberately left alone. Saves every
 * test and dev tool from narrowing the union by hand. */
export function keyOf(m: Msg): MsgKey | null {
  return typeof m === 'string' ? null : m.k;
}

/** Split a template into its literal and `{placeholder}` runs. Shared with i18n/react.ts, which
 * substitutes React nodes rather than strings — the splitting rule has to be the same one. */
export function splitTemplate(m: Msg): Array<{ lit: string } | { name: string }> {
  const tpl = typeof m === 'string' ? m : lookup(m.k);
  const out: Array<{ lit: string } | { name: string }> = [];
  let last = 0;
  for (const match of tpl.matchAll(PLACEHOLDER)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ lit: tpl.slice(last, at) });
    out.push({ name: match[1] });
    last = at + match[0].length;
  }
  if (last < tpl.length) out.push({ lit: tpl.slice(last) });
  return out;
}

export { resolveParam };

// The document opens as `lang="en"` (the static fallback a crawler sees); once the real locale is
// known, say so — assistive tech picks pronunciation from this attribute.
if (typeof document !== 'undefined') document.documentElement.lang = current;
