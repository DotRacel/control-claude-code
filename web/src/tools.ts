/**
 * tools.ts — how a tool call is summarised on a card. Names and headline arguments come from
 * the shared src/tool-summary.ts (the server's session-list digest uses the same source), this
 * file adds the one-line result summary the collapsed card shows.
 *
 * Note on exit codes: the design's `exit 1` line is not reproducible — the data plane gives us
 * `is_error` and the output text, never a numeric status. So a failed call shows the first line
 * of its actual error instead of an invented exit code.
 */
import {
  toolDisplayName, toolArg, splitPath, argIsPath, HIDDEN_TOOLS, QUESTION_TOOL,
  PLAN_EXIT_TOOL, PLAN_ENTER_TOOL,
} from '../../src/tool-summary.ts';
import type { ToolCall } from './model.ts';
import type { Msg } from './i18n/msg.ts';

export {
  toolDisplayName, toolArg, splitPath, argIsPath, HIDDEN_TOOLS, QUESTION_TOOL,
  PLAN_EXIT_TOOL, PLAN_ENTER_TOOL,
};

const firstLine = (s: string, max = 120): string => {
  const line = (s.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > max ? line.slice(0, max) + '…' : line;
};
const countLines = (s: string): number => (s ? s.split('\n').filter((l) => l.length).length : 0);

/** `+6 −2` for an Edit, computed from the strings it was given. Returned as numbers because the
 * card colours the two halves separately (green added / red removed). */
function editDelta(input: any): { add: number; del: number } | null {
  if (typeof input?.new_string !== 'string' || typeof input?.old_string !== 'string') return null;
  const add = input.new_string ? input.new_string.split('\n').length : 0;
  const del = input.old_string ? input.old_string.split('\n').length : 0;
  return { add, del };
}

/** `310 KB` — the size a not-yet-loaded image announces. */
export function byteLabel(n: number | undefined): string {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** `PNG` — the type shown on the placeholder, from the block's media type. The media subtype is a
 * literal and stays one; only the "we could not tell" fallback needs a language. */
export function imageKindLabel(mediaType: string | undefined): Msg {
  if (!mediaType) return { k: 'image.generic' };
  const sub = mediaType.split('/')[1] ?? '';
  return sub ? sub.replace('+xml', '').toUpperCase() : { k: 'image.generic' };
}

/** Where the bytes of a stripped image live. Built here so the components stay presentational. */
export function blobUrl(sessionId: string, ref: string): string {
  return `/v1/blob?session=${encodeURIComponent(sessionId)}&ref=${encodeURIComponent(ref)}`;
}

export function durationLabel(ms: number | undefined): string | null {
  if (!ms || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** `text` is always the plain reading of the line (it is also the card's accessible name); `delta`
 * is set alongside it when the two counts should render as coloured spans instead.
 *
 * `text` is a `Msg`, not a string, for the same reason the reducer's is: this function is called
 * from Node by test/render-history.ts and from both platform renderers, none of which agree on a
 * language. A bare string in there is final text off the wire (a tool's own error line, an Edit's
 * `+6 −2`); an object is a catalog key. */
export interface ResultLine { text: Msg; isError?: boolean; delta?: { add: number; del: number } }

/** The single line a collapsed tool card shows. Status is present tense, lowercase after the
 * first word (design copy rule): "Running…", not "RUNNING". */
export function resultLine(call: ToolCall): ResultLine | null {
  if (call.status === 'running') return { text: { k: 'tool.running' } };
  if (call.status === 'awaiting') return { text: { k: 'tool.awaiting' } };

  const out = call.result ?? '';
  if (call.status === 'error') {
    // The tool's own first line when it produced one — that text came off the wire and is never
    // translated; only the "we got nothing" fallback is ours to word.
    return { text: firstLine(out) || { k: 'tool.failed' }, isError: true };
  }
  // An image-only result (a `Read` of a screenshot) has no text to count lines of; the images
  // themselves render under the row, so the line just says what arrived.
  const images = call.images?.length ?? 0;
  if (images && !out.trim()) {
    return { text: images > 1 ? { k: 'tool.imageMany', p: { n: images } } : { k: 'tool.imageOne' } };
  }
  switch (call.name) {
    case 'Read': {
      const n = countLines(out);
      return { text: n ? { k: n === 1 ? 'tool.readOne' : 'tool.readMany', p: { n } } : { k: 'tool.done' } };
    }
    case 'Edit':
    case 'NotebookEdit': {
      const d = editDelta(call.input);
      return d ? { text: `+${d.add} −${d.del}`, delta: d } : { text: { k: 'tool.modified' } };
    }
    case 'Write': {
      const n = typeof call.input?.content === 'string' ? call.input.content.split('\n').length : 0;
      return { text: n ? { k: n === 1 ? 'tool.wroteOne' : 'tool.wroteMany', p: { n } } : { k: 'tool.written' } };
    }
    case 'Grep':
    case 'Glob': {
      const n = countLines(out);
      return { text: n ? { k: n === 1 ? 'tool.matchOne' : 'tool.matchMany', p: { n } } : { k: 'tool.noMatch' } };
    }
    default: {
      const l = firstLine(out);
      return { text: l || { k: 'tool.done' } };
    }
  }
}
