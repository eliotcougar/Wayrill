import { useContext, useEffect, useRef, type RefObject } from 'react';
import { DiagnosticFocusContext, focusDiagnostic } from './DiagnosticNavigation';

/** Native showModal supplies trapping; unmounting it needs explicit focus restoration. */
export default function useModalDialog(ref: RefObject<HTMLDialogElement | null>) {
  const opener = useRef<HTMLElement | null>(null);
  const request = useContext(DiagnosticFocusContext);
  const returnFocus = request?.returnFocus;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) {
      opener.current =
        returnFocus ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      dialog.showModal();
    }
    return () => {
      // Strict Mode replays effects while the same open dialog is still connected.
      // Removing the element already releases its native top layer; do not emit close again.
      if (dialog.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !dialog.contains(active)) return;
      const target = opener.current;
      if (!target?.isConnected || target.matches(':disabled') || target.closest('[inert]')) return;
      // A newly opened modal may own focus instead of this dialog's opener.
      if ([...document.querySelectorAll('dialog[open]')].some((other) => !other.contains(target)))
        return;
      target.focus({ preventScroll: true });
    };
  }, [ref, returnFocus]);
  useEffect(() => {
    if (request && request.surface !== 'inspector' && ref.current)
      focusDiagnostic(ref.current, request.issue);
  }, [ref, request]);
}
