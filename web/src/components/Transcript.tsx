/**
 * Transcript.tsx — one item, drawn by whichever platform's renderers were handed in.
 *
 * All this does is dispatch: `it.kind` picks a component out of an `ItemRenderers` map
 * (render/contract.ts), and the map is what the type system checks for completeness. The per-kind
 * markup lives in render/phone.tsx; a desktop layout would be a second map, and the day a new item
 * kind appears, both fail to compile until each decides how to draw it.
 *
 * It used to be a `switch` here, which is why this file exists at all: a switch over a union has an
 * inferred return type, `undefined` is a valid ReactNode, and so a missing case rendered nothing
 * and compiled clean.
 */
import { memo } from 'react';
import type { Item } from '../model.ts';
import type { ItemActions, ItemProps, ItemRenderers } from '../render/contract.ts';
import { useLocale } from '../i18n/react.ts';

export type { ItemActions, ItemRenderers } from '../render/contract.ts';

export const ItemView = memo(function ItemView({ it, isLast, h, renderers }: {
  it: Item;
  isLast: boolean;
  h: ItemActions;
  renderers: ItemRenderers;
}) {
  // THIS is the memo boundary for the whole transcript, and a locale change does not touch any of
  // the four props above — so without a subscription right here, switching language would leave
  // every item already on screen in the old one while the chrome around it changed. Reading the
  // store subscribes this component, which is the one thing `memo` cannot block.
  //
  // It also buys the renderers below it their freedom: everything under this point re-renders when
  // this does, so render/phone.tsx and render/desktop.tsx can call the bare module `t` instead of
  // threading a hook through eight presentational components.
  useLocale();
  // The map is exhaustive by construction, but its value type is a union of per-kind components
  // once indexed by a union key, and TypeScript cannot see that this `it` matches this component.
  // The cast is confined to this one line, which is the trade for having the check happen where it
  // belongs — in the renderers object, not here.
  const Render = renderers[it.kind] as React.ComponentType<ItemProps<typeof it.kind>>;
  return <Render it={it as never} isLast={isLast} h={h} />;
});
