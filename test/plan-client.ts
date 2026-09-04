/**
 * plan-client.ts — drive a connected `/rc` session through a full plan-mode round trip over
 * `/ws/client` and dump every frame the browser would have to render.
 *
 * ExitPlanMode is **disabled in `-p` headless mode** ("No such tool available: ExitPlanMode"),
 * so a stream-json probe cannot reach it: an interactive claude behind the bridge is the only
 * place the plan-approval permission request actually exists. This is the client half of
 * test/e2e-plan-mode.sh.
 *
 * Run: node test/plan-client.ts <credential> <port> [scenario] [answer]
 *   scenario: exit  — set_permission_mode → plan, then ask for a plan (reaches ExitPlanMode)
 *             enter — stay in default and ask Claude to use EnterPlanMode itself
 *   answer:   allow | deny | accept-edits
 * Every payload is appended to test/fixtures/plan-mode-wire.jsonl.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CRED = process.argv[2] || 'smoke-cred';
const PORT = process.argv[3] || '8790';
const SCENARIO = process.argv[4] || 'exit';
const ANSWER = process.argv[5] || 'allow';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', `plan-mode-${SCENARIO}-${ANSWER}.jsonl`);

const PROMPTS: Record<string, string> = {
  exit: 'Plan how to add a --version flag to /tmp/ccc-plan-target.sh. Two steps is plenty. Then present the plan for approval.',
  enter: 'I want to add a --version flag to /tmp/ccc-plan-target.sh. Use the EnterPlanMode tool first, then explore and present a plan for approval.',
};
const TEXT = PROMPTS[SCENARIO] ?? PROMPTS.exit;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if (cond()) return true; await sleep(200); }
  return false;
}
const key = (p: any): string =>
  p?.type === 'system' ? `system:${p.subtype}`
  : p?.type === 'control_request' ? `control_request:${p.request?.subtype}`
  : p?.type === 'control_response' ? `control_response:${p.response?.subtype}`
  : String(p?.type);
function hist(list: any[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const p of list) { const k = key(p); h[k] = (h[k] || 0) + 1; }
  return h;
}
const dump = () => { mkdirSync(path.dirname(OUT), { recursive: true }); writeFileSync(OUT, events.map((p) => JSON.stringify(p)).join('\n') + '\n'); };

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/client?credential=${CRED}`);
let sessions: any[] = [];
const events: any[] = [];
const perms: any[] = [];

ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string);
  if (m.type === 'sessions') sessions = m.sessions;
  else if (m.type === 'event') {
    events.push(m.payload);
    if (m.payload?.type === 'control_request' && m.payload.request?.subtype === 'can_use_tool') perms.push(m.payload);
  }
};
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
await sleep(600);

console.log('sessions:', JSON.stringify(sessions.map((s: any) => ({ id: s.id, status: s.status, mode: s.mode }))));
if (!sessions.length) { console.log('❌ NO SESSIONS'); process.exit(1); }
const sid = sessions[0].id;
ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
await sleep(800);

if (SCENARIO === 'exit') {
  console.log('→ control set_permission_mode plan');
  ws.send(JSON.stringify({ type: 'control', sessionId: sid, subtype: 'set_permission_mode', extra: { mode: 'plan' } }));
  await sleep(1500);
}

console.log(`👤 ${TEXT}`);
ws.send(JSON.stringify({ type: 'user_message', sessionId: sid, text: TEXT }));

// Answer everything that is not the plan-approval ask on the way past; stop at ExitPlanMode.
const answered = new Set<string>();
const planAsks: any[] = [];
let exitReq: any = null;
const drain = () => {
  for (const p of perms) {
    if (answered.has(p.request_id)) continue;
    answered.add(p.request_id);
    const r = p.request;
    console.log(`\n──────── can_use_tool: ${r.tool_name} ────────`);
    console.log(JSON.stringify(p, null, 2).slice(0, 7000));
    console.log('────────\n');
    if (r.tool_name === 'ExitPlanMode') { exitReq = p; planAsks.push(p); continue; }
    if (r.tool_name === 'EnterPlanMode') planAsks.push(p);
    ws.send(JSON.stringify({ type: 'permission_response', sessionId: sid, requestId: p.request_id, behavior: 'allow' }));
  }
  return !!exitReq;
};

const gotExit = await waitFor(() => drain(), 240000);
dump();
if (!gotExit) {
  console.log('❌ no ExitPlanMode permission request in 240s');
  console.log('event types:', JSON.stringify(hist(events)));
  process.exit(1);
}

for (const p of planAsks) {
  const r = p.request;
  console.log(`\n=== ${r.tool_name}: input keys ${JSON.stringify(Object.keys(r.input || {}))}` +
    ` · description ${JSON.stringify(r.description ?? null)}` +
    ` · requires_user_interaction ${JSON.stringify(r.requires_user_interaction ?? null)}` +
    ` · suggestions ${JSON.stringify(r.permission_suggestions ?? null)}` +
    (typeof r.input?.plan === 'string' ? ` · plan ${r.input.plan.length} chars` : ''));
}

const frame: any = { type: 'permission_response', sessionId: sid, requestId: exitReq.request_id };
if (ANSWER === 'deny') { frame.behavior = 'deny'; frame.message = 'Not yet — step 2 must also update the usage line. Revise and show me again.'; }
else if (ANSWER === 'accept-edits') { frame.behavior = 'allow'; frame.updatedPermissions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]; }
else frame.behavior = 'allow';
console.log(`→ answering ExitPlanMode: ${JSON.stringify(frame)}`);
const askIdx = events.indexOf(exitReq);
ws.send(JSON.stringify(frame));

// What follows the answer is the interesting part: the tool_result, and what (if anything) tells
// a client the session's permission mode has changed.
await waitFor(() => events.slice(askIdx + 1).some((p) => p.type === 'result'), 90000);
await sleep(3000);
dump();

const after = events.slice(askIdx + 1);
console.log(`\n=== ${after.length} events after the ask ===`);
for (const p of after) {
  let extra = '';
  if (p.type === 'user') {
    const c = p.message?.content;
    const tr = Array.isArray(c) ? c.find((b: any) => b.type === 'tool_result') : null;
    if (tr) extra = ` tool_result: ${String(typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content)).slice(0, 400)}`;
  }
  if (p.type === 'system') extra = ` ${JSON.stringify(p).slice(0, 260)}`;
  if (p.type === 'assistant') {
    const txt = (p.message?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    if (txt) extra = ` ${txt.slice(0, 200)}`;
  }
  console.log(`  ${key(p)}${extra}`);
}
console.log('\nevent types (whole run):', JSON.stringify(hist(events)));
const modes = events.filter((p) => p.type === 'system' && p.subtype === 'init').map((p: any) => p.permissionMode);
console.log('permissionMode echoes, in order:', JSON.stringify(modes));
console.log(`fixture → ${OUT}`);
process.exit(0);
