/**
 * ChatView.tsx — one session: header, connection banner, transcript, activity spinner, composer,
 * and the three sheets.
 *
 * Rules from the design doc that are easy to break and so are called out here:
 *  - a connection change NEVER destroys the transcript; losing the socket degrades the composer
 *    to read-only and shows a banner under the header (1g)
 *  - autoscroll stays pinned within 120px of the bottom; scrolling up unpins and reveals the
 *    scroll-to-bottom button (0c)
 *  - dismissing the permission sheet by drag is a DENY, never an allow (0c)
 *  - haptics fire once per event and never during streaming (0c)
 */
import { useEffect, useRef, useState } from 'react';
import type { ControlSocket, SessionView, Connection, PermissionAnswer } from '../ws.ts';
import { useSession, useTranscriptScroll } from '../session.ts';
import { ItemView } from './Transcript.tsx';
import { ActivityLine, Banner } from '../render/parts.tsx';
import { phoneRenderers } from '../render/phone.tsx';
import { Composer } from './Composer.tsx';
import { PermissionSheet, OutputSheet, MenuSheet } from './Sheets.tsx';
import { toolDisplayName, blobUrl } from '../tools.ts';
import { Back, Dots } from '../icons.tsx';
import { haptic } from '../haptics.ts';
import { showPushNotification } from '../notify.ts';
import { useT } from '../i18n/react.ts';

export function ChatView({ session, sock, connection, onBack, registerEvent, registerHistory }: {
  session: SessionView;
  sock: ControlSocket;
  connection: Connection;
  onBack: () => void;
  registerEvent: (cb: (sid: string, p: any) => void) => void;
  registerHistory: (cb: (sid: string, events: any[]) => void) => void;
}) {
  const t = useT();
  const {
    state, busy, offline, actions, send, stop, answerPermission, output, setOutput, permissionId, announce, meta,
  } = useSession({ session, sock, connection, registerEvent, registerHistory });
  const { scrollRef, pinned, onScroll, toBottom } = useTranscriptScroll([state.items, state.live.busy]);
  const [menu, setMenu] = useState(false);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  // The header floats over the transcript (so the transcript can use the full screen, status-bar
  // strip included), which means the transcript's top padding has to equal the header's height —
  // and the connection banner makes that height change at runtime. Measured, not hard-coded.
  // Phone-only: no other layout puts the header on top of the scroller.
  useEffect(() => {
    const head = headerRef.current;
    const screen = screenRef.current;
    if (!head || !screen) return;
    const apply = () => screen.style.setProperty('--header-h', `${head.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(head);
    return () => ro.disconnect();
  }, []);

  // The one haptic worth firing unprompted (0c: notification haptic). A desktop has nothing to
  // fire, which is why this lives here and not in the hook.
  useEffect(() => { if (permissionId) haptic('warning'); }, [permissionId]);

  return (
    <div className="screen" ref={screenRef}>
      {/* Two layers, deliberately siblings: .header-frost blurs whatever scrolls beneath (so the
          strip behind the status bar / Dynamic Island is used instead of reserved) and .header
          sits above it with an explicit z-index, so the title can never be caught by the blur. */}
      <div className="header-frost" aria-hidden />
      <div className="header" ref={headerRef}>
        <div className="topbar">
          <button className="icon-btn" aria-label={t({ k: 'a11y.back' })} onClick={onBack}><Back size={18} /></button>
          <div className="topbar-title">
            <div className="t1 ellipsis">{t({ k: 'chat.rcSession' })}</div>
            <div className="t2 ellipsis">{session.machine || state.live.cwd || session.dir || t({ k: 'chat.session' })}</div>
          </div>
          {/* data-testid: ui-shot opens this menu, and there is a SECOND aria-label="More" on the
              composer's + button — matching on the label alone only worked by document order. */}
          <button className="icon-btn" data-testid="session-menu" aria-label={t({ k: 'a11y.more' })} onClick={() => setMenu(true)}><Dots size={18} /></button>
        </div>

        <Banner connection={connection} sessionOffline={session.status !== 'active'} machine={session.machine} onRetry={() => sock.reconnect()} />
      </div>

      <div
        className="scroll chat"
        ref={scrollRef}
        onScroll={onScroll}
      >
        {state.items.map((it, i) => (
          <ItemView key={it.id} it={it} isLast={i === state.items.length - 1} h={actions} renderers={phoneRenderers} />
        ))}
      </div>

      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

      {/* Above the composer, not at the tail of the transcript: pinned there it stays on screen
          while you scroll back through the turn, and it no longer shifts the last card down every
          time the agent picks up a tool. Offline, nothing is running here to report — a spinner
          would just keep promising work that no connected claude is doing. */}
      {busy && !offline && (
        <ActivityLine running={state.live.running} thinking={state.live.thinking} tokens={state.live.thinkingTokens} compacting={state.live.compacting} />
      )}

      <Composer
        busy={busy}
        offline={offline}
        slashCommands={state.live.slashCommands}
        skills={state.live.skills}
        onSend={send}
        onStop={stop}
        showToBottom={!pinned}
        onToBottom={toBottom}
      />

      {state.live.permission && (
        <PermissionSheet
          req={state.live.permission}
          cwd={state.live.cwd || session.dir}
          onAnswer={answerPermission}
          // Drag-to-dismiss is a deny-later, never an allow (0c).
          onDismiss={() => answerPermission({ behavior: 'deny', message: 'The user dismissed the request on their phone.' })}
        />
      )}
      {output && <OutputSheet call={output} onDismiss={() => setOutput(null)} />}
      {menu && (
        <MenuSheet
          meta={meta || t({ k: 'chat.session' })}
          mode={state.live.permissionMode}
          onMode={(m) => sock.control(session.id, 'set_permission_mode', { mode: m })}
          onEnd={stop}
          onDismiss={() => setMenu(false)}
        />
      )}
    </div>
  );
}
