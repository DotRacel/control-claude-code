/**
 * ui-preview.ts — serve the real SPA against real-shaped but fake sessions, so the mobile UI can
 * be reviewed (headless chromium, or a phone on the LAN) without claude, inference or a database.
 *
 * Everything goes through the actual data-plane: the fixture payloads are POSTed to
 * `/v1/code/sessions/{id}/worker/events` exactly as a worker would, so the transcript the browser
 * renders is produced by the same reducer path as a live session.
 *
 * Run: node test/ui-preview.ts [--port 8791] [--username preview]
 *      then open http://127.0.0.1:8791 and paste the printed token into the gate's
 *      「使用密钥连接」. The token is issued by the server (accounts are real now), so it
 *      is printed on startup rather than being a name chosen here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControllerServer, type ControllerServer } from '../src/server/index.ts';
import { attachWebChannel } from '../src/server/web-channel.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(here, '../web/dist');
const fixture = path.resolve(here, 'fixtures/transcript-shapes.jsonl');

export interface Preview {
  server: ControllerServer;
  port: number;
  credential: string;
  /** the session that carries the full transcript */
  chatId: string;
  close: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The fixture transcript. Its last turn never got a `result`, so the session reads as in flight —
 * which is what puts the activity line and the Stop button on screen. */
function transcript(): any[] {
  return fs.readFileSync(fixture, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

/** Long, wrapping, mixed-script content — the layout only breaks on real text. */
const EXTRA: any[] = [
  { type: 'user', timestamp: '2026-08-14T11:20:00.000Z', message: { role: 'user', content: '这个会话页在手机上排版不太对，帮我看看 header、转录区和输入框的高度分配，另外 /home/racel/claude-code-controller/web/src/components/ChatView.tsx 里的滚动容器也检查一下' } },
  {
    type: 'assistant', timestamp: '2026-08-14T11:20:03.000Z',
    message: {
      role: 'assistant', model: 'claude-opus-5',
      content: [
        { type: 'text', text: '我先看一下布局。三层结构是 `.screen`（flex column）→ `.topbar` / `.scroll.chat` / `.composer-wrap`，理论上转录区应该吃掉剩余空间。\n\n几个可能的点：\n\n1. `height: 100%` 在移动端浏览器上会被地址栏影响\n2. `min-height: 0` 缺失会让 flex 子项撑破容器\n3. 安全区 `env(safe-area-inset-*)` 只在 standalone 下有值\n\n```css\n.screen { height: 100%; display: flex; flex-direction: column; }\n.scroll { flex: 1; min-height: 0; overflow-y: auto; }\n```\n\n下面跑一下构建确认。' },
        { type: 'tool_use', id: 'tu_prev1', name: 'Bash', input: { command: 'cd web && npm run build 2>&1 | tail -20' } },
      ],
    },
  },
  { type: 'user', timestamp: '2026-08-14T11:20:31.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_prev1', content: 'vite v5.4.11 building for production...\n✓ 41 modules transformed.\ndist/index.html                   1.18 kB\ndist/assets/index-C3nQ8f2a.css   14.02 kB\ndist/assets/index-Bq7dK1vX.js   162.44 kB\n✓ built in 1.34s' }] } },
  // An Edit, so the +added / −removed counts on a tool card are reviewable in a screenshot.
  {
    type: 'assistant', timestamp: '2026-08-14T11:20:32.000Z',
    message: {
      role: 'assistant', model: 'claude-opus-5',
      content: [{
        type: 'tool_use', id: 'tu_prev_edit', name: 'Edit',
        input: {
          file_path: '/home/racel/claude-code-controller/web/src/styles.css',
          old_string: '.scroll { flex: 1; overflow-y: auto; }',
          new_string: '.scroll {\n  flex: 1;\n  min-height: 0;\n  overflow-y: auto;\n  -webkit-overflow-scrolling: touch;\n}',
        },
      }],
    },
  },
  { type: 'user', timestamp: '2026-08-14T11:20:32.400Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_prev_edit', content: 'The file /home/racel/claude-code-controller/web/src/styles.css has been updated successfully.' }] } },
  {
    type: 'assistant', timestamp: '2026-08-14T11:20:33.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'tu_prev2', name: 'Read', input: { file_path: '/home/racel/claude-code-controller/web/src/components/Composer.tsx' } }] },
  },
  // A background sub-agent's lifecycle: the card starts, then the completion arrives ONLY as the
  // `<task-notification>` user echo claude injects — the card must settle to done and show the
  // outcome line, never render the raw XML as a user bubble.
  { type: 'system', subtype: 'task_started', task_id: 'prev_agent', task_type: 'local_agent', description: '审查 Composer 的移动端布局', tool_use_id: 'tu_prev2', timestamp: '2026-08-14T11:20:34.000Z' },
  { type: 'user', timestamp: '2026-08-14T11:20:58.000Z', message: { role: 'user', content: '<task-notification>\n<task-id>prev_agent</task-id>\n<tool-use-id>tu_prev2</tool-use-id>\n<output-file>/tmp/tasks/prev_agent.output</output-file>\n<status>completed</status>\n<summary>Agent "审查 Composer 的移动端布局" finished</summary>\n<result>Composer 的高度分配没问题；建议给 textarea 加 max-height 与 env(safe-area-inset-bottom)。</result>\n<usage><subagent_tokens>8420</subagent_tokens><tool_uses>3</tool_uses><duration_ms>24180</duration_ms></usage>\n</task-notification>' } },

  // ── the four shapes a production database held that used to reach nothing, or the wrong thing ──
  // (see test/task-adaptation.test.ts; every field below is shaped like a real payload from the
  // hosted deployment, 2026-09-03→04.)

  // 1. A sub-agent whose completion notification carries its ENTIRE report as `summary`, with no
  // preceding `task_started`. The card must take its name from the Agent call, keep the report
  // behind a toggle, and show the counts the notification carried.
  {
    type: 'assistant', timestamp: '2026-08-14T11:21:00.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [
      { type: 'tool_use', id: 'tu_agent_rep', name: 'Agent', input: { description: '排查登录态丢失', prompt: '查清 session cookie 在什么条件下会被提前清掉' } },
    ] },
  },
  { type: 'user', timestamp: '2026-08-14T11:21:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_agent_rep', content: '已完成，详见报告。' }] } },
  {
    type: 'system', subtype: 'task_notification', task_id: 'prev_report', tool_use_id: 'tu_agent_rep',
    status: 'completed', timestamp: '2026-08-14T11:21:03.000Z',
    usage: { tool_uses: 21, duration_ms: 148758, total_tokens: 84553 },
    summary: [
      '结论在下面。登录态丢失不是 cookie 过期，是两个 SameSite 设置打架。',
      '',
      '---',
      '',
      '## 1. 直接原因',
      '',
      '`src/auth/session.ts:88` 写 cookie 时用的是 `SameSite=Strict`，而 `src/auth/oauth.ts:141`',
      '在回调里重新签发时用了 `SameSite=Lax`。浏览器保留后写入的那个，于是从第三方跳回来的会话',
      '拿到的是 Lax，而后续的跨站 XHR 又按 Strict 的假设去读——读不到就当未登录。',
      '',
      '## 2. 为什么只在部分用户身上出现',
      '',
      '只有走过 OAuth 回调的用户才会命中第二次签发。直接用密码登录的路径只经过 `session.ts`，',
      '两边设置一致，所以从来不复现。',
      '',
      '## 3. 建议',
      '',
      '- 把 cookie 的写入收敛到一处（`session.ts` 的 `issue()`），`oauth.ts` 改成调用它',
      '- 给 `SameSite` 建一个常量，避免第三处再写一遍',
      '- 补一个集成测试：OAuth 回调后立刻发一个跨站 XHR，断言仍是已登录',
      '',
      '## 4. 顺带发现',
      '',
      '`src/auth/oauth.ts:96` 的 state 参数没有校验长度，虽然不影响本次问题，但值得单独处理。',
    ].join('\n'),
  },

  // 2. A task the user stopped. `system:task_notification` spells it `stopped`; the card must not
  // claim 完成 above a summary that says it was stopped.
  { type: 'system', subtype: 'task_started', task_id: 'prev_stopped', task_type: 'local_agent', description: '校验子账号权限矩阵', tool_use_id: 'tu_stop', timestamp: '2026-08-14T11:21:05.000Z' },
  {
    type: 'system', subtype: 'task_notification', task_id: 'prev_stopped', status: 'stopped',
    summary: 'Agent "校验子账号权限矩阵" was stopped by user',
    usage: { tool_uses: 38, duration_ms: 108420 }, timestamp: '2026-08-14T11:21:40.000Z',
  },

  // 3. The other spelling of the same event: `system:task_updated` patches the status to `killed`,
  // which used to fold into `running` and leave the card spinning for the rest of the transcript.
  { type: 'system', subtype: 'task_started', task_id: 'prev_killed', task_type: 'local_bash', description: '等待 dev server 启动并读取日志', timestamp: '2026-08-14T11:21:42.000Z' },
  { type: 'system', subtype: 'task_updated', task_id: 'prev_killed', patch: { status: 'killed' }, timestamp: '2026-08-14T11:21:52.000Z' },

  // 4. A slash command the owner ran in the terminal. All three events used to be dropped, so the
  // model changed under a remote viewer with nothing on screen to say why.
  { type: 'user', timestamp: '2026-08-14T11:21:55.000Z', message: { role: 'user', content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>' } },
  { type: 'user', timestamp: '2026-08-14T11:21:55.100Z', message: { role: 'user', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-fable-5-1</command-args>' } },
  { type: 'user', timestamp: '2026-08-14T11:21:55.200Z', message: { role: 'user', content: '<local-command-stdout>Set model to `claude-fable-5-1` and saved as your default for new sessions</local-command-stdout>' } },

  // 5. Escape. The marker arrives as an ordinary text block with nothing on the envelope to mark
  // it, so it used to render as a bubble — a sentence attributed to someone who typed nothing.
  { type: 'user', timestamp: '2026-08-14T11:21:57.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },

  // 6. A compaction and the replay that follows it. `isSynthetic` is the only flag on the replay,
  // and it is the one the filter did not read: 15 of these were in the sampled history, up to
  // 32809 characters each, every one a user bubble. The divider beside it is the actual beat.
  { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 152000, post_tokens: 31000 }, timestamp: '2026-08-14T11:21:58.000Z' },
  {
    type: 'user', isSynthetic: true, timestamp: '2026-08-14T11:21:58.500Z',
    message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. '
      + 'The summary below covers everything that was done and what remains.\n\n'
      + '## 已完成\n\n- 修复 Composer 的高度分配\n- 给 textarea 加上 max-height\n\n'.repeat(60) },
  },
  { type: 'user', timestamp: '2026-08-14T11:22:00.000Z', message: { role: 'user', content: '继续，把安全区那块也补上' } },
];

/** Long enough to fold (the card folds past 900 chars), and mixed-script for the same reason the
 * rest of this file is: the layout only breaks on real text. */
const PREVIEW_PLAN = `# 为结账流程加幂等键

## 现状

\`POST /checkout\` 目前没有任何去重：用户在弱网下重复点击「提交订单」，会真的创建两笔订单，
下游的库存扣减和支付请求也跟着跑两遍。生产上这个月已经出现 3 次。

## 修改的文件

- \`src/routes/checkout.ts\` — 读取并校验请求头
- \`src/db/idempotency.ts\` — 新增，键的存取
- \`migrations/0042_idempotency_keys.sql\` — 新增表

## 步骤

### 1. 建表

\`\`\`sql
CREATE TABLE idempotency_keys (
  key         text PRIMARY KEY,
  response    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
\`\`\`

### 2. 在路由入口拦一层

读 \`Idempotency-Key\` 请求头；命中已有记录就直接回放存下来的响应，不再执行下单逻辑。
没有这个头时保持现有行为不变——先不强制，避免打断已经上线的客户端。

### 3. 落库与回放写在同一个事务里

否则并发的两个请求会同时越过「查不到键」这一步。用 \`INSERT ... ON CONFLICT DO NOTHING\`
的返回行数来决定谁是赢家。

## 验证

- 同一个 key 连发两次 \`POST /checkout\`：第二次返回和第一次逐字节相同的响应体，且只有一笔订单
- 不带 \`Idempotency-Key\` 的请求行为不变（回归）
- \`npm test -- checkout\` 全绿
`;

/** A pending `can_use_tool`, so the permission sheet can be screenshotted. */
const PERMISSION: any[] = [
  {
    type: 'assistant', timestamp: '2026-08-14T11:21:00.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'tu_perm', name: 'Bash', input: { command: 'rm -rf web/dist && cd web && npm run build' } }] },
  },
  {
    type: 'control_request', request_id: 'rq_preview',
    request: {
      subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu_perm',
      input: { command: 'rm -rf web/dist && cd web && npm run build', description: '重建前端产物' },
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }], behavior: 'allow', destination: 'session' }],
    },
  },
];

/**
 * A session sitting in plan mode on an UNANSWERED ExitPlanMode ask — the state the corpus cannot
 * show, because its plan is already approved. This is what puts the plan card's three buttons and
 * the composer's plan-mode chip on screen at the same time.
 */
const PLAN_PENDING: any[] = [
  { type: 'system', subtype: 'init', model: 'claude-opus-5', permissionMode: 'plan', cwd: '/srv/checkout', slash_commands: ['clear', 'compact'], skills: [] },
  { type: 'user', timestamp: '2026-08-14T11:40:00.000Z', message: { role: 'user', content: '给结账流程加一个幂等键，先出个方案' } },
  {
    type: 'assistant', timestamp: '2026-08-14T11:40:20.000Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'tu_plan_prev', name: 'ExitPlanMode', input: { plan: PREVIEW_PLAN, planFilePath: '/home/dev/.claude/plans/idempotency-key.md' } }] },
  },
  {
    type: 'control_request', request_id: 'rq_plan_preview',
    request: {
      subtype: 'can_use_tool', tool_name: 'ExitPlanMode', display_name: 'ExitPlanMode',
      tool_use_id: 'tu_plan_prev', description: '', requires_user_interaction: true,
      input: { plan: PREVIEW_PLAN, planFilePath: '/home/dev/.claude/plans/idempotency-key.md' },
    },
  },
];

async function post(server: ControllerServer, token: string, sid: string, payloads: any[]) {
  await fetch(`${server.baseUrl}/v1/code/sessions/${sid}/worker/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ worker_epoch: 1, events: payloads.map((p) => ({ payload: p })) }),
  });
  await sleep(30);
}

export async function startPreview(opts: { port?: number; username?: string } = {}): Promise<Preview> {
  let web: ReturnType<typeof attachWebChannel> | null = null;
  const server = await createControllerServer({ port: opts.port ?? 0, staticDir, onEvent: (e) => web?.handleEvent(e) });
  web = attachWebChannel(server.server, server, server.store);
  // The credential is an account's issued token now — /ws/client refuses anything else, so the
  // preview has to register a throwaway account rather than invent a string.
  const account = await server.store.createUser(opts.username ?? 'preview', 'preview-password');
  const credential = account!.token;
  const aborts: AbortController[] = [];

  /** Open the SSE data-plane so the session reads as `active` (a worker would hold this open). */
  const goLive = async (token: string, sid: string) => {
    const ac = new AbortController();
    aborts.push(ac);
    const sse = await fetch(`${server.baseUrl}/v1/code/sessions/${sid}/worker/events/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
    const reader = sse.body!.getReader();
    void (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })().catch(() => {});
    await sleep(30);
  };

  // 1) the main session: full fixture transcript + a live turn in flight
  const chat = await server.store.createReplSession(credential, { dir: '/home/racel/claude-code-controller', machineName: 'racel-dev' });
  await goLive(chat.ingressToken, chat.id);
  await post(server, chat.ingressToken, chat.id, transcript());
  await post(server, chat.ingressToken, chat.id, EXTRA);

  // 2) a second session waiting on approval — gives the list its accent badge
  const perm = await server.store.createReplSession(credential, { dir: '/srv/api-gateway', machineName: 'build-box' });
  await goLive(perm.ingressToken, perm.id);
  await post(server, perm.ingressToken, perm.id, [
    { type: 'system', subtype: 'init', model: 'claude-opus-5', permissionMode: 'default', cwd: '/srv/api-gateway', slash_commands: ['clear', 'compact', 'review'], skills: [] },
    { type: 'user', timestamp: '2026-08-14T11:21:00.000Z', message: { role: 'user', content: '把 dist 清掉重新构建一次' } },
    ...PERMISSION,
  ]);

  // 3) a session in plan mode with an unanswered plan — the plan card and the mode chip
  const plan = await server.store.createReplSession(credential, { dir: '/srv/checkout', machineName: 'checkout-box' });
  await goLive(plan.ingressToken, plan.id);
  await post(server, plan.ingressToken, plan.id, PLAN_PENDING);

  // 4) an offline session — the "claude 没有连着" banner and the dimmed list row
  const cold = await server.store.createReplSession(credential, { dir: '/home/racel/notes', machineName: 'thinkpad' });
  await post(server, cold.ingressToken, cold.id, [
    { type: 'user', timestamp: '2026-08-14T09:02:00.000Z', message: { role: 'user', content: '整理一下这周的会议记录' } },
    { type: 'assistant', timestamp: '2026-08-14T09:02:20.000Z', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: '整理好了，共 7 条。' }] } },
    { type: 'result', subtype: 'success', is_error: false },
  ]);

  return {
    server, port: server.port, credential, chatId: chat.id,
    close: () => { for (const a of aborts) a.abort(); server.close(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  if (!fs.existsSync(path.join(staticDir, 'index.html'))) {
    console.error(`web/dist not built — run: cd web && npm run build`);
    process.exit(1);
  }
  const p = await startPreview({ port: Number(arg('--port') || 8791), username: arg('--username') });
  console.log(`ui-preview on http://127.0.0.1:${p.port}  credential=${p.credential}  chat=${p.chatId}`);
  console.log('sessions: 1 live transcript · 1 awaiting approval · 1 in plan mode · 1 offline');
  process.on('SIGINT', () => { p.close(); process.exit(0); });
}
