/**
 * tool-summary.ts — the one place that knows how to name a tool call and pull its headline
 * argument out of the tool input. Shared by the server (session-list digest in store.ts) and
 * the web (tool cards in web/src/tools.ts), so the phone list and the transcript can never
 * disagree about what a call is called.
 *
 * Display names are the CLI's own `userFacingName()` values, read out of the 2.1.232 bundle —
 * the design's copy rule is "tool names verbatim from the CLI, never renamed for mobile".
 * Note Grep AND Glob both surface as "Search" in the CLI; the argument disambiguates them.
 */

/** Only tools whose display name differs from the wire name need an entry. */
const DISPLAY_NAMES: Record<string, string> = {
  Grep: 'Search',
  Glob: 'Search',
  WebSearch: 'Web Search',
  NotebookEdit: 'Edit Notebook',
  TaskOutput: 'Task Output',
  TaskStop: 'Stop Task',
  MCPWaitForServers: 'MCP Wait For Servers',
};

/** `mcp__linear__create_issue` → `Create Issue` (the CLI's own prettifier). */
function prettifyMcp(name: string): string {
  return (name.split('__').pop() || name).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function toolDisplayName(name: string): string {
  if (!name) return 'Tool';
  if (name.startsWith('mcp__')) return prettifyMcp(name);
  return DISPLAY_NAMES[name] ?? name;
}

/** Injected by the RC bridge itself, never a user-visible call (see push-event.ts). */
export const HIDDEN_TOOLS = new Set(['PushNotification']);
/** Arrives as a can_use_tool permission request and is rendered as a question card, not a tool card. */
export const QUESTION_TOOL = 'AskUserQuestion';

/**
 * Plan mode's two tools. Neither is a tool card, and the CLI agrees — both define
 * `renderToolUseMessage(){return null}` and an empty `userFacingName()`, so the terminal draws a
 * dedicated surface for each and no tool row at all.
 *
 * `ExitPlanMode` arrives as a `can_use_tool` request carrying the whole plan
 * (`input:{plan, planFilePath}`, injected from disk by the CLI's own normalizeToolInput) and
 * `requires_user_interaction:true` — which the control schema defines as "one-tap Approve/Deny
 * must NOT be offered: the tool's approval card IS the user-interaction surface". So it gets a
 * plan card, the same way AskUserQuestion gets a question card.
 *
 * `EnterPlanMode` never asks: its input is `{}`, it is read-only, and it is auto-approved — the
 * only trace on the wire is the tool_use, a tool_result of internal instructions, and a re-sent
 * `system:init` carrying the new mode (verified against 2.1.260, test/fixtures/plan-mode-*.jsonl).
 */
export const PLAN_EXIT_TOOL = 'ExitPlanMode';
export const PLAN_ENTER_TOOL = 'EnterPlanMode';

/** Input field that carries the headline argument, most specific first. */
const ARG_KEYS = [
  'command', 'file_path', 'notebook_path', 'pattern', 'query', 'url', 'skill',
  'subject', 'description', 'prompt', 'operation', 'to', 'taskId', 'task_id', 'path', 'name',
];

const MAX_ARG = 400; // enough for a wrapped two-line command; the full text lives in the raw output

/**
 * The short argument shown next to the tool name. Never paraphrased — only truncated
 * (design copy rule: commands and paths are never rewritten).
 */
export function toolArg(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  let v: string | undefined;
  for (const k of ARG_KEYS) {
    const raw = o[k];
    if (typeof raw === 'string' && raw.trim()) { v = raw.trim(); break; }
  }
  if (v === undefined) {
    for (const raw of Object.values(o)) {
      if (typeof raw === 'string' && raw.trim()) { v = raw.trim(); break; }
    }
  }
  if (v === undefined) return '';
  // Grep/Glob read better with the scope appended.
  if ((name === 'Grep' || name === 'Glob') && typeof o.path === 'string' && o.path && o.path !== v) {
    v = `${v}  ${o.path}`;
  }
  return v.length > MAX_ARG ? v.slice(0, MAX_ARG) + '…' : v;
}

/** Split a path for two-tone rendering: `src/routes/` + `handler.ts`. */
export function splitPath(p: string): { dir: string; base: string } {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  if (i < 0) return { dir: '', base: p };
  return { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

/** True when the tool's headline argument is a filesystem path (render it two-tone). */
export function argIsPath(name: string): boolean {
  return name === 'Read' || name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'Artifact';
}
