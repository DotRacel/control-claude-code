/**
 * ui-shot.ts — drive a headless chromium at phone size against `ui-preview` and dump both
 * screenshots and layout numbers, so the mobile UI can be checked without a device.
 *
 * Speaks CDP directly (no puppeteer): chromium is launched with `--remote-debugging-port`, the
 * page target is picked out of `/json/list`, and `Emulation.setDeviceMetricsOverride` gives it a
 * real 390×844 mobile viewport (a `--window-size` alone is not the same thing — it leaves
 * `mobile:false`, so `dvh`, safe-area insets and touch media queries behave like a desktop).
 *
 * Run: node test/ui-shot.ts [--out artifacts/ui] [--keep] [--width 390] [--height 844]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreview } from './ui-preview.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n: string, d?: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const has = (n: string) => process.argv.includes(n);

const OUT = path.resolve(here, '..', arg('--out', 'artifacts/ui')!);
const BIN = process.env.CHROMIUM_BIN || 'chromium';
/**
 * Which language to shoot. Defaults to `zh` so the existing artifacts keep meaning what they
 * meant; `--lang en` shoots the English UI, which is how you check that no English label overflows
 * a chip or a button (the layout probe's alignment checks are content-independent, but its
 * overflow check is not).
 */
const LOCALE = arg('--lang', 'zh')!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Three targets, because the bugs differ between them. `phone` is a plain browser tab;
 * `pro-max-pwa` is the installed web app on an iPhone 15 Pro Max — 430×932, and crucially a real
 * top inset (59pt of Dynamic Island) and bottom inset (34pt of home indicator) plus
 * `display-mode: standalone`, none of which a bare --window-size gives you. `desktop` is the other
 * side of the 900px breakpoint, and has to be `mobile: false`: with touch emulation and an iPhone
 * UA the two-pane shell would still render, but every hover rule and the tool row's pointer path
 * would be tested in a browser pretending not to have a mouse.
 */
interface Device {
  name: string;
  width: number;
  height: number;
  dpr: number;
  insets?: { top: number; bottom: number; left: number; right: number };
  standalone?: boolean;
  /** Default true. False means a real desktop browser: no touch, no phone UA. */
  mobile?: boolean;
}
const DEVICES: Device[] = [
  { name: 'phone', width: 390, height: 844, dpr: 3 },
  { name: 'desktop', width: 1440, height: 900, dpr: 2, mobile: false },
  {
    name: 'pro-max-pwa', width: 430, height: 932, dpr: 3,
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
    standalone: true,
  },
];

// ── a minimal CDP client ──
class CDP {
  private ws!: WebSocket;
  private id = 0;
  private waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private listeners = new Map<string, ((p: any) => void)[]>();

  static async connect(url: string): Promise<CDP> {
    const c = new CDP();
    c.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => { c.ws.onopen = () => res(); c.ws.onerror = () => rej(new Error(`cdp connect failed: ${url}`)); });
    c.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id != null) {
        const w = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        if (!w) return;
        m.error ? w.rej(new Error(`${m.error.message} (${JSON.stringify(m.error.data ?? '')})`)) : w.res(m.result);
      } else if (m.method) {
        for (const fn of c.listeners.get(m.method) ?? []) fn(m.params);
      }
    };
    return c;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.waiting.delete(id)) rej(new Error(`${method} timed out`)); }, 30000);
    });
  }

  on(method: string, fn: (p: any) => void) {
    const l = this.listeners.get(method) ?? [];
    l.push(fn);
    this.listeners.set(method, l);
  }

  /** Resolve on the next occurrence of an event (or reject after `ms`). */
  once(method: string, ms = 15000): Promise<any> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} never fired`)), ms);
      this.on(method, (p) => { clearTimeout(t); res(p); });
    });
  }

  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  close() { try { this.ws.close(); } catch {} }
}

/**
 * `--app=<url>` is the only way to get `display-mode: standalone` to actually match: chromium
 * accepts `Emulation.setEmulatedMedia` with a `display-mode` feature and then ignores it
 * (verified — the query still reports `browser`). So an installed-web-app run needs its own
 * browser process, launched in app mode.
 */
async function launchChromium(userDataDir: string, appUrl?: string): Promise<{ proc: ChildProcess; wsUrl: string; devtoolsPort: number }> {
  const proc = spawn(BIN, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--no-first-run', '--no-default-browser-check',
    appUrl ? `--app=${appUrl}` : 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise<string>((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error(`chromium did not print a devtools url:\n${buf}`)), 20000);
    proc.stderr!.on('data', (c) => {
      buf += c;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(t); res(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(t); rej(new Error(`chromium exited (${code}):\n${buf}`)); });
  });
  return { proc, wsUrl, devtoolsPort: Number(new URL(wsUrl).port) };
}

/** The layout facts worth asserting on a phone, measured in the page. */
const PROBE = `(() => {
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const r = e.getBoundingClientRect();
    return { sel, top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1),
             w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             scrollH: e.scrollHeight, clientH: e.clientHeight, scrollW: e.scrollWidth, clientW: e.clientWidth }; };
  const vw = window.innerWidth, vh = window.innerHeight;
  // anything painting wider than the viewport, or below its bottom edge
  // …ignoring anything inside a deliberate horizontal scroller (code blocks, 0a) and the
  // visually-hidden live region.
  const inScroller = (e) => { for (let n = e.parentElement; n; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== 'visible') return true; } return false; };
  const overflow = [];
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (e.closest('.sr-only') || inScroller(e)) continue;
    if (r.right > vw + 0.5 || r.left < -0.5) overflow.push({ tag: e.tagName.toLowerCase(), cls: e.className && String(e.className).slice(0, 40), left: +r.left.toFixed(1), right: +r.right.toFixed(1) });
  }
  // every transcript item, so a card that renders as a 2px sliver is visible in the numbers
  const items = [...document.querySelectorAll('.chat > *')].map((e) => {
    const r = e.getBoundingClientRect();
    return String(e.className).trim().split(/\\s+/)[0] + '(h' + Math.round(r.height) + ' x' + Math.round(r.left) + ' w' + Math.round(r.width) + ')';
  });
  // The unit trap the installed app hit: under viewport-fit=cover with a translucent status bar,
  // WebKit resolves height:100% against an ICB that excludes the top inset (measured: 873 of 932
  // on a 15 Pro Max) while dvh matches the window. Chromium does NOT reproduce it — even with the
  // insets overridden its ICB stays the full viewport — so these numbers come out equal here and
  // the check only bites on a real device or if a percentage chain breaks some other way.
  // (No backticks anywhere in this probe — it lives in a template literal.)
  const unit = (css) => { const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:0;left:0;width:0;height:' + css;
    document.body.appendChild(d); const h = Math.round(d.getBoundingClientRect().height); d.remove(); return h; };
  const heights = { innerHeight: vh, dvh: unit('100dvh'), vhUnit: unit('100vh'), icb: document.documentElement.clientHeight };
  const scroller = document.querySelector('.scroll');
  // What the safe-area insets actually resolved to, where they matter.
  const padOf = (sel, side) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)['padding' + side] : null; };
  return {
    vw, vh, dpr: devicePixelRatio, items, heights,
    standalone: matchMedia('(display-mode: standalone)').matches,
    pads: { topbar: padOf('.topbar', 'Top') ?? padOf('.topbar-lg', 'Top'), composer: padOf('.composer-wrap', 'Bottom'), sheet: padOf('.sheet', 'Bottom') },
    scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
    scrollMax: scroller ? Math.round(scroller.scrollHeight - scroller.clientHeight) : null,
    docScrollH: document.documentElement.scrollHeight, docScrollW: document.documentElement.scrollWidth,
    bodyScrollH: document.body.scrollHeight,
    boxes: ['.phone-frame', '.screen', '.topbar', '.topbar-lg', '.banner', '.scroll', '.chat', '.composer-wrap', '.composer', '.session-list', '.sheet']
      .map(box).filter(Boolean),
    overflow: overflow.slice(0, 12),
  };
})()`;

interface Shot {
  name: string;
  setup?: (cdp: CDP) => Promise<void>;
  noCredential?: boolean;
  /** Device names this shot applies to. Omitted = all of them. */
  only?: string[];
}

/** Parse a probe item string "name(hN xN wN)" into numbers. */
function parseItem(s: string): { name: string; h: number; x: number; w: number } | null {
  const m = /^(.+?)\(h(-?\d+) x(-?\d+) w(-?\d+)\)$/.exec(s);
  return m ? { name: m[1], h: +m[2], x: +m[3], w: +m[4] } : null;
}

/**
 * Desktop transcript layout assertions — the check that was missing when the two-pane layout
 * shipped with left-pinned user bubbles and font-dependent item widths. Every transcript item
 * must share ONE column: same left edge, same width, centred in the pane, capped well inside it
 * (not full-bleed), with the composer on the same edge and no horizontal overflow. Returns a list
 * of human-readable failures (empty = pass). This is what turns ui-shot from a dumper into a gate.
 */
function checkDesktopLayout(probe: any): string[] {
  const fails: string[] = [];
  const items = ((probe.items ?? []) as string[]).map(parseItem).filter(Boolean) as { name: string; x: number; w: number }[];
  if (!items.length) return fails;
  const chat = probe.boxes?.find((b: any) => b.sel === '.chat');
  if (!chat) return fails;
  const paneCentre = (chat.left + chat.right) / 2;
  const paneW = chat.right - chat.left;
  const TOL = 2;

  const lefts = items.map((i) => i.x);
  const widths = items.map((i) => i.w);
  const dLeft = Math.max(...lefts) - Math.min(...lefts);
  const dWidth = Math.max(...widths) - Math.min(...widths);
  if (dLeft > TOL) fails.push(`item left edges vary by ${dLeft.toFixed(1)}px — the column is not aligned`);
  if (dWidth > TOL) fails.push(`item widths vary by ${dWidth.toFixed(1)}px — items do not share one measure`);
  // Capped, not full-bleed: a readable column leaves clear margin inside the pane.
  if (Math.max(...widths) > paneW - 40) fails.push(`items span ${Math.max(...widths)}px of a ${paneW.toFixed(0)}px pane — the readable cap is not applied`);
  // Centred (the bug: a left-pinned user bubble beside centred prose).
  const off = items.find((i) => Math.abs(i.x + i.w / 2 - paneCentre) > 3);
  if (off) fails.push(`${off.name} is off-centre (centre ${(off.x + off.w / 2).toFixed(0)} vs pane ${paneCentre.toFixed(0)})`);
  // Composer shares the column's edge.
  const composer = probe.boxes?.find((b: any) => b.sel === '.composer-wrap');
  if (composer && Math.abs(composer.left - items[0].x) > TOL) fails.push(`composer left ${composer.left} ≠ item left ${items[0].x}`);
  if (probe.overflow?.length) fails.push(`horizontal overflow: ${JSON.stringify(probe.overflow.slice(0, 2))}`);
  return fails;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const preview = await startPreview({ port: 0, username: 'uishot' });
  const base = `http://127.0.0.1:${preview.port}`;
  const consoleErrors: string[] = [];
  const layoutFailures: string[] = []; // desktop geometry assertions that did not hold

  const shots: Shot[] = [
    { name: '01-session-list' },
    {
      name: '02-chat-top',
      setup: async (c) => {
        await c.eval(`(() => { const b = [...document.querySelectorAll('.session-card')].find(e => e.textContent.includes('racel-dev')); b && b.click(); })()`);
        await sleep(900);
        await c.eval(`document.querySelector('.scroll.chat').scrollTop = 0`);
        await sleep(200);
      },
    },
    {
      name: '03-chat-bottom',
      setup: async (c) => {
        await c.eval(`(() => { const b = [...document.querySelectorAll('.session-card')].find(e => e.textContent.includes('racel-dev')); b && b.click(); })()`);
        await sleep(900);
        await c.eval(`(() => { const s = document.querySelector('.scroll.chat'); s.scrollTop = s.scrollHeight; })()`);
        await sleep(200);
      },
    },
    {
      name: '04-chat-composing',
      setup: async (c) => {
        await c.eval(`(() => { const b = [...document.querySelectorAll('.session-card')].find(e => e.textContent.includes('racel-dev')); b && b.click(); })()`);
        await sleep(900);
        await c.eval(`(() => {
          const t = document.querySelector('.composer-input');
          const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          set.call(t, '把会话页的布局问题修一下，尤其是转录区和输入框的高度分配，还有安全区\\n第二行\\n第三行');
          t.dispatchEvent(new Event('input', { bubbles: true }));
          t.focus();
        })()`);
        await sleep(400);
      },
    },
    {
      name: '05-permission-sheet',
      setup: async (c) => {
        await c.eval(`(() => { const b = [...document.querySelectorAll('.session-card')].find(e => e.textContent.includes('build-box')); b && b.click(); })()`);
        await sleep(1200);
      },
    },
    {
      name: '06-question-card',
      setup: async (c) => {
        await c.eval(`(() => { const b = [...document.querySelectorAll('.session-card')].find(e => e.textContent.includes('racel-dev')); b && b.click(); })()`);
        await sleep(900);
        await c.eval(`document.querySelector('.qcard').scrollIntoView({ block: 'start' })`);
        await sleep(300);
      },
    },
    {
      name: '07-output-sheet',
      setup: async (c) => {
        await c.eval(`(() => { const b = [...document.querySelectorAll('.session-card')].find(e => e.textContent.includes('racel-dev')); b && b.click(); })()`);
        await sleep(900);
        // Both platforms in one script: the phone's ToolRow opens on mouseup (it shares the code
        // path with the touch long-press), the desktop's on a real click — and a synthetic
        // mousedown/mouseup pair does not produce one.
        await c.eval(`(() => {
          const r = document.querySelectorAll('.tool-row:not([disabled])')[1];
          r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          r.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          r.click();
        })()`);
        await sleep(500);
      },
    },
    {
      name: '08-menu-sheet',
      setup: async (c) => {
        await c.eval(`(() => { const b = [...document.querySelectorAll('.session-card')].find(e => e.textContent.includes('racel-dev')); b && b.click(); })()`);
        await sleep(900);
        // data-testid, not the aria-label: the label is translated now, and there are two "More"
        // buttons on a chat screen (this header's and the composer's +) so matching the label
        // only ever worked by document order.
        await c.eval(`document.querySelector('[data-testid="session-menu"]').click()`);
        await sleep(500);
      },
    },
    {
      name: '09-help-sheet',
      setup: async (c) => {
        await c.eval(`document.querySelector('[data-testid="help"]').click()`);
        await sleep(500);
      },
    },
    {
      name: '10-logout-confirm',
      setup: async (c) => {
        await c.eval(`document.querySelector('[data-testid="logout"]').click()`);
        await sleep(500);
      },
    },
    {
      // The shapes a real history export turned up (images, task progress, conversation breaks).
      // Scrolled to, rather than at the bottom, because the fixture puts them mid-transcript.
      name: '13-image-and-breaks',
      setup: async (c) => {
        await c.eval(`(() => { const b = [...document.querySelectorAll('.session-card')].find(e => e.textContent.includes('racel-dev')); b && b.click(); })()`);
        await sleep(900);
        await c.eval(`(() => { const el = document.querySelector('.tool-images'); el && el.scrollIntoView({ block: 'center' }); })()`);
        await sleep(250);
      },
    },
    {
      name: '14-bgtask-progress',
      setup: async (c) => {
        await c.eval(`(() => { const b = [...document.querySelectorAll('.session-card')].find(e => e.textContent.includes('racel-dev')); b && b.click(); })()`);
        await sleep(900);
        await c.eval(`(() => { const el = [...document.querySelectorAll('.bgtask')].find(e => e.querySelector('.t3')); el && el.scrollIntoView({ block: 'center' }); })()`);
        await sleep(250);
      },
    },
    {
      // ⌘K has no phone counterpart, so on a phone this would just re-shoot the chat.
      name: '15-session-switcher',
      only: ['desktop'],
      setup: async (c) => {
        await c.eval(`(() => { const b = [...document.querySelectorAll('.session-card')].find(e => e.textContent.includes('racel-dev')); b && b.click(); })()`);
        await sleep(900);
        await c.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`);
        await sleep(300);
        await c.eval(`(() => {
          const i = document.querySelector('.palette-input');
          if (!i) return;
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          set.call(i, 'bo');
          i.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await sleep(300);
      },
    },
    { name: '11-auth-gate', noCredential: true },
    { name: '12-auth-gate-register', noCredential: true, setup: async (c) => {
      // Was an exact textContent match against '注册' — the most brittle selector in the harness.
      await c.eval(`document.querySelector('[data-testid="auth-register"]')?.click()`);
      await sleep(300);
    } },
  ];

  const only = arg('--device');
  const devices = only ? DEVICES.filter((d) => d.name === only) : DEVICES;
  if (!devices.length) throw new Error(`unknown --device; try: ${DEVICES.map((d) => d.name).join(', ')}`);

  const report: any[] = [];
  let written = 0;
  for (const d of devices) {
    const dir = path.join(OUT, d.name);
    fs.mkdirSync(dir, { recursive: true });

    // One browser per device: standalone needs --app, and it is set at launch.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-shot-'));
    const { proc, devtoolsPort } = await launchChromium(userDataDir, d.standalone ? base : undefined);
    const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
    const page = targets.find((t: any) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    cdp.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') consoleErrors.push(`[${d.name}] ${p.entry.text}`); });
    cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(`[${d.name}] ${p.args.map((a: any) => a.value ?? a.description).join(' ')}`); });
    const mobile = d.mobile !== false;
    if (mobile) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
      });
    }
    // mobile:true is what makes dvh/safe-area/touch behave like a device, not a small window.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: d.width, height: d.height, deviceScaleFactor: d.dpr, mobile,
      screenWidth: d.width, screenHeight: d.height,
    });
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: d.insets ?? {} });

    const insets = d.insets ? `insets ${d.insets.top}/${d.insets.bottom}` : 'no insets';
    const kind = d.standalone ? 'standalone (--app)' : mobile ? 'browser tab' : 'desktop browser';
    console.log(`\n╔═ ${d.name} — ${d.width}×${d.height} @${d.dpr}x, ${kind}, ${insets}`);

    for (const s of shots) {
      if (s.only && !s.only.includes(d.name)) continue;
      // Per shot, so clearing it for the gate cannot leak into a later one.
      if (s.noCredential) await cdp.send('Network.deleteCookies', { name: 'ccc_credential', url: base });
      else await cdp.send('Network.setCookie', { name: 'ccc_credential', value: preview.credential, url: base, path: '/' });
      // Pin the language. Headless chromium reports navigator.language = en-US, so without this
      // the SPA's own detection would render English here and Chinese on a reviewer's machine —
      // every screenshot would quietly mean something different run to run. Same cookie the
      // session menu writes, so this pins the product's real code path, not a test-only hook.
      await cdp.send('Network.setCookie', { name: 'ccc_lang', value: LOCALE, url: base, path: '/' });
      await cdp.send('Page.navigate', { url: base + '/' });
      await cdp.once('Page.loadEventFired');
      await sleep(700); // websocket connect + first `sessions` frame
      if (s.setup) await s.setup(cdp);
      const probe = await cdp.eval(PROBE);
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(dir, `${s.name}.png`), Buffer.from(png.data, 'base64'));
      written++;
      report.push({ device: d.name, shot: s.name, ...probe });
      console.log(`\n── ${d.name} / ${s.name} ──`);
      console.log(`viewport ${probe.vw}×${probe.vh}  doc ${probe.docScrollW}×${probe.docScrollH}  scrollTop ${probe.scrollTop}/${probe.scrollMax}  standalone=${probe.standalone}`);
      console.log(`  pads: topbar-top ${probe.pads.topbar}  composer-bottom ${probe.pads.composer}  sheet-bottom ${probe.pads.sheet ?? '—'}`);
      const H = probe.heights;
      console.log(`  heights: innerHeight ${H.innerHeight}  100dvh ${H.dvh}  100vh ${H.vhUnit}  ICB(100%) ${H.icb}${H.icb !== H.innerHeight ? `  ⚠ % is ${H.innerHeight - H.icb}px short` : ''}`);
      if (probe.items?.length) console.log(`  items: ${probe.items.join(' ')}`);
      // Assert the desktop transcript column, not just print it: a left-pinned bubble or a
      // font-dependent width is now a failed run, not a number someone has to notice by eye.
      if (d.name === 'desktop' && probe.items?.length) {
        const fails = checkDesktopLayout(probe);
        if (fails.length) {
          for (const f of fails) console.log(`  ✗ layout: ${f}`);
          layoutFailures.push(...fails.map((f) => `${s.name}: ${f}`));
        } else {
          console.log(`  ✓ layout: items aligned, capped and centred`);
        }
      }
      for (const b of probe.boxes) console.log(`  ${b.sel.padEnd(15)} y ${String(b.top).padStart(7)} → ${String(b.bottom).padStart(7)}  h ${String(b.h).padStart(7)}  x ${b.left}→${b.right}  scroll ${b.scrollW}×${b.scrollH} / client ${b.clientW}×${b.clientH}`);
      if (probe.overflow.length) console.log(`  ⚠ horizontal overflow:`, JSON.stringify(probe.overflow));
      // The bug the phone showed: the shell must end exactly at the viewport bottom.
      const screen = probe.boxes.find((b: any) => b.sel === '.screen');
      if (screen && Math.abs(screen.bottom - probe.vh) > 1) {
        console.log(`  ⚠ shell does not fill the viewport: .screen ends at ${screen.bottom}, viewport is ${probe.vh}`);
      }
      if (!!d.standalone !== !!probe.standalone) {
        console.log(`  ⚠ display-mode mismatch: wanted standalone=${!!d.standalone}, page reports ${probe.standalone}`);
      }
    }

    cdp.close();
    if (!has('--keep')) { proc.kill('SIGKILL'); fs.rmSync(userDataDir, { recursive: true, force: true }); }
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  if (consoleErrors.length) console.log(`\n⚠ console errors:\n  ${consoleErrors.slice(0, 8).join('\n  ')}`);
  console.log(`\nwrote ${written} screenshots to ${OUT}`);
  preview.close();
  if (layoutFailures.length) {
    console.log(`\n❌ ${layoutFailures.length} desktop layout assertion(s) failed:`);
    for (const f of layoutFailures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(consoleErrors.length ? '\n(desktop layout assertions passed)' : '\n✅ desktop layout assertions passed');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
