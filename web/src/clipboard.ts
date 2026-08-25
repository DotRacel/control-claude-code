/**
 * clipboard.ts — copying text from a page that is not a secure context.
 *
 * The controller serves plain HTTP on a LAN address (src/server/index.ts), so on the phone
 * `navigator.clipboard` is simply absent: `window.isSecureContext` is false and the whole API is
 * undefined. Reading `.writeText` off it throws, which is why the copy buttons used to do nothing
 * at all. The fallback is the pre-Clipboard-API path — a hidden node holding the text, selected,
 * then `document.execCommand('copy')` — which still works everywhere over HTTP.
 *
 * iOS Safari will not select a `readonly` textarea via `select()`, so the fallback selects a
 * contenteditable node with a Range instead; that is the one shape both iOS and desktop honour.
 */
import { useEffect, useRef, useState } from 'react';
import { haptic } from './haptics.ts';
import { useT } from './i18n/react.ts';

/** Copies `text`, returning whether it landed. Never throws. */
export async function copyText(text: string): Promise<boolean> {
  // Secure context (https, or localhost during development): the real API.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied, or a browser that rejects the call outside a user gesture it
      // recognises. Fall through — execCommand sometimes still succeeds.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const el = document.createElement('div');
  el.textContent = text;
  // Off-screen but still rendered: `display:none` or `visibility:hidden` cannot be selected.
  // `contenteditable` is what makes the Range selectable on iOS.
  el.contentEditable = 'true';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;' +
    'pointer-events:none;white-space:pre;overflow:hidden;-webkit-user-select:text;user-select:text';
  document.body.appendChild(el);

  const selection = window.getSelection();
  const saved = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  let ok = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    selection?.removeAllRanges();
    // Put the user's own selection back — copying should not clear what they had highlighted.
    if (saved) selection?.addRange(saved);
    el.remove();
  }
  return ok;
}

/**
 * The state behind every copy button: label, and the handler. A failure says so rather than
 * looking like a no-op — when both paths are blocked the only honest answer is to tell the user,
 * so they select the text by hand instead of tapping a dead button.
 */
export function useCopy(text: string): { label: string; failed: boolean; copy: () => void } {
  const t = useT();
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    void copyText(text).then((ok) => {
      if (ok) haptic('light');
      setState(ok ? 'done' : 'fail');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), ok ? 1500 : 2200);
    });
  };

  return {
    label: t({ k: state === 'done' ? 'copy.copied' : state === 'fail' ? 'copy.failed' : 'copy.copy' }),
    failed: state === 'fail',
    copy,
  };
}
