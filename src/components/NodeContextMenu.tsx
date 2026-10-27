import { focusMovedOutside } from './focusBoundary';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MenuPopup, type MenuItem } from './MenuBar';

export default function NodeContextMenu({
  x,
  y,
  label,
  items,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  onClose: (restoreFocus?: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const dismissed = useRef(false);
  const id = useId();
  const dismiss = (restoreFocus?: boolean) => {
    if (dismissed.current) return;
    dismissed.current = true;
    close.current(restoreFocus);
  };
  useEffect(() => {
    dismissed.current = false;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) dismiss();
    };
    const dismissWindow = () => dismiss(true);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismissWindow);
    window.addEventListener('blur', dismissWindow);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismissWindow);
      window.removeEventListener('blur', dismissWindow);
    };
  }, []);
  return createPortal(
    <div
      ref={root}
      onContextMenu={(event) => event.preventDefault()}
      onBlur={(event) => {
        if (focusMovedOutside(event.currentTarget, event.relatedTarget)) dismiss();
      }}
    >
      <MenuPopup
        id={id}
        items={items}
        anchor={null}
        position={{ x, y }}
        label={`Actions for ${label}`}
        className="node-context-menu"
        focus="first"
        onClose={() => dismiss(true)}
        onFinish={() => dismiss(true)}
      />
    </div>,
    document.body,
  );
}
