/**
 * deeplink-browser.ts — drive a real headless chromium through the whole phone half of the `/rc`
 * QR: open `<origin>/code/session_<hex>` and land in that session's chat.
 *
 * Not in `npm test`: it needs chromium and the built `web/dist`. It is the only check that covers
 * what the unit tests deliberately cannot — that the server's redirect, vite's relative asset
 * base, the service worker and the React wiring all agree. The failure it exists to catch is a
 * blank page from assets resolving under `/code/`, which no amount of unit testing would see.
 *
 * Run: npm run build --prefix web && node test/deeplink-browser.ts
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControllerServer } from '../src/server/index.ts';
import { attachWebChannel } from '../src/server/web-channel.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.CHROMIUM_BIN || 'chromium';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP over the DevTools websocket — same approach as ui-shot.ts, no puppeteer. */
async function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('cdp connect failed: ' + wsUrl));
  });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
  };
  const send = (method: string, params: any = {}) =>
    new Promise<any>((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  return { send, close: () => ws.close() };
}

async function main() {
  const staticDir = path.resolve(here, '..', 'web', 'dist');
  if (!fs.existsSync(path.join(staticDir, 'index.html'))) {
    console.error(`[deeplink] no web/dist — run: npm run build --prefix web`);
    process.exit(1);
  }

  const server = await createControllerServer({ staticDir, onEvent: () => {} });
  // The session list only ever arrives over /ws/client, which main.ts attaches separately — the
  // SPA sits at "connecting…" forever without it, and the deep link has no list to resolve against.
  const web = attachWebChannel(server.server, server, server.store);
  const user = await server.store.createUser('deeplink', 'pw-12345678');
  if (!user) throw new Error('could not create the test account');
  // A session owned by that account, exactly as `/rc` creates one.
  const created = await server.store.createReplSession(user.token, { machineName: 'deeplink-probe' });
  const sid = created.id;
  const compat = 'session_' + sid.slice(4);
  console.log(`[deeplink] server ${server.baseUrl}  session ${sid}  link /code/${compat}`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-deeplink-'));
  const chrome = spawn(BIN, [
    '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-sandbox', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

  let fail = 0;
  try {
    // The debugging endpoint needs a moment; poll rather than guess.
    let list: any[] = [];
    for (let i = 0; i < 60 && !list.length; i++) {
      await sleep(250);
      list = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json()).catch(() => []);
    }
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('no chromium page target');
    const c = await cdp(page.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Page.enable');

    const evaluate = async (expr: string) => {
      const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails || r.result?.result?.subtype === 'error') throw new Error(JSON.stringify(r.result));
      return r.result?.result?.value;
    };

    // Pre-authenticate the way a returning phone is: the credential cookie the SPA sets itself.
    await c.send('Page.navigate', { url: server.baseUrl + '/' });
    await sleep(1200);
    await evaluate(`document.cookie = 'ccc_credential=${user.token}; Path=/; SameSite=Lax'`);

    // The scan: straight at the link the TUI printed.
    await c.send('Page.navigate', { url: `${server.baseUrl}/code/${compat}` });
    await sleep(2500);

    const check = async (label: string, expr: string, want: unknown) => {
      const got = await evaluate(expr);
      const ok = got === want;
      if (!ok) fail++;
      console.log(`${ok ? '✅' : '❌'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
    };

    // The redirect landed us on the root, with the id consumed out of the URL.
    await check('lands on the root', 'location.pathname', '/');
    await check('the id is consumed', 'location.search', '');
    // Assets resolved — a blank page from `/code/assets/*` is exactly what the redirect prevents.
    await check('the app rendered', 'document.querySelectorAll("#root *").length > 0', true);
    await check('no auth gate (cookie honoured)', 'document.body.innerText.includes("Sign in")', false);
    // And we are in THAT session, not the list.
    await check('opened the deep-linked session', 'document.body.innerText.includes("deeplink-probe")', true);
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    const out = path.resolve(here, '..', 'artifacts', 'deeplink.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log(`[deeplink] screenshot ${out}`);
    c.close();
  } finally {
    chrome.kill();
    web.close?.();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(fail === 0 ? '\n✅ PASS — the QR link opens its session' : `\n❌ FAIL — ${fail} check(s)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[deeplink] fatal:', e); process.exit(1); });
