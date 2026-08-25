/**
 * i18n.test.ts — the catalogs stay in step, and no Chinese escapes them.
 *
 * `tsc` already makes a missing English key a build error (en.ts is typed `Record<MsgKey, string>`),
 * but the root has no typecheck script and CI runs `npm test` on two Node versions — so the key-set
 * check is repeated here, where it actually gates.
 *
 * The test that earns its keep is the last one. A 166-string migration is not finished when it
 * compiles; it is finished when nothing is left behind, and a leftover literal is invisible to
 * every other check in the repo — it type-checks, it renders, it just renders in one language.
 *
 * Run: node --test test/i18n.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZH } from '../web/src/i18n/zh.ts';
import { EN } from '../web/src/i18n/en.ts';
import { t, say, keyOf, negotiate, getLocale, setLocale, subscribe, type Locale } from '../web/src/i18n/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'web', 'src');

const CJK = /[一-鿿]/;
const PLACEHOLDERS = (s: string): string[] => (s.match(/\{(\w+)\}/g) ?? []).sort();

/** Every .ts/.tsx under web/src, recursively. */
const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });

/**
 * Strip comments so a Chinese comment does not read as a Chinese string. Deliberately crude — it
 * is a lint, not a parser, and the repo keeps real Chinese in comments (domain glossary terms like
 * 凭证A, and quoted old copy) that must not fail this.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('the English catalog has exactly the keys the Chinese one defines', () => {
  assert.deepEqual(Object.keys(EN).sort(), Object.keys(ZH).sort());
});

test('a translation keeps every placeholder the original had', () => {
  for (const k of Object.keys(ZH) as Array<keyof typeof ZH>) {
    // The bug this pins: a translator drops `{n}` and the count silently vanishes from the line.
    assert.deepEqual(PLACEHOLDERS(EN[k]), PLACEHOLDERS(ZH[k]), `placeholders differ for ${k}`);
  }
});

test('no English value is empty, and none is still Chinese', () => {
  for (const [k, v] of Object.entries(EN)) {
    assert.ok(v.length > 0, `${k} is empty`);
    // lang.zh is the exception by design: a language names itself in its own language.
    if (k === 'lang.zh') continue;
    assert.ok(!CJK.test(v), `${k} was never translated: ${v}`);
  }
});

test('a bare string is wire text and passes through untranslated', () => {
  // The contract that lets every passthrough assignment in the reducer stay as it was.
  assert.equal(t('已提交 · main'), '已提交 · main');
  assert.equal(say('en', 'sigkill'), 'sigkill');
  assert.equal(keyOf('sigkill'), null);
  assert.equal(keyOf({ k: 'divider.reset' }), 'divider.reset');
});

test('parameters interpolate, and nest when one is itself a message', () => {
  assert.equal(say('en', { k: 'tool.readMany', p: { n: 3 } }), 'Read 3 lines');
  assert.equal(say('zh', { k: 'tool.readMany', p: { n: 3 } }), '读了 3 行');
  // The compaction divider: a translated suffix inside a translated stem, which is the case the
  // reducer cannot assemble itself without knowing a language.
  assert.equal(
    say('en', { k: 'divider.compacted', p: { why: { k: 'compact.auto' }, size: ' · 1k → 2k' } }),
    'Context compacted · auto · 1k → 2k',
  );
});

test('a clock time is formatted in the reader locale, not the reducer', () => {
  // 2026-08-21T17:50:00Z. Only that the two languages format it differently matters here — the
  // exact rendering is Intl's and depends on the runtime's timezone.
  const msg = { k: 'status.resetsAt' as const, p: { time: { t: 1787334600 } } };
  assert.match(say('zh', msg), /重置/);
  assert.match(say('en', msg), /resets/);
});

test('a placeholder with no value stays visible instead of vanishing', () => {
  // Degrading loudly is the decision: a stray `{n}` is a bug report, a missing number is a lie.
  assert.match(say('en', { k: 'tool.readMany' }), /\{n\}/);
});

test('a browser that does not ask for Chinese does not get it', () => {
  assert.equal(negotiate(['zh-CN', 'en']), 'zh');
  assert.equal(negotiate(['zh']), 'zh');
  // Traditional readers get Simplified rather than English: closer, if not right.
  assert.equal(negotiate(['zh-TW']), 'zh');
  assert.equal(negotiate(['zh_HK']), 'zh');
  assert.equal(negotiate(['en-GB']), 'en');
  assert.equal(negotiate(['fr', 'de']), 'en');
  assert.equal(negotiate([]), 'en');
  // 'zhosa' must not match 'zh' — the separator check is load-bearing.
  assert.equal(negotiate(['zhosa']), 'en');
  assert.equal(negotiate(['zhx-Latn']), 'en');
});

test('a locale change notifies every subscriber once, and a no-op change notifies nobody', () => {
  const before = getLocale();
  let calls = 0;
  const off1 = subscribe(() => { calls++; });
  const off2 = subscribe(() => { calls++; });
  const other: Locale = before === 'zh' ? 'en' : 'zh';

  setLocale(other);
  assert.equal(getLocale(), other);
  assert.equal(calls, 2, 'both subscribers heard it');

  // The early-out matters: without it useSyncExternalStore can re-render in a loop.
  setLocale(other);
  assert.equal(calls, 2, 'setting the language it already is must not notify');

  off1(); off2();
  setLocale(before);
  assert.equal(calls, 2, 'an unsubscribed listener hears nothing');
});

test('nothing outside the catalog still ships Chinese to the UI', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    // zh.ts IS the Chinese, and en.ts names 中文 in its own language.
    if (/i18n[\\/](zh|en)\.ts$/.test(file)) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, i) => {
      if (CJK.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [], `user-facing Chinese outside the catalog:\n${offenders.join('\n')}`);
});
