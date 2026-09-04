/**
 * probe-plan-mode.ts — drive a real `claude` through a plan-mode turn over the stream-json
 * SDK protocol (the same message shapes the CCR v2 data-plane carries) and record every event,
 * so the front-end's plan-mode handling is written against what the wire actually says rather
 * than against the control-schema's idea of it.
 *
 * No injection and no server: `claude -p --input-format stream-json` speaks the identical
 * payloads, which is enough to learn the shape of EnterPlanMode / ExitPlanMode.
 *
 * Run: node test/probe-plan-mode.ts [--answer allow|deny|keep-planning] [--prompt "…"]
 * Output: test/fixtures/plan-mode-events.jsonl
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name: string, def: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const ANSWER = flag('answer', 'allow');
const PROMPT = flag('prompt', 'Plan how to add a hello() function to /tmp/ccc-plan-demo.ts. Keep it to two steps.');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plan-mode-events.jsonl');
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 180000);

const ts = () => new Date().toISOString().slice(11, 23);

function keyOf(p: any): string {
  if (!p || typeof p !== 'object') return String(p);
  if (p.type === 'system') return `system:${p.subtype ?? '?'}`;
  if (p.type === 'control_request') return `control_request:${p.request?.subtype ?? '?'}`;
  if (p.type === 'control_response') return `control_response:${p.response?.subtype ?? '?'}`;
  return String(p.type ?? '?');
}

async function main() {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'plan', '--permission-prompts', 'host',
  ];
  if (process.env.PROBE_MODEL) args.push('--model', process.env.PROBE_MODEL);

  console.log(`[${ts()}] launching: ${bin} ${args.join(' ')}`);
  const child = spawn(bin, args, {
    cwd: process.env.PROBE_CWD || '/tmp',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
  });

  const all: any[] = [];
  const counts = new Map<string, number>();
  let buf = '';

  const send = (o: any) => {
    console.log(`[${ts()}] → ${JSON.stringify(o).slice(0, 240)}`);
    child.stdin.write(JSON.stringify(o) + '\n');
  };

  const finish = (code: number) => {
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, all.map((p) => JSON.stringify(p)).join('\n') + '\n');
    console.log(`\n=== ${all.length} events → ${OUT}`);
    for (const [k, n] of [...counts.entries()].sort()) console.log(`  ${String(n).padStart(3)}  ${k}`);
    child.kill();
    setTimeout(() => process.exit(code), 200);
  };

  child.stdout.on('data', (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let p: any;
      try { p = JSON.parse(line); } catch { console.log(`[${ts()}] ‹raw› ${line.slice(0, 200)}`); continue; }
      all.push(p);
      const k = keyOf(p);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      console.log(`[${ts()}] ← ${k}  ${JSON.stringify(p).slice(0, 220)}`);

      if (p.type === 'control_request' && p.request?.subtype === 'can_use_tool') {
        console.log(`\n──────── can_use_tool (${p.request.tool_name}) ────────\n${JSON.stringify(p, null, 2)}\n────────\n`);
        const isExit = p.request.tool_name === 'ExitPlanMode';
        let response: any = { behavior: 'allow' };
        if (ANSWER === 'deny' || (ANSWER === 'keep-planning' && isExit)) {
          response = { behavior: 'deny', message: 'keep planning' };
        }
        send({ type: 'control_response', response: { subtype: 'success', request_id: p.request_id, response } });
      }
      if (p.type === 'result') finish(0);
    }
  });

  child.stderr.on('data', (d) => console.log(`[${ts()}] ‹err› ${String(d).slice(0, 400)}`));
  child.on('exit', (c) => { console.log(`[${ts()}] child exit ${c}`); finish(c ?? 0); });

  send({ type: 'user', message: { role: 'user', content: PROMPT } });
  setTimeout(() => { console.log('TIMEOUT'); finish(1); }, TIMEOUT_MS);
}

main().catch((e) => { console.error('[probe-plan-mode] fatal:', e); process.exit(1); });
