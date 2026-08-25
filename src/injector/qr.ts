/**
 * qr.ts — the ASCII QR code that goes under the `/rc` link.
 *
 * The code has to be drawn INSIDE the injected `claude` process. Nothing else works: in
 * interactive mode claude's ink TUI owns the terminal (`stdio: 'inherit'`), so the controller
 * cannot print a single byte after launch without corrupting the frame, and the session URL only
 * exists once claude has created the code-session — long after our last chance to print.
 *
 * So the encoder ships as SOURCE TEXT, is evaluated into the target's global scope during the
 * `?wait=1` pause (see gate-rebind), and `int.qrnudge` calls it from the paused frame to fill in
 * the `upgradeNudge` argument of claude's own bridge-status message factory.
 *
 * The encoder itself is vendored, not written here — see vendor/qrcode-generator.ts.
 *
 * ── Why we paint our own colours ──
 * The slot we render into is `<Text dimColor>`, and claude's ink fork does NOT implement dimColor
 * as SGR 2 — it substitutes the colour outright (`dimColor && !noColor ? theme.inactive : …`,
 * verified in the 2.1.241 bundle). So there is no "undim" escape, and the modules would come out
 * in the theme's grey. Grey-on-dark is only ~4:1 and grey-on-LIGHT is both low contrast and
 * inverted polarity, which is where phone scanners actually give up.
 *
 * The fix is to state the two colours absolutely, per line, in truecolor — black on white — and to
 * FLIP the vendored renderer's polarity to match. Upstream `createASCII` paints the foreground
 * where a module is LIGHT (right for bright-on-dark terminals); once the foreground is black,
 * the paint has to land on the DARK modules instead. `invert: true` does that with a 4-glyph swap,
 * and the result is a true dark-on-light symbol whatever the user's terminal theme is.
 */
import { QRCODE_GENERATOR_SRC } from './vendor/qrcode-generator.ts';

export interface QrOptions {
  /** Quiet zone, in modules. Default 2 — half the spec's 4, which is what fits in a transcript. */
  margin?: number;
  /** Emit nothing rather than something wider than this many columns (a wrapped QR is unscannable). */
  maxWidth?: number;
  /**
   * Refuse to encode a URL that does not start with this. The interlock for `int.weburl` missing
   * while `int.qrnudge` hits: better no QR than a crisp, scannable link to claude.ai.
   */
  origin?: string;
  /** Wrap each line in absolute black-on-white truecolor. Default true — see the header. */
  ansi?: boolean;
  /** Swap the vendored renderer's polarity so the DARK modules are the painted ones. Default true. */
  invert?: boolean;
}

/**
 * The part we own. `String.raw` keeps the `\n` in `split`/`join` as a two-character escape in the
 * emitted source rather than a real newline, and every control byte is assembled with
 * `fromCharCode` so none is ever written into this file. Returns '' — never throws — for every
 * failure it can see: this runs on claude's connect path, and a QR is a nicety that must not be
 * able to break `/rc`.
 */
const RENDERER = String.raw`function (text, opts) {
  var o = opts || {};
  try {
    var url = String(text || '');
    if (!url) return '';
    if (o.origin && url.indexOf(o.origin) !== 0) return '';
    var margin = o.margin === undefined ? 2 : o.margin;
    var q = qrcode(0, 'L');
    q.addData(url);
    q.make();
    if (o.maxWidth && q.getModuleCount() + margin * 2 > o.maxWidth) return '';
    var lines = q.createASCII(1, margin).split('\n');
    var invert = o.invert !== false;
    var swap = { '█': ' ', ' ': '█', '▀': '▄', '▄': '▀' };
    if (invert) {
      for (var i = 0; i < lines.length; i++) {
        var out = '';
        for (var j = 0; j < lines[i].length; j++) {
          var ch = lines[i].charAt(j);
          out += swap[ch] === undefined ? ch : swap[ch];
        }
        lines[i] = out;
      }
      // A symbol is always an odd number of modules across, so module count + 2*margin is odd
      // too, and the last text line therefore stands for ONE module row plus a half that does not
      // exist. Upstream draws it as half-blocks painted on top — right for its own polarity, where
      // paint means "light" and the missing half is just terminal background. Swapped, that
      // becomes a painted BOTTOM half: a black bar laid across the bottom of the quiet zone. The
      // row is nothing but quiet zone, so blank it — after the swap, or the blank inverts back.
      if (margin > 0 && (q.getModuleCount() + margin * 2) % 2 === 1) {
        lines[lines.length - 1] = Array(lines[lines.length - 1].length + 1).join(' ');
      }
    }
    var esc = String.fromCharCode(27);
    var open = o.ansi === false ? '' : esc + '[0;38;2;0;0;0;48;2;255;255;255m';
    var close = o.ansi === false ? '' : esc + '[0m';
    for (var k = 0; k < lines.length; k++) lines[k] = open + lines[k] + close;
    return lines.join('\n');
  } catch (e) {
    return '';
  }
}`;

/**
 * `var module, exports, define` shadow the vendored file's UMD tail so it finds no loader and
 * registers nothing; the IIFE keeps its `qrcode` binding off the target's globals, where claude
 * has a bundled `qrcode` of its own.
 */
const PAYLOAD = `(function () { var module, exports, define;\n${QRCODE_GENERATOR_SRC}\nreturn ${RENDERER};\n})()`;

/** The global the `int.qrnudge` rebind calls. Also the name gate-rebind installs. */
export const QR_GLOBAL = '__cccQr';

/** What gate-rebind evaluates in the target's wait state. */
export const QR_INJECT_SOURCE = `globalThis.${QR_GLOBAL} = ${PAYLOAD}; "ok"`;

let compiled: ((text: string, opts?: QrOptions) => string) | null = null;

/**
 * The same payload, compiled here instead of over there. Only tests call it — the CLI never does,
 * so a 57KB parse stays off the launch path. It goes through `new Function` on the exact string we
 * inject, which is the point: a passing test proves the injected source parses and behaves.
 */
export function renderQrAscii(text: string, opts?: QrOptions): string {
  if (!compiled) compiled = new Function('return ' + PAYLOAD)() as (text: string, opts?: QrOptions) => string;
  return compiled(text, opts);
}
