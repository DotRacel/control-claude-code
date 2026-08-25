/**
 * session.ts — everything about "how one session works", with no opinion about how it looks.
 *
 * This is the same split the transcript already makes between `model.ts` (what the events mean)
 * and `render/*` (how a platform draws them), applied one level up: subscribing, backfilling,
 * seeding `busy`, sending, stopping, answering a permission, and keeping the transcript pinned to
 * the bottom are identical on a phone and on a desktop. Writing them twice would be a second
 * implementation to keep in sync — and the drift would be invisible until someone noticed their
 * laptop had stopped re-subscribing after a reconnect.
 *
 * What deliberately stays in the views, because it IS a presentation decision:
 *  - haptics (the phone fires one on a permission; a desktop has nothing to fire)
 *  - the `--header-h` measurement, which only the phone's floating frosted header needs
 *  - which surface a permission or a tool output opens into (sheet vs modal)
 */
import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import type { ControlSocket, SessionView, Connection, PermissionAnswer } from './ws.ts';
import {
  reduce, initialState, localSend, markQuestionAnswered, clearPermission, turnActiveIn,
  type TranscriptState, type ToolCall,
} from './model.ts';
import type { ItemActions } from './render/contract.ts';
import { toolDisplayName, blobUrl } from './tools.ts';
import { showPushNotification } from './notify.ts';
import type { Msg } from './i18n/msg.ts';
import { useT } from './i18n/react.ts';

/** Within this many pixels of the bottom, new items keep scrolling into view (0c). */
const PIN_PX = 120;

export interface SessionController {
  state: TranscriptState;
  /** The agent holds the turn. */
  busy: boolean;
  /** No socket, or no claude on the other end: the composer goes read-only, never the transcript. */
  offline: boolean;
  actions: ItemActions;
  send: (text: string) => void;
  stop: () => void;
  answerPermission: (a: PermissionAnswer) => void;
  /** The tool call whose raw output the user asked to see, if any. */
  output: ToolCall | null;
  setOutput: (c: ToolCall | null) => void;
  /** `requestId` of the open permission, for whatever the platform wants to do on arrival. */
  permissionId: string | undefined;
  /** Text for an aria-live region. */
  announce: string;
  /** `machine · branch · model · mode`, for a header or a menu. */
  meta: string;
}

export function useSession({ session, sock, connection, registerEvent, registerHistory }: {
  session: SessionView;
  sock: ControlSocket;
  connection: Connection;
  registerEvent: (cb: (sid: string, p: any) => void) => void;
  registerHistory: (cb: (sid: string, events: any[]) => void) => void;
}): SessionController {
  const t = useT();
  const [state, setState] = useState<TranscriptState>(() => initialState());
  const [output, setOutput] = useState<ToolCall | null>(null);
  // Stays a plain string, not a Msg: an aria-live announcement is a one-shot that a screen reader
  // reads once and the next turn replaces. Threading a Msg through SessionController and both
  // chat views to re-word a sentence nobody is still listening to would buy nothing.
  const [announce, setAnnounce] = useState('');
  const stateRef = useRef(state);
  stateRef.current = state;

  // A reconnect re-subscribes and so backfills again (App.tsx); read the status through a ref so
  // that second backfill sees the current one, not whatever it was when the session was opened.
  const activeRef = useRef(false);
  activeRef.current = session.status === 'active';

  // Seed "the agent holds the turn" from the list digest, so reopening a busy session shows
  // the Stop button immediately instead of waiting for the next event.
  useEffect(() => {
    setState(() => {
      const s = initialState();
      return activeRef.current && session.digest?.turnActive ? { ...s, live: { ...s.live, busy: true } } : s;
    });
    sock.subscribe(session.id);
    registerHistory((sid, evs) => {
      if (sid !== session.id) return;
      let s = initialState();
      for (const e of evs) s = reduce(s, e, { isHistory: true });
      // The backfill replaces the whole state, seed included, so `busy` has to be re-derived here
      // — from the events themselves rather than the digest, which was a snapshot taken when the
      // session list was built. A session whose claude is gone is never mid-turn.
      setState({ ...s, live: { ...s.live, busy: activeRef.current && turnActiveIn(evs) } });
    });
    registerEvent((sid, payload) => {
      if (sid !== session.id) return;
      setState((prev) => reduce(prev, payload, { isHistory: false }));
    });
    return () => { registerEvent(() => {}); registerHistory(() => {}); };
  }, [session.id]);

  // A permission arriving is the one thing worth interrupting you for. The notification is
  // platform-neutral; the phone's haptic is not, and fires from the view.
  const permissionId = state.live.permission?.requestId;
  useEffect(() => {
    if (!permissionId) return;
    setAnnounce(t({ k: 'announce.needsApproval' }));
    if (document.visibilityState !== 'visible') {
      showPushNotification(t({ k: 'push.needsApproval', p: { tool: toolDisplayName(stateRef.current.live.permission!.toolName) } }), { force: true });
    }
  }, [permissionId]);

  const busy = state.live.busy;
  useEffect(() => { if (!busy) setAnnounce(t({ k: 'announce.turnDone' })); }, [busy]);

  const offline = connection !== 'online' || session.status !== 'active';

  const actions: ItemActions = useMemo(() => ({
    onOpenOutput: (call) => setOutput(call),
    onAnswerQuestion: (item, answers, freeform) => {
      const updatedInput: Record<string, unknown> = { questions: item.questions, answers };
      if (freeform) updatedInput.response = freeform;
      sock.respondPermission(session.id, item.requestId, { behavior: 'allow', updatedInput });
      // The answers are the reader's own words, so they are wire text; only "they skipped it" is
      // ours to word, which is exactly the split `Msg`'s bare-string arm exists for.
      const joined = Object.entries(answers).map(([q, a]) => `${q} → ${a}`).join('\n');
      const summary: Msg = joined || freeform || { k: 'question.skipped' };
      setState((prev) => markQuestionAnswered(prev, item.requestId, summary));
    },
    // A stripped image resolves to the blob route (the cookie authenticates the <img>); an
    // unstripped one already carries its own data URL.
    imageUrl: (att) => att.dataUrl ?? (att.ref ? blobUrl(session.id, att.ref) : undefined),
  }), [session.id, sock]);

  const answerPermission = (a: PermissionAnswer) => {
    const req = stateRef.current.live.permission;
    if (!req) return;
    sock.respondPermission(session.id, req.requestId, a);
    setState((prev) => clearPermission(prev));
  };

  const send = (text: string) => {
    sock.sendMessage(session.id, text);
    setState((prev) => localSend(prev, text, prev.live.busy));
  };

  const stop = () => {
    sock.control(session.id, 'interrupt');
    setState((prev) => ({ ...prev, live: { ...prev.live, busy: false, running: undefined, thinking: false } }));
  };

  const meta = [session.machine, session.branch, state.live.model, state.live.permissionMode]
    .filter(Boolean).join(' · ');

  return { state, busy, offline, actions, send, stop, answerPermission, output, setOutput, permissionId, announce, meta };
}

export interface TranscriptScroll {
  /** Structural, not `RefObject`: React 19 renamed the mutable-ref types and this needs neither. */
  scrollRef: { current: HTMLDivElement | null };
  /** Following the bottom. False the moment the reader scrolls up, which reveals the ↓ button. */
  pinned: boolean;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  toBottom: () => void;
}

/**
 * Keep the transcript following the bottom, on any platform.
 *
 * `deps` are whatever makes the content taller — the items and the busy flag. The ResizeObserver
 * covers the case no dependency can: the composer grows line by line as you type (and the slash
 * picker opens above it), so the scroller shrinks with no new item at all. Without it the last
 * message slides behind the composer while you are writing about it.
 */
export function useTranscriptScroll(deps: unknown[]): TranscriptScroll {
  const [pinned, setPinned] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [...deps, pinned]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (pinnedRef.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return {
    scrollRef,
    pinned,
    onScroll: (e) => {
      const el = e.currentTarget;
      setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < PIN_PX);
    },
    toBottom: () => {
      setPinned(true);
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    },
  };
}
