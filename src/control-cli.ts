#!/usr/bin/env -S node
/**
 * control-cli.ts — `control-claude`: launch a gate-rebound `claude` whose bridge
 * (control-plane + data-plane) points at the user's own server, owned by their credential
 * (凭证A).
 *
 * Defaults, by design:
 *   - INTERACTIVE: a real claude TUI with the `/rc` gates rebound. The user works normally and
 *     types `/rc` when they want the session on their phone. `--headless` selects the old
 *     `claude remote-control` path (no TUI, phone-only driving).
 *   - PASSTHROUGH: any argument we don't own is forwarded to claude verbatim (`--resume`, `-c`,
 *     `--model`, a prompt, …). `--` forces everything after it through, including `--help`.
 *   - FILE LOGS: injector + claude stderr go to a log directory (default
 *     ~/.config/control-claude-code/logs), not the terminal — the TUI owns the terminal.
 *   - TITLE PARITY: we rename our own process to `claude` so automatic-rename terminals
 *     (tmux, screen) title the window the way a direct `claude` run does. See
 *     alignProcessTitle().
 *
 * Usage:
 *   control-claude [--server <url>] [--credential <A>] [--cwd <dir>]
 *                  [--claude-bin <path>] [--log-dir <dir>] [--headless]
 *                  [claude args...] [-- claude args...]
 *   env: CCC_SERVER, CCC_CREDENTIAL, CCC_LOG_DIR, CLAUDE_BIN, CCC_VERBOSE, CCC_CLAUDE_DEBUG,
 *        CCC_NO_PROCESS_TITLE
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithGatesRebound, launchInteractiveWithGatesRebound } from './injector/gate-rebind.ts';
import {
  CONFIG_DIR, CONFIG_FILE, DEFAULT_BACKEND, loadConfig, saveConfig, findBackend, checkToken,
  normalizeUrl, runLoginFlow, legacyCredentialNotice,
} from './cli-auth.ts';
import { VERSION, loadCheckState, updateNotice, refreshInBackground } from './update-check.ts';

const DEFAULT_LOG_DIR = path.join(CONFIG_DIR, 'logs');
const KEEP_RUNS = 20; // how many past runs' logs to keep in the log dir

/** Controller flags that take a value; everything else falls through to claude. */
const VALUE_FLAGS = new Set(['server', 'credential', 'cwd', 'claude-bin', 'log-dir']);

export interface Cli {
  server?: string;
  credential?: string;
  cwd?: string;
  claudeBin?: string;
  logDir?: string;
  headless: boolean;
  /** Force the backend/login TUI even when a saved token would have worked. */
  login: boolean;
  help: boolean;
  /** argv forwarded to claude verbatim, in the order the user wrote it. */
  claudeArgs: string[];
}

/** What an automatic-rename terminal should call this window — the same name a direct run gets. */
const PROCESS_TITLE = 'claude';

/**
 * Rename this process to `claude` so terminals that title windows from the process show what
 * the user actually launched.
 *
 * tmux (and screen) name a window after the FOREGROUND PROCESS GROUP leader's argv[0], read
 * from /proc/<pgid>/cmdline. claude is our child and inherits our process group, so the leader
 * is this host process and `#W` renders "node" — measured: window_name=[node] through us vs
 * [claude] direct. claude's own OSC title still arrives, but tmux files it under pane_title
 * (`#T`), which the common set-titles-string "#S / #W" never renders, so the terminal title
 * stops tracking claude the moment the user launches through us.
 *
 * Renaming ourselves is the only fix available: putting the child in its own foreground group
 * needs setpgid + tcsetpgrp, which Node does not expose, and `detached: true` calls setsid(),
 * costing claude its controlling terminal (no SIGWINCH → a TUI that never reflows on resize).
 *
 * Kept short on purpose — the new title must fit the original argv block or libuv truncates it.
 * CCC_NO_PROCESS_TITLE=1 keeps the real argv, so `ps` still shows the controller command.
 */
export function alignProcessTitle(title: string = PROCESS_TITLE): string {
  if (process.env.CCC_NO_PROCESS_TITLE) return process.title;
  try { process.title = title; } catch { /* platform refused it; the title is cosmetic */ }
  return process.title;
}

function die(msg: string): never {
  console.error(`control-claude: ${msg}\n试试 control-claude --help`);
  process.exit(2);
}

/**
 * Parse only our own flags and forward the rest. Deliberately conservative: a value flag whose
 * value is missing (or looks like another flag) is an error rather than a silent swallow of a
 * claude argument.
 */
export function parseArgs(argv: string[]): Cli {
  const cli: Cli = { headless: false, login: false, help: false, claudeArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { cli.claudeArgs.push(...argv.slice(i + 1)); break; }
    if (a === '-h' || a === '--help') { cli.help = true; continue; }
    if (a === '-i') continue; // compat: interactive is the default now

    const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a);
    if (m) {
      const name = m[1];
      if (VALUE_FLAGS.has(name)) {
        let v = m[2];
        if (v === undefined) {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) die(`--${name} 需要一个值`);
          v = argv[++i];
        }
        if (name === 'server') cli.server = v;
        else if (name === 'credential') cli.credential = v;
        else if (name === 'cwd') cli.cwd = v;
        else if (name === 'claude-bin') cli.claudeBin = v;
        else if (name === 'log-dir') cli.logDir = v;
        continue;
      }
      if (name === 'headless' || name === 'no-interactive') { cli.headless = true; continue; }
      if (name === 'interactive') { cli.headless = false; continue; }
      if (name === 'login') { cli.login = true; continue; }
    }
    cli.claudeArgs.push(a); // not ours → claude's
  }
  return cli;
}

function printHelp() {
  console.log(`control-claude \x1b[2mv${VERSION}\x1b[0m — 用手机远程控制本机的 claude（BYOK 也能用）

用法:
  control-claude [控制器选项] [claude 的参数...]

默认启动交互式 claude（真实 TUI）并注入远程控制；在 TUI 里输入 \x1b[1m/rc\x1b[0m 会话即出现在手机上。
控制器不认识的参数会原样转发给 claude:
  control-claude --resume                  # 选一个历史会话继续
  control-claude -c                        # 继续最近一次会话
  control-claude --model opus "修下这个 bug"
  control-claude -- --help                 # -- 之后的一切都交给 claude（包括 --help）

首次运行会让你选后端并登录（账号在 web 端注册，需要邀请码），结果保存在
${CONFIG_FILE}，之后直接启动。随时可用 \x1b[1m--login\x1b[0m 重新登录或切换后端。

控制器选项:
  --login               强制进入后端选择 / 登录界面（切换后端、换账号）
  --server <url>        控制器服务器地址（默认 $CCC_SERVER 或上次使用的后端）
  --credential <A>      直接指定账号 token，跳过登录界面（默认 $CCC_CREDENTIAL）
  --cwd <dir>           claude 的工作目录（默认当前目录）
  --claude-bin <path>   claude 可执行文件（默认 $CLAUDE_BIN 或 claude）
  --log-dir <dir>       日志目录（默认 $CCC_LOG_DIR 或 ${DEFAULT_LOG_DIR}）
  --headless            无头模式: 注入 \`claude remote-control\`，只由手机驱动，不占用终端
  -i, --interactive     交互式（已是默认，仅作兼容）
  -h, --help            显示本帮助

环境变量: CCC_SERVER CCC_CREDENTIAL CCC_LOG_DIR CLAUDE_BIN CCC_VERBOSE CCC_CLAUDE_DEBUG
          CCC_NO_PROCESS_TITLE=1  不把宿主进程改名为 claude（tmux/screen 的窗口名会显示 node）
          CCC_NO_UPDATE_CHECK=1   不检查新版本（不打提示，也不访问 npm registry）`);
}

/**
 * Work out which server to talk to and as whom, prompting only when we have to.
 *
 * The order matters. An explicit `--credential` (or CCC_CREDENTIAL) bypasses everything, because
 * scripts and the e2e harness drive this non-interactively and must never meet a prompt. Failing
 * that, a saved token for the chosen backend is used as-is unless the server says it is dead —
 * so the common case stays exactly as frictionless as it was before accounts existed, and the
 * TUI appears on a first run, after `--login`, or when a token stops working.
 */
async function resolveAccount(cli: Cli): Promise<{ serverUrl: string; credential: string } | undefined> {
  const envServer = cli.server || process.env.CCC_SERVER;
  const explicitCredential = cli.credential || process.env.CCC_CREDENTIAL;
  if (explicitCredential) {
    return { serverUrl: normalizeUrl(envServer || DEFAULT_BACKEND), credential: explicitCredential };
  }

  const config = loadConfig();
  const notice = legacyCredentialNotice();
  if (notice) console.log(`\n${notice}\n`);

  // --server names the backend outright; only the login step is left to decide.
  const serverHint = envServer ? normalizeUrl(envServer) : undefined;

  if (!cli.login) {
    const url = serverHint ?? config.current ?? DEFAULT_BACKEND;
    const saved = findBackend(config, url);
    if (saved?.token) {
      const check = await checkToken(url, saved.token);
      // Unreachable is not a reason to re-authenticate — see checkToken in cli-auth.ts.
      if (check.status !== 'rejected') return { serverUrl: url, credential: saved.token };
      console.log(`\n登录已失效（${url}），请重新登录。\n`);
    }
  }

  const result = await runLoginFlow(config, { serverHint });
  if (!result) return undefined;
  saveConfig(result.config);
  console.log(`  已保存到 ${CONFIG_FILE}\n`);
  return { serverUrl: result.serverUrl, credential: result.credential };
}

const ts = () => new Date().toISOString().slice(11, 23);

const stampNow = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

interface Logger {
  dir: string;
  file: string;
  claudeFile: string;
  log: (m: string) => void;
  appendClaude: (s: string) => void;
}

const RUN_FILE_RE = /^ccc-\d{8}-\d{6}-\d+\.(?:claude\.)?log$/;

/** Keep the newest KEEP_RUNS runs; only ever touches files we created (RUN_FILE_RE). */
function pruneRuns(dir: string) {
  try {
    const runs = new Map<string, string[]>();
    for (const name of fs.readdirSync(dir)) {
      if (!RUN_FILE_RE.test(name)) continue;
      const key = name.replace(/\.(?:claude\.)?log$/, '');
      const list = runs.get(key) ?? [];
      list.push(name);
      runs.set(key, list);
    }
    const keys = [...runs.keys()].sort(); // stamped names sort chronologically
    for (const key of keys.slice(0, Math.max(0, keys.length - KEEP_RUNS)))
      for (const name of runs.get(key)!) { try { fs.rmSync(path.join(dir, name)); } catch {} }
  } catch {}
}

const hasContent = (f: string) => { try { return fs.statSync(f).size > 0; } catch { return false; } };

function createLogger(dir: string): Logger {
  fs.mkdirSync(dir, { recursive: true });
  pruneRuns(dir);
  const base = `ccc-${stampNow()}-${process.pid}`;
  const file = path.join(dir, base + '.log');
  const claudeFile = path.join(dir, base + '.claude.log');
  const append = (f: string, s: string) => { try { fs.appendFileSync(f, s); } catch {} };
  for (const f of [file, claudeFile]) append(f, ''); // create both so the symlinks never dangle
  // latest.log / latest.claude.log point at this run, so `tail -f` needs no stamp.
  for (const [link, target] of [['latest.log', file], ['latest.claude.log', claudeFile]] as const) {
    const p = path.join(dir, link);
    try { fs.rmSync(p, { force: true }); fs.symlinkSync(target, p); } catch {}
  }
  return { dir, file, claudeFile, log: (m) => append(file, `${ts()} ${m}\n`), appendClaude: (s) => append(claudeFile, s) };
}

interface RunCtx {
  claudeBin: string;
  cwd: string;
  serverUrl: string;
  credential: string;
  claudeArgs: string[];
  logger: Logger;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) { printHelp(); return; }

  // Log in (or confirm we already are) before touching logs or claude: if the user cancels,
  // nothing should have happened yet.
  const account = await resolveAccount(cli);
  if (!account) { console.log('已取消。'); process.exit(1); }
  const { serverUrl, credential } = account;

  const cwd = path.resolve(cli.cwd || process.cwd());
  const claudeBin = cli.claudeBin || process.env.CLAUDE_BIN || 'claude';
  const logDir = path.resolve(cli.logDir || process.env.CCC_LOG_DIR || DEFAULT_LOG_DIR);

  const logger = createLogger(logDir);
  // Our own version first: a bug report's log should say which control-claude produced it, next to
  // the claude version the injector reports later.
  logger.log(`[cli] control-claude v${VERSION} node=${process.version}`);
  logger.log(`[cli] argv=${JSON.stringify(process.argv.slice(2))}`);
  // Before anything long-running: tmux/screen read our argv for the window name (see above).
  logger.log(`[cli] process.title=${JSON.stringify(alignProcessTitle())}`);
  logger.log(`[cli] mode=${cli.headless ? 'headless' : 'interactive'} server=${serverUrl} cwd=${cwd} bin=${claudeBin} claudeArgs=${JSON.stringify(cli.claudeArgs)}`);

  /*
   * Last chance to print anything: in interactive mode claude's TUI owns the terminal from the
   * next statement on. The notice is whatever the cache already knew (no network on this path);
   * the refresh below lands in time for the next launch. See src/update-check.ts.
   */
  const notice = updateNotice(VERSION, loadCheckState());
  if (notice) console.log(`\n${notice}\n`);
  void refreshInBackground(); // deliberately not awaited — see the file header

  const ctx: RunCtx = { claudeBin, cwd, serverUrl, credential, claudeArgs: cli.claudeArgs, logger };
  try {
    await (cli.headless ? runHeadless(ctx) : runInteractive(ctx));
  } catch (e: any) {
    logger.log(`[cli] fatal: ${e?.stack || e}`);
    console.error(`\n${ts()} 启动失败: ${e?.message ?? e}`);
    if (e?.code === 'ENOENT') console.error(`${ts()} 找不到 claude 可执行文件 — 用 --claude-bin <路径> 或设置 CLAUDE_BIN`);
    console.error(`${ts()} 详细日志: ${logger.file}${hasContent(logger.claudeFile) ? ' / ' + logger.claudeFile : ''}`);
    process.exit(1);
  }
}

/**
 * Interactive mode (default): launch the claude TUI with the `/rc` gates rebound. The user
 * works normally; typing `/rc` connects the REPL bridge to our server and the session appears
 * on their phone. The TUI owns the terminal (stdio inherit), so injector logs go to the log
 * dir and we don't intercept Ctrl-C. claude's stderr is piped (never left unread — an unread
 * pipe would stall claude once its buffer filled) into the run's .claude.log, and its tail is
 * echoed if claude exits badly, so forwarded-argument mistakes stay visible.
 */
async function runInteractive(o: RunCtx) {
  const { logger } = o;
  logger.log(`[cli] interactive start bridge=${o.serverUrl} cwd=${o.cwd} args=${o.claudeArgs.join(' ')}`);

  let stderrTail = '';
  const h = await launchInteractiveWithGatesRebound({
    claudeBin: o.claudeBin,
    cwd: o.cwd,
    bridgeBaseUrl: o.serverUrl,
    bridgeToken: o.credential,
    stdio: 'inherit',
    extraArgs: withDebugFlag(o.claudeArgs),
    log: logger.log,
    onStderr: (s) => { logger.appendClaude(s); stderrTail = (stderrTail + s).slice(-4000); },
  });
  const okN = h.reports.filter((r) => r.located).length;
  logger.log(`[cli] ready — ${okN}/${h.reports.length} gates rebound (claude ${h.version ?? '?'} / profile ${h.profileId})`);

  let code: number | null = null;
  h.child.on('exit', (c) => { code = c; });
  // The TUI now owns the terminal. Don't intercept Ctrl-C — let claude handle it; we exit when it does.
  process.on('SIGINT', () => {});
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => { if (h.isDead()) { clearInterval(iv); resolve(); } }, 500);
  });
  logger.log(`[cli] claude exited code=${code}`);
  if (code) {
    console.error(`\n${ts()} claude 退出 (code=${code})。`);
    if (stderrTail.trim()) console.error(`\x1b[2m${stderrTail.trim()}\x1b[0m`);
    console.error(`${ts()} 完整日志: ${logger.file}${hasContent(logger.claudeFile) ? ' / ' + logger.claudeFile : ''}`);
    process.exit(code);
  }
  process.exit(0);
}

/**
 * Headless mode (`--headless`): inject `claude remote-control`, which spawns the worker child;
 * nothing runs in this terminal and the phone drives everything. Keeps claude alive until
 * Ctrl-C.
 */
async function runHeadless(o: RunCtx) {
  const { logger } = o;
  console.log(`${ts()} control-claude (headless) → ${o.serverUrl}  cred=${o.credential.slice(0, 10)}…  cwd=${o.cwd}`);
  if (o.claudeArgs.length) console.log(`${ts()} 转发给 claude remote-control 的参数: ${o.claudeArgs.join(' ')}`);
  console.log(`${ts()} 日志: ${logger.file}`);

  const h = await launchWithGatesRebound({
    claudeBin: o.claudeBin,
    cwd: o.cwd,
    bridgeBaseUrl: o.serverUrl,
    bridgeToken: o.credential,
    extraArgs: withDebugFlag(o.claudeArgs),
    log: (m) => { logger.log(m); if (process.env.CCC_VERBOSE) console.log(`${ts()} ${m}`); },
    onStderr: (s) => { logger.appendClaude(s); if (process.env.CCC_VERBOSE) process.stderr.write(`\x1b[2m[claude] ${s}\x1b[0m`); },
  });

  const okN = h.reports.filter((r) => r.located && r.reboundOk !== false).length;
  console.log(`${ts()} claude remote-control launched — bridge redirected to your server (${okN}/${h.reports.length} gates, claude ${h.version ?? '?'} / profile ${h.profileId}).`);
  console.log(`${ts()} Open the web app on your phone, enter the credential, and your session will appear. Ctrl-C to stop.`);

  const stop = () => { try { h.kill(); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Keep the process alive; exit if claude dies.
  const iv = setInterval(() => {
    if (h.isDead()) {
      clearInterval(iv);
      console.log(`${ts()} claude exited — 日志: ${logger.file}${hasContent(logger.claudeFile) ? ' / ' + logger.claudeFile : ''}`);
      process.exit(0);
    }
  }, 1000);
}

/** CCC_CLAUDE_DEBUG=1 adds claude's own --debug (unless the user already passed it). */
export function withDebugFlag(args: string[]): string[] {
  if (!process.env.CCC_CLAUDE_DEBUG) return args;
  return args.some((a) => a === '--debug' || a.startsWith('--debug=')) ? args : [...args, '--debug'];
}

/**
 * Whether we were run as the CLI rather than imported (the arg parsing above is imported by
 * tests). argv[1] must be realpath'd first: an npm-installed bin is a symlink, so argv[1] is
 * `…/bin/control-claude` while import.meta.url is the resolved `…/dist/cli.mjs`. Comparing
 * them unresolved makes an installed copy exit silently without ever calling main().
 */
function invokedAsCli(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  const self = fileURLToPath(import.meta.url);
  try { return fs.realpathSync(arg) === self; } catch { return path.resolve(arg) === self; }
}

if (invokedAsCli()) main().catch((e) => { console.error('[control-cli] fatal:', e); process.exit(1); });
