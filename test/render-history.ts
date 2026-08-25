/**
 * render-history.ts — dev tool: run the web's transcript reducer over a real session's stored
 * events and print what the phone would render, one line per item. Reads PostgreSQL directly,
 * so no server and no claude need to be running.
 *
 *   DATABASE_URL=… node test/render-history.ts [sessionId] [--items] [--json]
 *
 * Without a session id it takes the most recently active one. `--items` prints every item;
 * by default it prints a histogram plus anything that looks wrong (raw JSON leaking into a
 * card, an unthreaded tool call, an empty prose block).
 */
import { createPool, selectHistory } from '../src/server/db.ts';
import { reduceAll, type Item } from '../web/src/model.ts';
import { toolDisplayName } from '../src/tool-summary.ts';
// The reducer emits message descriptors, not prose, so this tool has to word them itself. `say`
// pins English rather than reading the store, so the output of a dev tool does not depend on the
// shell it was run from. (web/src/i18n/index.ts imports no React — that is deliberate, so a
// root-level Node script like this one can use it at all.)
import { say } from '../web/src/i18n/index.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
const args = process.argv.slice(2);
const wantItems = args.includes('--items');
const wantJson = args.includes('--json');
const sid = args.find((a) => !a.startsWith('--'));

const pool = createPool(url);
const chosen = sid ?? (await pool.query('select id from sessions order by last_activity desc limit 1')).rows[0]?.id;
if (!chosen) { console.error('no sessions'); process.exit(1); }
const events = await selectHistory(pool, chosen, 5000);
console.log(`session ${chosen} — ${events.length} stored events\n`);

const state = reduceAll(events);

const line = (it: Item): string => {
  switch (it.kind) {
    case 'user': return `user      ${JSON.stringify(it.text.slice(0, 70))}${it.state === 'queued' ? ' [queued]' : ''}`;
    case 'prose': return `prose     ${JSON.stringify(it.text.slice(0, 70))}${it.streaming ? ' [streaming]' : ''}`;
    case 'thinking': return `thinking  ${it.tokens ?? '?'} tokens · ${JSON.stringify(it.text.slice(0, 50))}`;
    case 'tools': return `tools     ${it.calls.map((c) => `${toolDisplayName(c.name)}:${c.status}`).join(' | ')}`;
    case 'todo': return `todo      ${it.tasks.map((task) => `${task.status[0]}:${say('en', task.subject).slice(0, 24)}`).join(' | ')}`;
    case 'question': return `question  ${it.questions.map((q) => q.header ?? q.question.slice(0, 24)).join(' | ')} ${it.answered ? '→ answered' : '→ PENDING'}`;
    case 'bgtask': return `bgtask    ${it.status} · ${say('en', it.description).slice(0, 50)}`;
    case 'status': return `status    ${say('en', it.text).slice(0, 70)}`;
    case 'error': return `error     ${say('en', it.title)} ${it.detail?.slice(0, 50) ?? ''}`;
    // These two had no arm at all, so `line()` returned undefined for them despite being typed
    // `: string` — nothing type-checks test/, so it compiled and printed nothing. A divider is
    // exactly the kind of beat this tool exists to show.
    case 'divider': return `divider   ${say('en', it.label)}`;
    case 'unknown': return `unknown   ${it.shape}${it.count > 1 ? ` ×${it.count}` : ''}`;
  }
};

if (wantJson) console.log(JSON.stringify(state.items, null, 2));
else if (wantItems) for (const it of state.items) console.log(line(it));

const hist: Record<string, number> = {};
for (const it of state.items) hist[it.kind] = (hist[it.kind] || 0) + 1;
console.log('\nitems:', JSON.stringify(hist));
console.log('live:', JSON.stringify({ ...state.live, slashCommands: state.live.slashCommands.length, skills: state.live.skills.length }));

// ── smells: things that mean the reducer or a tool descriptor is wrong ──
const problems: string[] = [];
let calls = 0, unthreaded = 0;
for (const it of state.items) {
  if (it.kind === 'tools') {
    for (const c of it.calls) {
      calls++;
      if (c.status === 'running' || c.status === 'awaiting') unthreaded++;
      if (!c.name) problems.push('tool call with no name');
    }
  }
  if (it.kind === 'prose' && !it.text.trim()) problems.push('empty prose item');
  if (it.kind === 'user' && /^<(local-command|command-name|system-reminder)/.test(it.text)) problems.push(`synthetic user text rendered: ${it.text.slice(0, 40)}`);
  if (it.kind === 'status' && say('en', it.text).startsWith('{')) problems.push('raw JSON in a status line');
}
console.log(`tool calls: ${calls} (${unthreaded} still open at the end)`);
if (problems.length) { console.log('\n⚠ problems:'); for (const p of new Set(problems)) console.log('  -', p); }
else console.log('✅ no obvious rendering problems');

await pool.end();
