/**
 * task-status.ts — the wire's vocabulary for how a background task ended, and the headline a
 * card can show when the summary it was handed is an entire agent report.
 *
 * Both exist because the same event reaches the reducer three different ways and no two of them
 * agree on wording. A user pressing stop on an agent produces, in one session:
 *
 *   system:task_updated       patch.status = "killed"
 *   system:task_notification  status       = "stopped"
 *   user:<string>             <status>killed</status>   (the `<task-notification>` text echo)
 *
 * Each of the three used to map its own subset and let everything else fall through to a default,
 * so a task the user killed was labelled 完成 by two of them and left spinning 运行中 by the third
 * — while its own summary line read `Agent "…" was stopped by user`. A card contradicting its own
 * subtitle is worse than no card. One table, three callers.
 *
 * `null` for a word nobody has decided about is deliberate, and is the same three-state rule
 * src/wire-shape.ts applies one level up: an unrecognised status must reach the backlog, never be
 * guessed into `completed`. That is exactly how `killed` hid for as long as it did.
 */

/** What a task card can say. `interrupted` covers every "it stopped before finishing" word. */
export type TaskState = 'running' | 'completed' | 'failed' | 'interrupted';

/**
 * Every terminal (and non-terminal) word observed on the wire, plus the near neighbours of each.
 * The synonyms are not speculation for its own sake: the three producers above already disagree,
 * so the next one will too, and a word like `cancelled` landing in the backlog would be a report
 * about our vocabulary rather than about the protocol.
 *
 * `timed_out` is a failure, not an interruption: nobody chose to stop it.
 */
const STATES: Record<string, TaskState> = {
  running: 'running',
  in_progress: 'running',
  pending: 'running',
  queued: 'running',
  active: 'running',

  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  success: 'completed',
  succeeded: 'completed',

  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  timed_out: 'failed',
  timeout: 'failed',

  // The user (or the harness) ended it early. Neither `completed` — it did not finish — nor
  // `failed`, since nothing went wrong.
  stopped: 'interrupted',
  killed: 'interrupted',
  cancelled: 'interrupted',
  canceled: 'interrupted',
  interrupted: 'interrupted',
  aborted: 'interrupted',
};

/** The card state for a wire status word, or null if we have never decided about it. */
export function taskStateOf(raw: unknown): TaskState | null {
  if (typeof raw !== 'string') return null;
  return STATES[raw.trim().toLowerCase()] ?? null;
}

/** How long a task card's title line may be before it stops being a title. */
export const HEADLINE_MAX = 100;

/**
 * The first readable line of a summary, for use as a card title.
 *
 * A `task_notification` for a Bash task carries a real one-line summary ("Run quarkusBuild to
 * validate CDI wiring"). For a subagent it carries the agent's ENTIRE final report — 30122
 * characters of markdown in the sampled history, which the card then rendered as its title,
 * unclipped. So the summary cannot be trusted as a label, and it cannot simply be truncated
 * either: the report is not stored anywhere else (the Agent tool_result is a different, shorter
 * text), so the caller keeps the full string alongside and shows it behind a toggle.
 *
 * Markdown furniture is stripped rather than rendered, because this lands in a plain title slot:
 * a leading `##`, a bullet, a blockquote marker. `---` and code fences are skipped outright —
 * they are not a line anyone can read.
 */
export function headlineOf(summary: string, max = HEADLINE_MAX): string {
  for (const raw of summary.split('\n')) {
    const line = raw
      .replace(/^\s*#{1,6}\s+/, '')      // ## Answer
      .replace(/^\s*[-*+]\s+/, '')       // - a bullet
      .replace(/^\s*>\s*/, '')           // > a quote
      .trim();
    if (!line) continue;
    if (/^(-{3,}|_{3,}|\*{3,}|`{3,}|~{3,})/.test(line)) continue; // rules and fences
    return line.length > max ? line.slice(0, max).trimEnd() + '…' : line;
  }
  return '';
}

/**
 * Does this summary carry more than its headline? Only then is a "show the report" affordance
 * worth drawing — a one-line Bash summary must not grow a toggle that reveals the same line.
 */
export function hasReportBody(summary: string): boolean {
  const h = headlineOf(summary);
  return h !== '' && summary.trim() !== h;
}
