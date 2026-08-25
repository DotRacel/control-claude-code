/**
 * phone.tsx — the phone's renderer for every item kind, as one `ItemRenderers` object.
 *
 * Rendering rules taken from the design doc:
 *  - assistant prose is serif, with no avatar and no bubble; the user's turn is the only bubble,
 *    and it hugs the right edge rather than taking the full column
 *  - adjacent tool calls are one bordered group, each row a single line + a result line
 *  - a tool's raw output is NOT inline: the row opens the output sheet (1e)
 *  - only the newest item animates in; earlier ones never re-animate on re-render (0c)
 *  - a tool card is one element to a screen reader ("Bash, npm test, failed, double-tap …")
 *
 * The keys of `phoneRenderers` are checked against `Item['kind']` (render/contract.ts), so this
 * file is where a newly added item kind fails to compile until someone decides how a phone draws
 * it. Everything touch-shaped lives here on purpose — long-press, scroll slop, bottom sheets — so
 * a second platform can differ where it should and share the reducer where it must.
 */
import { Fragment, useRef, useState } from 'react';
import type { Item, ToolCall, TodoTask, Question } from '../model.ts';
import { type ItemActions, type ItemRenderers, type LiveSurfaces, enterClass } from './contract.ts';
import { PermissionSheet, OutputSheet, MenuSheet, HelpSheet, ConfirmSheet } from '../components/Sheets.tsx';
import { ToolRowBody, ImageStrip, toolRowLabel } from './parts.tsx';
import { durationLabel } from '../tools.ts';
import { renderMarkdown } from '../md.ts';
import { haptic } from '../haptics.ts';
import { Check, Alert, Brain, ClaudeMark } from '../icons.tsx';
// The bare `t`, not the hook: everything in this file renders under ItemView, which subscribes to
// the locale on behalf of all of it (see the note in components/Transcript.tsx).
import { t } from '../i18n/index.ts';

const LONG_PRESS_MS = 400;
/**
 * A touch that travels further than this is a scroll, not a tap. iOS does NOT reliably send
 * touchcancel when a drag inside a scroll container turns into a scroll — the same touch just
 * ends normally — so a hand-rolled touchend handler would open the card you scrolled off.
 */
const SCROLL_SLOP_PX = 10;

/**
 * One entry per kind the reducer can produce. Each is the arm of what used to be a `switch`; the
 * difference is that a missing arm is now a type error rather than a blank space on the screen.
 */
export const phoneRenderers: ItemRenderers = {
  // Two elements, not one. The bubble hugs the right edge, but the transcript column is one
  // shared measure — on the desktop every item is centred and capped at 45rem, and a bubble that
  // pinned ITSELF right would sit outside that column, off-centre from the prose beside it (the
  // regression test/ui-shot's geometry gate exists to catch). So the row is the column item, full
  // width like everything else, and the bubble is right-aligned INSIDE it.
  user: ({ it, isLast }) => (
    <div className={`bubble-row ${enterClass(isLast) ?? ''}`}>
      <div className={`bubble-user${it.state === 'queued' ? ' queued' : ''}`}>
        {it.text}
      </div>
    </div>
  ),

  prose: ({ it, isLast }) => (
    <div className={`prose md ${enterClass(isLast) ?? ''}`}>
      {renderMarkdown(it.text)}
      {it.streaming && <span className="caret" />}
    </div>
  ),

  // A textless block carries nothing to read, so it renders nothing at all.
  thinking: ({ it, isLast }) => (it.text.trim() ? <ThinkingView it={it} cls={enterClass(isLast)} /> : null),

  tools: ({ it, isLast, h }) => <ToolGroup calls={it.calls} cls={enterClass(isLast)} h={h} />,

  todo: ({ it, isLast }) => <TodoCard tasks={it.tasks} cls={enterClass(isLast)} />,

  question: ({ it, isLast, h }) => <QuestionCard it={it} cls={enterClass(isLast)} onAnswer={h.onAnswerQuestion} />,

  bgtask: ({ it, isLast }) => <BgTaskCard it={it} cls={enterClass(isLast)} />,

  status: ({ it, isLast }) => <div className={`status-line ${enterClass(isLast) ?? ''}`}>{t(it.text)}</div>,

  // /clear, a compaction, or the worker going away: the turns above it belong to a conversation
  // that no longer exists, so the break has to be visible.
  divider: ({ it, isLast }) => <div className={`divider ${enterClass(isLast) ?? ''}`}><span>{t(it.label)}</span></div>,

  error: ({ it, isLast }) => (
    <div className={`error-card ${enterClass(isLast) ?? ''}`}>
      <div className="t1"><Alert size={14} /> {t(it.title)}</div>
      {it.detail && <div className="t2">{it.detail}</div>}
    </div>
  ),

  unknown: ({ it, isLast }) => <UnknownChip it={it} cls={enterClass(isLast)} />,
};

/**
 * A payload we could not render. Deliberately the quietest thing on the screen — it is a note to
 * whoever maintains this, not news for the person reading the conversation — but present, because
 * the alternative is a transcript that skips a beat with nothing to show it happened. The shape is
 * spelled out so a screenshot is a bug report: it is the exact key `npm run shape-report` lists.
 */
function UnknownChip({ it, cls }: { it: Extract<Item, { kind: 'unknown' }>; cls?: string }) {
  return (
    <div className={`unknown-chip ${cls ?? ''}`} title={t({ k: 'unknown.title' })}>
      ⋯ {t({ k: 'unknown.chip' })} · {it.shape}{it.count > 1 ? ` ×${it.count}` : ''}
    </div>
  );
}

/**
 * The data plane relays `thinking: ""` — the signature only, never the reasoning text (verified
 * across every thinking block in a real session). So in practice this never renders; it exists for
 * the case where a future version does send the text, and only ever with text in hand (the
 * renderer above drops the textless markers).
 */
function ThinkingView({ it, cls }: { it: Extract<Item, { kind: 'thinking' }>; cls?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thinking ${cls ?? ''}`}>
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        <Brain size={14} />
        {t({ k: 'thinking.label' })} · {open ? t({ k: 'thinking.collapse' }) : t({ k: 'thinking.expand' })}
      </button>
      {open && <div className="thinking-body">{it.text}</div>}
    </div>
  );
}

/**
 * A background task, with whatever `system:task_progress` has said since it started. Those frames
 * are the only news a long task ever gives — a workflow can run for minutes between its
 * `task_started` and its notification — so the card shows the current step, not just a spinner.
 */
function BgTaskCard({ it, cls }: { it: Extract<Item, { kind: 'bgtask' }>; cls?: string }) {
  const running = it.status === 'running';
  const state = running ? t({ k: 'bgtask.running' })
    : it.status === 'failed' ? t({ k: 'bgtask.failed' })
    : it.status === 'interrupted' ? t({ k: 'bgtask.interrupted' })   // the worker went away mid-task
    : t({ k: 'bgtask.done' });
  const tools = it.tools
    ? t({ k: it.tools === 1 ? 'tool.toolCountOne' : 'tool.toolCountMany', p: { n: it.tools } })
    : null;
  const bits = [state, durationLabel(it.ms), tools].filter(Boolean);
  return (
    <div className={`bgtask${it.status === 'failed' ? ' failed' : ''} ${cls ?? ''}`}>
      <span className={`dot ${running ? 'run' : it.status === 'completed' ? 'on' : 'off'}`} />
      <div className="bgtask-text">
        <div className="t1">{t(it.description)}</div>
        <div className="t2">{t({ k: 'bgtask.label' })} · {bits.join(' · ')}</div>
        {/* Where it got to. Dropped once a task completes (the step it ended on says nothing then),
            but kept for one that failed or was interrupted — that IS the useful part. */}
        {it.status !== 'completed' && it.detail && <div className="t3">{it.detail}</div>}
        {it.status !== 'completed' && it.phases && it.phases.length > 0 && (
          <div className="t3 phases">{it.phases.join(' › ')}</div>
        )}
      </div>
    </div>
  );
}



function ToolGroup({ calls, cls, h }: { calls: ToolCall[]; cls?: string; h: ItemActions }) {
  const bad = calls.some((c) => c.status === 'error');
  const waiting = calls.some((c) => c.status === 'awaiting');
  return (
    <div className={`tool-group${bad ? ' err' : ''}${waiting ? ' await' : ''} ${cls ?? ''}`}>
      {calls.map((c) => (
        <Fragment key={c.toolUseId}>
          <ToolRow call={c} onOpen={h.onOpenOutput} />
          {c.images && c.images.length > 0 && <ImageStrip images={c.images} h={h} />}
        </Fragment>
      ))}
    </div>
  );
}

function ToolRow({ call, onOpen }: { call: ToolCall; onOpen: (c: ToolCall) => void }) {
  const [pressed, setPressed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);
  const touched = useRef(false); // a touch also emits synthetic mouse events; ignore those
  const from = useRef<{ x: number; y: number } | null>(null); // where the finger landed
  const scrolled = useRef(false); // …and whether it then moved enough to be a scroll
  const openable = !!call.result;

  const begin = () => {
    if (!openable) return;
    fired.current = false;
    setPressed(true);
    // Long-press is the design's gesture (0c: 400ms, card scales to .98); a plain tap opens it
    // too, because on a phone nobody discovers a long-press on their own.
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      fired.current = true;
      haptic('selection');
      setPressed(false);
      onOpen(call);
    }, LONG_PRESS_MS);
  };
  const end = (fire: boolean) => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setPressed(false);
    if (fire && !fired.current && openable) onOpen(call);
  };

  return (
    <button
      className={`tool-row${pressed ? ' press' : ''}`}
      onTouchStart={(e) => {
        touched.current = true;
        const t = e.touches[0];
        from.current = t ? { x: t.clientX, y: t.clientY } : null;
        scrolled.current = false;
        begin();
      }}
      onTouchMove={(e) => {
        const f = from.current;
        const t = e.touches[0];
        if (!f || !t || scrolled.current) return;
        if (Math.abs(t.clientY - f.y) > SCROLL_SLOP_PX || Math.abs(t.clientX - f.x) > SCROLL_SLOP_PX) {
          scrolled.current = true;
          end(false); // also kills the pending long-press, so a slow scroll cannot open it either
        }
      }}
      onTouchEnd={() => end(!scrolled.current)}
      onTouchCancel={() => end(false)}
      onMouseDown={() => { if (!touched.current) begin(); }}
      onMouseUp={() => { if (!touched.current) end(true); }}
      onMouseLeave={() => { if (!touched.current) end(false); }}
      disabled={!openable}
      aria-label={toolRowLabel(call, openable, { k: 'a11y.openOutputPhone' })}
    >
      <ToolRowBody call={call} />
    </button>
  );
}


function TodoCard({ tasks, cls }: { tasks: TodoTask[]; cls?: string }) {
  return (
    <div className={`tool-group ${cls ?? ''}`}>
      <div className="tool-head">{t({ k: 'tool.todoList' })}</div>
      <div className="todo-list">
        {/* `task`, not `t` — the old name now shadows the translator. */}
        {tasks.map((task) => (
          <div key={task.key} className={`todo-item ${task.status === 'completed' ? 'done' : task.status === 'in_progress' ? 'active' : ''}`}>
            <span className="todo-box">{task.status === 'completed' && <Check size={11} stroke="#1f1e1c" />}</span>
            <span>{t(task.subject)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * AskUserQuestion. It arrives as a can_use_tool permission request, but a 2–4 question form
 * does not fit a modal, so it renders inline and the transcript stays scrollable behind it.
 * Answering replies allow + updatedInput.answers (question text → chosen label).
 */
function QuestionCard({ it, cls, onAnswer }: {
  it: Extract<Item, { kind: 'question' }>;
  cls?: string;
  onAnswer: ItemActions['onAnswerQuestion'];
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [freeform, setFreeform] = useState('');
  const answered = it.answered !== undefined;

  const toggle = (q: Question, label: string) => {
    haptic('selection');
    setPicked((prev) => {
      const cur = prev[q.question] ?? [];
      if (q.multiSelect) {
        return { ...prev, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [q.question]: cur[0] === label ? [] : [label] };
    });
  };

  const submit = (skip: boolean) => {
    const answers: Record<string, string> = {};
    if (!skip) for (const q of it.questions) {
      const cur = picked[q.question];
      if (cur?.length) answers[q.question] = cur.join(', '); // multi-select is comma-joined (worker's own format)
    }
    onAnswer(it, answers, skip ? undefined : freeform.trim() || undefined);
  };

  const complete = it.questions.every((q) => picked[q.question]?.length) || !!freeform.trim();

  return (
    <div className={`qcard${answered ? ' answered' : ''} ${cls ?? ''}`}>
      <div className="qcard-head"><ClaudeMark size={15} fill="#d97757" /><span className="t1">{t({ k: 'question.claudeAsks' })}</span></div>
      {it.questions.map((q, qi) => (
        <div className="qblock" key={qi}>
          {q.header && <span className="qchip">{q.header}</span>}
          <div className="qtext">{q.question}</div>
          {!answered && (
            <div className="qopts">
              {q.options.map((o, oi) => {
                const on = (picked[q.question] ?? []).includes(o.label);
                return (
                  <button key={oi} className={`qopt${on ? ' on' : ''}`} onClick={() => toggle(q, o.label)}>
                    <div className="l">{o.label}</div>
                    {o.description && <div className="d">{o.description}</div>}
                    {o.preview && <div className="p">{o.preview}</div>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {answered
        ? <div className="qanswer">{t(it.answered!).trim() || t({ k: 'question.answered' })}</div>
        : (
          <>
            <div className="qblock" style={{ paddingTop: 0 }}>
              <input
                className="qother" placeholder={t({ k: 'question.freeform' })} value={freeform}
                onChange={(e) => setFreeform(e.target.value)}
              />
            </div>
            <div className="qactions">
              <button className="btn" onClick={() => { haptic('medium'); submit(true); }}>{t({ k: 'question.skip' })}</button>
              <button className="btn primary" style={{ flex: 1 }} disabled={!complete} onClick={() => { haptic('light'); submit(false); }}>{t({ k: 'question.submit' })}</button>
            </div>
          </>
        )}
    </div>
  );
}

/**
 * The phone's answer to all five modal surfaces: a bottom sheet, every time (Sheet.tsx owns the
 * drag-to-dismiss, and the permission sheet's dismiss is a deny — see LiveSurfaces).
 *
 * These are one-to-one with the components Sheets.tsx already exported, so this object is a
 * declaration rather than an adapter: its value is that `LiveSurfaces` now fails to compile when a
 * surface is added and a platform has not answered for it.
 */
export const phoneSurfaces: LiveSurfaces = {
  permission: PermissionSheet,
  output: OutputSheet,
  menu: MenuSheet,
  help: HelpSheet,
  confirm: ConfirmSheet,
};
