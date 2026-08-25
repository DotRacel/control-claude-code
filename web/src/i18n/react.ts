/**
 * i18n/react.ts — the half of i18n that needs React, kept apart from the half that must not.
 *
 * This is a two-file split for a runtime reason, not a stylistic one. `react` is installed in
 * web/node_modules; the root package.json has only `pg` and `esbuild`. test/render-history.ts and
 * the transcript tests run from the REPO ROOT and need `t()` to print and compare lines, so
 * i18n/index.ts has to be importable with no React anywhere in its graph. Everything that touches
 * React lives here instead, and nothing in test/ imports this file.
 *
 * There is no provider and no context. `t` reads the store when it is CALLED, so a component needs
 * nothing passed down — only a reason to re-render, which is what `useSyncExternalStore` supplies.
 *
 * The trap this file exists to document: a component that imports the bare `t` from ./index.ts
 * renders once in whatever language was current and then never updates. Non-component modules
 * (auth.ts, tools.ts) are the only legitimate callers of that. In a component, use `useT()`.
 */
import { useSyncExternalStore, createElement, Fragment, type ReactNode } from 'react';
import { subscribe, getLocale, splitTemplate, resolveParam, t, type Locale, type Msg } from './index.ts';

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

/**
 * `t`, plus a subscription to language changes.
 *
 * The returned function is the module-level `t` itself — deliberately the same object every time,
 * so it is safe in a dependency array and cannot go stale (it re-reads the locale on each call).
 * The re-render comes from `useLocale()`, not from a new identity.
 */
export function useT(): (m: Msg) => string {
  useLocale();
  return t;
}

/**
 * `t()` for copy with markup inside it — the help sheet's `<code>claude</code>` and its config
 * path. The alternative was splitting one sentence into three keys and trusting every language to
 * put its fragments back in the same order, which is how translations get mangled.
 *
 * Strings in the returned array need no key; only the substituted nodes do, hence the Fragment.
 */
export function tNode(m: Msg, nodes: Record<string, ReactNode>): ReactNode {
  const p = typeof m === 'string' ? undefined : m.p;
  const out: ReactNode[] = [];
  let key = 0;
  for (const part of splitTemplate(m)) {
    if ('lit' in part) { out.push(part.lit); continue; }
    const { name } = part;
    if (name in nodes) out.push(createElement(Fragment, { key: key++ }, nodes[name]));
    else if (p && name in p) out.push(resolveParam(p[name]));
    else out.push(`{${name}}`);
  }
  return out;
}
