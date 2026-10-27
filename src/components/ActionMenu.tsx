import { focusMovedOutside } from './focusBoundary';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { MenuPopup, type MenuItem } from './MenuBar';

/** Share the menu bar's keyboard behavior, including within native modal dialogs. */
export default function ActionMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const focus = useRef<'first' | 'last'>('first');
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        id={`${id}-trigger`}
        className="secondary-button icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          focus.current = 'first';
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            focus.current = event.key === 'ArrowUp' ? 'last' : 'first';
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            onBlur={(event) => {
              if (
                focusMovedOutside(event.currentTarget, event.relatedTarget) &&
                event.relatedTarget !== trigger.current
              )
                setOpen(false);
            }}
          >
            <MenuPopup
              id={id}
              items={items}
              anchor={trigger.current}
              focus={focus.current}
              onClose={close}
              onFinish={close}
            />
          </div>,
          trigger.current?.closest('dialog') ?? document.body,
        )}
    </>
  );
}
