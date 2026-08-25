/**
 * qr.test.ts — the ASCII QR that goes under the `/rc` link.
 *
 * `renderQrAscii` compiles the very string we inject into the target (`QR_INJECT_SOURCE` minus the
 * assignment), so everything here is a test of the injected payload, not of a parallel copy. If the
 * payload stopped parsing, every case below would fail at once.
 *
 * The half-block encoding is losslessly invertible — four glyphs, two module bits — so
 * `modulesFrom()` reconstructs the exact symbol from the rendered text. That is what lets these
 * assertions be about the QR itself (finder patterns, timing, alignment, quiet zone) with no second
 * encoder to disagree with and no debug hatch in the shipped code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderQrAscii, QR_INJECT_SOURCE, QR_GLOBAL } from '../src/injector/qr.ts';

const SESSION_URL = 'https://ccc.racel.dev/code/session_5927e50246ee2379';
const ORIGIN = 'https://ccc.racel.dev';

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

/**
 * Rebuild the module matrix from rendered lines. `invert: false` output paints the LIGHT modules,
 * so a painted half means light — hence the `=== 0` reading below produces 1 for a DARK module.
 */
function modulesFrom(rendered: string): { size: number; at: (x: number, y: number) => number } {
  const lines = strip(rendered).split('\n').map((l) => [...l]);
  const width = lines[0].length;
  const grid: number[][] = [];
  for (const line of lines) {
    const top: number[] = [];
    const bottom: number[] = [];
    for (const ch of line) {
      top.push(ch === '█' || ch === '▀' ? 0 : 1);
      bottom.push(ch === '█' || ch === '▄' ? 0 : 1);
    }
    grid.push(top, bottom);
  }
  return { size: width, at: (x, y) => (y < 0 || y >= grid.length || x < 0 || x >= width ? 0 : grid[y][x]) };
}

/** Drop the quiet zone: module (0,0) of the symbol sits at (margin, margin) of the render. */
function symbolFrom(url: string, margin = 2) {
  const rendered = renderQrAscii(url, { margin, ansi: false, invert: false });
  assert.notEqual(rendered, '', 'expected a rendered QR');
  const g = modulesFrom(rendered);
  const size = g.size - margin * 2;
  return { size, margin, grid: g, at: (x: number, y: number) => g.at(x + margin, y + margin) };
}

test('the payload we inject is the payload we test', () => {
  assert.ok(QR_INJECT_SOURCE.startsWith(`globalThis.${QR_GLOBAL} = `));
  // The vendored encoder plus our renderer. A truncated blob would still "start with" the above.
  assert.ok(QR_INJECT_SOURCE.length > 50_000, `payload is only ${QR_INJECT_SOURCE.length}B`);
  assert.ok(QR_INJECT_SOURCE.includes('QR Code Generator for JavaScript'), 'vendored encoder missing');
  assert.ok(QR_INJECT_SOURCE.endsWith('; "ok"'), 'must report ok to Runtime.evaluate');
});

test('the session URL encodes as a version-3 symbol, 33 columns by 17 rows', () => {
  const rendered = renderQrAscii(SESSION_URL, { ansi: false });
  const lines = rendered.split('\n');
  assert.equal(lines.length, 17);
  for (const l of lines) assert.equal([...l].length, 33);
  // 51 bytes at ECC L needs version 3 (53-byte capacity): 29 modules + two 2-module quiet zones.
  assert.equal(symbolFrom(SESSION_URL).size, 29);
});

test('the version grows with the payload, one step at a time', () => {
  // Byte-mode capacities at ECC L: v1 17, v2 32, v3 53, v4 78, v5 106.
  for (const [len, size] of [
    [17, 21],
    [18, 25],
    [32, 25],
    [33, 29],
    [53, 29],
    [54, 33],
    [78, 33],
    [79, 37],
  ] as const) {
    assert.equal(symbolFrom('x'.repeat(len)).size, size, `${len} bytes should be ${size} modules`);
  }
});

test('the three finder patterns are bit-exact', () => {
  const s = symbolFrom(SESSION_URL);
  // A finder is a 7x7 with dark rings at Chebyshev distance 0-1 and 3, light at 2.
  const expected = (dx: number, dy: number) => {
    const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
    return d === 2 ? 0 : 1;
  };
  for (const [ox, oy] of [
    [0, 0],
    [s.size - 7, 0],
    [0, s.size - 7],
  ]) {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        assert.equal(s.at(ox + dx, oy + dy), expected(dx, dy), `finder at ${ox},${oy} cell ${dx},${dy}`);
      }
    }
  }
});

test('separators, timing patterns, the dark module and the alignment pattern are in place', () => {
  const s = symbolFrom(SESSION_URL);
  // Separator: the light row/column just outside each finder.
  for (let i = 0; i < 8; i++) {
    assert.equal(s.at(i, 7), 0, `top-left separator row at x=${i}`);
    assert.equal(s.at(7, i), 0, `top-left separator column at y=${i}`);
  }
  // Timing: row 6 and column 6 alternate, dark on even indices, between the separators.
  for (let i = 8; i < s.size - 8; i++) {
    assert.equal(s.at(i, 6), i % 2 === 0 ? 1 : 0, `horizontal timing at x=${i}`);
    assert.equal(s.at(6, i), i % 2 === 0 ? 1 : 0, `vertical timing at y=${i}`);
  }
  assert.equal(s.at(8, s.size - 8), 1, 'the always-dark module');
  // One alignment pattern for v2..v6, centred at 4*version + 10 — 22 for version 3.
  const c = 4 * ((s.size - 17) / 4) + 10;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      assert.equal(s.at(c + dx, c + dy), d === 1 ? 0 : 1, `alignment cell ${dx},${dy}`);
    }
  }
});

test('the quiet zone is painted light on all four sides', () => {
  const margin = 2;
  const s = symbolFrom(SESSION_URL, margin);
  const w = s.size + margin * 2;
  for (let i = 0; i < w; i++) {
    for (let k = 0; k < margin; k++) {
      assert.equal(s.grid.at(i, k), 0, `top quiet row ${k}`);
      assert.equal(s.grid.at(i, w - 1 - k), 0, `bottom quiet row ${k}`);
      assert.equal(s.grid.at(k, i), 0, `left quiet column ${k}`);
      assert.equal(s.grid.at(w - 1 - k, i), 0, `right quiet column ${k}`);
    }
  }
});

test('the same URL always renders the same symbol', () => {
  assert.equal(renderQrAscii(SESSION_URL, { ansi: false }), renderQrAscii(SESSION_URL, { ansi: false }));
});

test('inverting swaps which half of each cell is painted, and nothing else', () => {
  const plain = renderQrAscii(SESSION_URL, { ansi: false, invert: false }).split('\n');
  const flipped = renderQrAscii(SESSION_URL, { ansi: false }).split('\n');
  const swap: Record<string, string> = { '█': ' ', ' ': '█', '▀': '▄', '▄': '▀' };
  // Every row but the last, which is a special case in its own right (below).
  for (let i = 0; i < plain.length - 1; i++) {
    assert.equal(flipped[i], [...plain[i]].map((c) => swap[c] ?? c).join(''), `row ${i}`);
  }
});

test('the quiet zone survives the odd row count, on all four sides of the visible code', () => {
  // Module counts are always odd, so count + 2*margin is odd and the last text row covers one
  // real module row plus a half that does not exist. Upstream paints that half; inverted it would
  // be a black bar under the code, right where the quiet zone has to be.
  const rows = renderQrAscii(SESSION_URL, { ansi: false }).split('\n');
  assert.equal(rows[0].trim(), '', 'the top quiet row must be blank');
  assert.equal(rows[rows.length - 1].trim(), '', 'the bottom quiet row must be blank');
  for (const r of rows) {
    assert.equal(r.slice(0, 2), '  ', 'the left quiet columns must be blank');
    assert.equal(r.slice(-2), '  ', 'the right quiet columns must be blank');
  }
});

test('every line states black-on-white absolutely, because dimColor would otherwise grey it out', () => {
  const lines = renderQrAscii(SESSION_URL).split('\n');
  for (const l of lines) {
    // Leading 0 resets whatever colour the ink fork's dimColor substituted in.
    assert.ok(l.startsWith('[0;38;2;0;0;0;48;2;255;255;255m'), `missing colour prologue: ${JSON.stringify(l.slice(0, 40))}`);
    assert.ok(l.endsWith('[0m'), 'missing reset');
    assert.equal([...strip(l)].length, 33, 'escapes must not change the visible width');
  }
});

test('it declines rather than draws something unscannable', () => {
  // Wider than the terminal: a soft-wrapped QR is worse than no QR.
  assert.equal(renderQrAscii(SESSION_URL, { maxWidth: 20 }), '');
  assert.notEqual(renderQrAscii(SESSION_URL, { maxWidth: 33 }), '');
  // The int.weburl interlock: never make a crisp, scannable link to somebody else's host.
  assert.equal(renderQrAscii('https://claude.ai/code/session_5927e50246ee2379', { origin: ORIGIN }), '');
  assert.notEqual(renderQrAscii(SESSION_URL, { origin: ORIGIN }), '');
  // No input, no QR — and no throw either way.
  assert.equal(renderQrAscii(''), '');
  assert.equal(renderQrAscii(undefined as unknown as string), '');
});

test('a self-hosted origin long enough to need a bigger symbol still renders', () => {
  const long = 'https://claude-remote.internal.example.com:8443/ccc/code/session_5927e50246ee2379';
  assert.equal(long.length, 81);
  assert.equal(symbolFrom(long).size, 37, '81 bytes overflows version 4 (78) and needs version 5');
  assert.notEqual(renderQrAscii(long, { maxWidth: 80 }), '');
});
