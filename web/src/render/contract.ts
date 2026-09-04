/**
 * contract.ts — the rule that every `Item` kind must have a renderer, expressed as a type.
 *
 * The reducer's `Item` union (web/src/model.ts) is a closed set, but nothing used to hold the view
 * layer to it: `ItemView` was a `switch` whose return type is inferred, so a missing `case` fell
 * through to `undefined` — which is a legal ReactNode. A new kind therefore compiled, passed every
 * test, and rendered nothing. That is not hypothetical: `divider` shipped that way, reducer and CSS
 * and all, and a disconnected session simply showed no break where one belonged.
 *
 * `ItemRenderers` is a mapped type over `Item['kind']`, so a missing key is a compile error at the
 * place that claims to render items. There is one implementation today (render/phone.tsx). When a
 * desktop layout arrives it is a second object of the same type — and adding a kind then fails to
 * compile in BOTH files at once, which is the whole point: no platform can quietly fall behind.
 *
 * What deliberately is NOT here: how anything looks. A phone opens a tool's output in a bottom
 * sheet after a long-press; a desktop would use a side panel and a hover affordance. Those are
 * real differences and they belong in the per-platform file. Only the SET of items, and the
 * actions the shell offers, are shared.
 */
import type { ComponentType } from 'react';
import type { Item, ToolCall, PermissionRequest } from '../model.ts';
import type { PermissionAnswer } from '../ws.ts';
import type { ImageAttachment } from '../../../src/image-blob.ts';

/**
 * What a renderer can ask the shell to do. Actions and resolvers only — never "open this sheet",
 * because a sheet is a phone answer to "show me the output" and the desktop's answer differs.
 */
export interface ItemActions {
  /** Show a tool call's raw output, however this platform shows things. */
  onOpenOutput: (call: ToolCall) => void;
  onAnswerQuestion: (item: Extract<Item, { kind: 'question' }>, answers: Record<string, string>, freeform?: string) => void;
  /**
   * Answer an ExitPlanMode ask. Three verdicts rather than allow/deny, because that is what the
   * terminal offers and what the worker acts on differently: `approve` starts the work in
   * whatever mode preceded plan; `approve-accept-edits` rides the same allow but carries a
   * `setMode` permission update, so file edits stop asking; `reject` is a deny whose `message` is
   * the feedback the model revises against (verified — it comes back to the model verbatim as
   * "the user said: …" and it keeps planning).
   */
  onAnswerPlan: (item: Extract<Item, { kind: 'plan' }>, verdict: 'approve' | 'approve-accept-edits' | 'reject', feedback?: string) => void;
  /**
   * Where to load a tool's image from — injected because only the view knows the session id, and
   * because it keeps the components free of the base64-vs-reference distinction. Returns
   * undefined when an attachment cannot be resolved at all.
   */
  imageUrl: (att: ImageAttachment) => string | undefined;
}

/** Props every item renderer receives, narrowed to its own kind. */
export interface ItemProps<K extends Item['kind']> {
  it: Extract<Item, { kind: K }>;
  /** Only the newest item animates in; earlier ones must not re-animate on re-render (0c). */
  isLast: boolean;
  h: ItemActions;
}

/**
 * One renderer per kind. Mapped over `Item['kind']`, so this is the type that fails to compile
 * when the reducer learns to produce something the view cannot draw.
 */
export type ItemRenderers = { [K in Item['kind']]: ComponentType<ItemProps<K>> };

/** The animation class, shared by every renderer so the rule lives in one place. */
export const enterClass = (isLast: boolean): string | undefined => (isLast ? 'enter' : undefined);

/**
 * Take these kinds from another platform's renderers, as an explicit list.
 *
 * Spreading a whole `ItemRenderers` into a new one — `{...phoneRenderers, tools: X}` — would
 * silently defeat the check this whole file exists for: the spread supplies every key, so adding a
 * kind to `Item` compiles clean again and the second platform is back to failing invisibly.
 *
 * The return type is `Pick<ItemRenderers, K>`, so the object literal is still settled key by key:
 * a new kind is in neither the inherit list nor the overrides, and the assignment fails. The list
 * also says something worth saying — "I looked at these and the other platform's version is right
 * here too" — which a bare spread does not.
 */
export function inherit<K extends Item['kind']>(from: ItemRenderers, keys: readonly K[]): Pick<ItemRenderers, K> {
  const out = {} as Pick<ItemRenderers, K>;
  for (const k of keys) out[k] = from[k];
  return out;
}

/**
 * The modal surfaces — the half of the UI that `ItemRenderers` cannot reach.
 *
 * These are driven by `live` (a pending permission, a tool output someone asked to see) and by the
 * session list, not by transcript items, so nothing forced a second platform to implement them.
 * That gap matters more than a missing item renderer, not less: a permission surface that fails to
 * appear leaves the worker blocked on an answer that is never coming, with no sign on screen.
 *
 * A phone answers all five with a bottom sheet; a desktop answers four with a centred modal and
 * one with a popover. That difference is the point — only the SET is shared.
 */
export type LiveSurfaces = {
  permission: ComponentType<{
    req: PermissionRequest;
    cwd?: string;
    onAnswer: (a: PermissionAnswer) => void;
    /**
     * Dismissing is a DENY, never an allow, and never a silent close (0c). Whatever the platform's
     * dismiss gesture is — a drag, a backdrop click, Escape — it has to answer, or the worker
     * waits forever.
     */
    onDismiss: () => void;
  }>;
  output: ComponentType<{ call: ToolCall; onDismiss: () => void }>;
  menu: ComponentType<{
    meta: string;
    mode?: string;
    onMode: (m: string) => void;
    onEnd: () => void;
    onDismiss: () => void;
  }>;
  help: ComponentType<{ onDismiss: () => void }>;
  confirm: ComponentType<{
    title: string;
    body: string;
    confirmLabel: string;
    onConfirm: () => void;
    onDismiss: () => void;
  }>;
};
