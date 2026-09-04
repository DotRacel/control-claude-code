/**
 * DesktopChat.tsx — one session in the right-hand pane.
 *
 * Everything about how the session *works* comes from `useSession` (web/src/session.ts), the same
 * hook the phone's ChatView uses, so there is no second copy of subscribing, backfilling, sending
 * or answering to drift. What this file decides is desktop-shaped:
 *
 *  - the header is a plain bar, not a floating frosted layer: there is no status bar to share the
 *    strip with, and nothing to blur behind
 *  - no back button — the session list never went away
 *  - the transcript is capped at a readable measure and centred; a 1440px-wide line of serif prose
 *    is not prose anyone reads
 *  - surfaces are modals and a popover (render/desktop.tsx), and dismissing the permission one
 *    still answers DENY
 */
import { useState } from 'react';
import type { ControlSocket, SessionView, Connection } from '../../ws.ts';
import { useSession, useTranscriptScroll } from '../../session.ts';
import { ItemView } from '../Transcript.tsx';
import { ActivityLine, Banner, ModeChip } from '../../render/parts.tsx';
import { desktopRenderers, desktopSurfaces } from '../../render/desktop.tsx';
import { Composer } from '../Composer.tsx';
import { Dots } from '../../icons.tsx';
import { useT } from '../../i18n/react.ts';

export function DesktopChat({ session, sock, connection, registerEvent, registerHistory }: {
  session: SessionView;
  sock: ControlSocket;
  connection: Connection;
  registerEvent: (cb: (sid: string, p: any) => void) => void;
  registerHistory: (cb: (sid: string, events: any[]) => void) => void;
}) {
  const t = useT();
  const {
    state, busy, offline, actions, send, stop, answerPermission, output, setOutput, announce, meta,
  } = useSession({ session, sock, connection, registerEvent, registerHistory });
  const { scrollRef, pinned, onScroll, toBottom } = useTranscriptScroll([state.items, state.live.busy]);
  const [menu, setMenu] = useState(false);

  const Permission = desktopSurfaces.permission;
  const Output = desktopSurfaces.output;
  const Menu = desktopSurfaces.menu;

  return (
    <section className="dchat">
      <header className="dchat-head">
        <div className="dchat-title">
          <div className="t1 ellipsis">{session.machine || state.live.cwd || session.dir || t({ k: 'chat.session' })}</div>
          <div className="t2 ellipsis">{meta || t({ k: 'chat.rcSession' })}</div>
        </div>
        <div className="dchat-head-actions">
          <button className="icon-btn" data-testid="session-menu" aria-label={t({ k: 'a11y.more' })} onClick={() => setMenu(true)}><Dots size={17} /></button>
          {/* The popover anchors to this corner, so it is rendered inside it. */}
          {menu && (
            <Menu
              meta={meta || t({ k: 'chat.session' })}
              mode={state.live.permissionMode}
              onMode={(m) => sock.control(session.id, 'set_permission_mode', { mode: m })}
              onEnd={stop}
              onDismiss={() => setMenu(false)}
            />
          )}
        </div>
      </header>

      <Banner
        connection={connection}
        sessionOffline={session.status !== 'active'}
        machine={session.machine}
        onRetry={() => sock.reconnect()}
      />

      {/* Deliberately NOT wrapped in a measure element: the readable cap is CSS on the children,
          so the transcript keeps the same DOM shape as the phone's — `.chat > *` is what the
          stylesheet's flex rules and test/ui-shot's geometry probe both key on. */}
      <div className="scroll chat dchat-scroll" ref={scrollRef} onScroll={onScroll}>
        {state.items.map((it, i) => (
          <ItemView
            key={it.id}
            it={it}
            isLast={i === state.items.length - 1}
            h={actions}
            renderers={desktopRenderers}
          />
        ))}
      </div>

      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

      <div className="dchat-composer">
        {/* Inside the composer block, so it inherits the same measure and the same left edge as
            the field below it. Offline, nothing is running here to report — a spinner would just
            keep promising work that no connected claude is doing. */}
        {busy && !offline && (
          <ActivityLine running={state.live.running} thinking={state.live.thinking} tokens={state.live.thinkingTokens} compacting={state.live.compacting} />
        )}
        {/* Standing state, so unlike the activity line it is not gated on `busy`. */}
        <ModeChip mode={state.live.permissionMode} />
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
      </div>

      {state.live.permission && (
        <Permission
          req={state.live.permission}
          cwd={state.live.cwd || session.dir}
          onAnswer={answerPermission}
          // Backdrop click and Escape land here, and here answers DENY — the same rule the phone's
          // drag-to-dismiss follows (0c). A dialog that merely closed would hang the worker.
          onDismiss={() => answerPermission({ behavior: 'deny', message: 'The user dismissed the request.' })}
        />
      )}
      {output && <Output call={output} onDismiss={() => setOutput(null)} />}
    </section>
  );
}
