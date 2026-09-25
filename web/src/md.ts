/**
 * md.ts — the small markdown subset Claude actually emits, rendered to React nodes.
 *
 * No dependency and no `innerHTML`: everything becomes createElement calls, so a model that
 * writes `<img onerror=…>` produces text, not markup. The design doc draws assistant output as
 * plain prose, but real transcripts are full of fenced code, lists and bold — unrendered they
 * read worse than rendered.
 *
 * Supported: fenced code, ATX headings (#..###), thematic breaks, blockquotes, ordered and
 * unordered lists (one nesting level), GFM tables, paragraphs; inline code, bold, italic, links.
 * Anything else falls through as literal text, which is the correct failure mode here.
 */
import { createElement as h, type ReactNode } from 'react';
import { useCopy } from './clipboard.ts';

/** Code blocks get a copy button: selecting monospace text by touch is miserable. */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { label, failed, copy } = useCopy(code);
  return h('div', { className: 'md-pre', 'data-lang': lang || undefined },
    h('button', { className: `md-copy${failed ? ' fail' : ''}`, type: 'button', onClick: copy }, label),
    h('pre', null, h('code', null, code)),
  );
}

// ── inline ──
// Alternation order matters: code first (so ** inside a span is literal), then ** before *.
const INLINE = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]*)\]\(([^)\s]+)\)/g;

function inline(src: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(src); m; m = INLINE.exec(src)) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const key = `${keyBase}i${n++}`;
    if (m[2] !== undefined) out.push(h('code', { key }, m[2]));
    else if (m[3] !== undefined) out.push(h('strong', { key }, m[3]));
    else if (m[4] !== undefined) out.push(h('strong', { key }, m[4]));
    else if (m[5] !== undefined) out.push(h('em', { key }, m[5]));
    else if (m[6] !== undefined) out.push(h('em', { key }, m[6]));
    else if (m[8] !== undefined) {
      const href = m[8];
      // Only protocols that cannot execute script.
      const safe = /^(https?:|mailto:)/i.test(href);
      out.push(safe
        ? h('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, m[7] || href)
        : `${m[7] || ''}(${href})`);
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

// ── blocks ──
const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,3})\s+(.*)$/;
const HR = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;

// ── tables (GFM) ──
// A header row, then a delimiter row with exactly as many cells, then body rows until a line
// with no pipe or one that opens another block. Unlike GFM, a pipe-less line ends the table
// instead of becoming a one-cell row: prose written straight under a table stays prose.
const PIPE = /(?:^|[^\\])\|/;
const DELIM_CELL = /^:?-+:?$/;
type Align = 'left' | 'center' | 'right' | undefined;

/** The outer pipes are optional; `\|` is a literal pipe, inside code spans too — GFM's one way
 * to put a `|` in a cell. */
function cells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\' && s[j + 1] === '|') { cur += '|'; j++; }
    else if (s[j] === '|') { out.push(cur.trim()); cur = ''; }
    else cur += s[j];
  }
  out.push(cur.trim());
  return out;
}

/** The column alignments if `line` is a delimiter row for `n` columns, else null. */
function delimiter(line: string | undefined, n: number): Align[] | null {
  if (line === undefined || !PIPE.test(line)) return null;
  const c = cells(line);
  if (c.length !== n || !c.every((x) => DELIM_CELL.test(x))) return null;
  return c.map((x) => (x.endsWith(':') ? (x.startsWith(':') ? 'center' : 'right') : x.startsWith(':') ? 'left' : undefined));
}

const opensBlock = (line: string) => [FENCE, HEADING, QUOTE, BULLET, ORDERED].some((r) => r.test(line));

/** Width in half-width units — a CJK or full-width character is two — markup characters aside. */
function units(s: string): number {
  let n = 0;
  for (const ch of s.replace(/[`*]/g, '')) n += ch.codePointAt(0)! >= 0x2e80 ? 2 : 1;
  return n;
}
/** A column whose widest cell is at most this many units is a label, and never wraps (`.fit`).
 * Tied to the CSS: at the table's 14px it is about a third of a phone's 366px column. */
const FIT_UNITS = 14;

interface ListItem { text: string; nested: string[] }

export function renderMarkdown(src: string): ReactNode {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;

  const flushParagraph = (buf: string[]) => {
    if (!buf.length) return;
    const text = buf.join('\n').trim();
    if (text) out.push(h('p', { key: `p${k++}` }, ...inline(text, `p${k}`)));
    buf.length = 0;
  };

  const para: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph(para);
      const marker = fence[1][0];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker === '`' ? '```' : '~~~'}+\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      out.push(h(CodeBlock, { key: `c${k++}`, code: body.join('\n'), lang: fence[2] }));
      continue;
    }
    const head = HEADING.exec(line);
    if (head) {
      flushParagraph(para);
      out.push(h(`h${head[1].length}` as 'h1', { key: `h${k++}` }, ...inline(head[2].trim(), `h${k}`)));
      i++;
      continue;
    }
    if (HR.test(line)) {
      flushParagraph(para);
      out.push(h('hr', { key: `r${k++}` }));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      flushParagraph(para);
      const body: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]);
        if (!q) break;
        body.push(q[1]);
        i++;
      }
      out.push(h('blockquote', { key: `q${k++}` }, ...inline(body.join('\n').trim(), `q${k}`)));
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph(para);
      const tag = ordered ? 'ol' : 'ul';
      const items: ListItem[] = [];
      const baseIndent = (bullet ?? ordered)![1].length;
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const o = ORDERED.exec(lines[i]);
        const m = ordered ? (o ?? b) : (b ?? o);
        if (!m) break;
        const indent = m[1].length;
        if (indent > baseIndent && items.length) items[items.length - 1].nested.push(m[3]);
        else if (indent < baseIndent) break;
        else items.push({ text: m[3], nested: [] });
        i++;
      }
      out.push(h(tag, { key: `l${k++}` }, ...items.map((it, n) => h('li', { key: n },
        ...inline(it.text, `l${k}n${n}`),
        ...(it.nested.length ? [h('ul', { key: 'n' }, ...it.nested.map((t, j) => h('li', { key: j }, ...inline(t, `l${k}n${n}s${j}`))))] : []),
      ))));
      continue;
    }
    const header = PIPE.test(line) ? cells(line) : null;
    const align = header && delimiter(lines[i + 1], header.length);
    if (header && align) {
      flushParagraph(para);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && PIPE.test(lines[i]) && !opensBlock(lines[i])) {
        const r = cells(lines[i++]);
        rows.push(header.map((_, j) => r[j] ?? '')); // GFM: a short row pads, a long one drops
      }
      const key = `t${k++}`;
      const fit = header.map((c, j) => Math.max(units(c), ...rows.map((r) => units(r[j]))) <= FIT_UNITS);
      const cell = (tag: 'th' | 'td', text: string, j: number, kb: string) =>
        h(tag, { key: j, className: fit[j] ? 'fit' : undefined, style: align[j] && { textAlign: align[j] } }, ...inline(text, `${kb}c${j}`));
      // The wrapper, not the table, is the scroller: a <table> ignores overflow. An all-empty
      // header — how a key/value table is usually written — would draw only an empty band.
      out.push(h('div', { key, className: 'md-table' }, h('table', null,
        header.some(Boolean) ? h('thead', null, h('tr', null, ...header.map((c, j) => cell('th', c, j, `${key}h`)))) : null,
        rows.length ? h('tbody', null, ...rows.map((r, n) => h('tr', { key: n }, ...r.map((c, j) => cell('td', c, j, `${key}r${n}`))))) : null,
      )));
      continue;
    }
    if (!line.trim()) { flushParagraph(para); i++; continue; }
    para.push(line);
    i++;
  }
  flushParagraph(para);
  return out.length ? out : src;
}
