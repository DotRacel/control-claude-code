/**
 * desktop.tsx — the desktop's renderers and modal surfaces.
 *
 * Most item kinds look the same on both platforms: a status line, a divider, an error card and a
 * todo list have no touch affordance to lose and no extra room to use. Those are inherited by
 * name (see `inherit` in contract.ts — an explicit list rather than a spread, so adding a kind
 * still fails to compile here until someone decides about it).
 *
 * What genuinely differs is pointer input. The phone's tool row hand-rolls
 * touchstart/long-press/scroll-slop because iOS does not reliably cancel a touch that turned into
 * a scroll; with a mouse none of that exists and all of it is in the way — a click opens the
 * output, and hover says the row is clickable before you commit to it.
 */
import type { ToolCall } from '../model.ts';
import {
  inherit, type ItemActions, type ItemRenderers, type LiveSurfaces, enterClass,
} from './contract.ts';
import { phoneRenderers } from './phone.tsx';
import { ToolRowBody, ImageStrip, toolRowLabel } from './parts.tsx';
import { Modal, Popover } from '../components/desktop/Modal.tsx';
import { PermissionBody, OutputBody, MenuBody, HelpBody, ConfirmBody } from './surface-parts.tsx';
import { useT } from '../i18n/react.ts';

export const desktopRenderers: ItemRenderers = {
  // Reviewed one by one: on a wider screen these read the same as they do on a phone.
  ...inherit(phoneRenderers, [
    'user', 'prose', 'thinking', 'todo', 'question',
    'bgtask', 'status', 'divider', 'error', 'unknown',
  ]),
  tools: ({ it, isLast, h }) => <DesktopToolGroup calls={it.calls} cls={enterClass(isLast)} h={h} />,
};

function DesktopToolGroup({ calls, cls, h }: { calls: ToolCall[]; cls?: string; h: ItemActions }) {
  const bad = calls.some((c) => c.status === 'error');
  const waiting = calls.some((c) => c.status === 'awaiting');
  return (
    <div className={`tool-group${bad ? ' err' : ''}${waiting ? ' await' : ''} ${cls ?? ''}`}>
      {calls.map((c) => (
        <div key={c.toolUseId}>
          <DesktopToolRow call={c} onOpen={h.onOpenOutput} />
          {c.images && c.images.length > 0 && <ImageStrip images={c.images} h={h} />}
        </div>
      ))}
    </div>
  );
}

/** A plain button. No long-press to discover, no slop to measure, no haptic to fire. */
function DesktopToolRow({ call, onOpen }: { call: ToolCall; onOpen: (c: ToolCall) => void }) {
  const openable = !!call.result;
  return (
    <button
      className="tool-row hoverable"
      onClick={() => openable && onOpen(call)}
      disabled={!openable}
      aria-label={toolRowLabel(call, openable, { k: 'a11y.openOutputDesktop' })}
    >
      <ToolRowBody call={call} />
    </button>
  );
}

/**
 * Four centred modals and one popover, where the phone has five bottom sheets. The contents are
 * literally the same components (render/surface-parts.tsx); only the container and its dismiss
 * gesture change.
 *
 * `onDismiss` still means DENY for a permission — Modal wires backdrop clicks and Escape to the
 * same callback the phone's drag-to-dismiss uses, so no route out of the dialog can leave the
 * worker waiting on an answer that never comes.
 */
export const desktopSurfaces: LiveSurfaces = {
  // Block bodies rather than the concise arrows these used to be: each is a component in its own
  // right, so each gets to call the hook and re-render when the language changes.
  permission: ({ req, cwd, onAnswer, onDismiss }) => {
    const t = useT();
    return (
      <Modal onDismiss={onDismiss} label={t({ k: 'perm.modalTitle' })} width={520}>
        <PermissionBody req={req} cwd={cwd} onAnswer={onAnswer} />
      </Modal>
    );
  },
  output: ({ call, onDismiss }) => {
    const t = useT();
    return (
      <Modal onDismiss={onDismiss} label={t({ k: 'output.modalTitle' })} width={900} tall>
        <OutputBody call={call} />
      </Modal>
    );
  },
  menu: ({ meta, mode, onMode, onEnd, onDismiss }) => {
    const t = useT();
    return (
      <Popover onDismiss={onDismiss} label={t({ k: 'menu.modalTitle' })}>
        <MenuBody meta={meta} mode={mode} onMode={onMode} onEnd={onEnd} onDismiss={onDismiss} />
      </Popover>
    );
  },
  help: ({ onDismiss }) => {
    const t = useT();
    return (
      <Modal onDismiss={onDismiss} label={t({ k: 'help.modalTitle' })} width={480}>
        <HelpBody />
      </Modal>
    );
  },
  confirm: ({ title, body, confirmLabel, onConfirm, onDismiss }) => (
    <Modal onDismiss={onDismiss} label={title} width={420}>
      <ConfirmBody title={title} body={body} confirmLabel={confirmLabel} onConfirm={onConfirm} onDismiss={onDismiss} />
    </Modal>
  ),
};
