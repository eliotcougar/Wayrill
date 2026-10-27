import { focusMovedOutside } from './focusBoundary';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
  action?: () => void;
  separator?: boolean;
  items?: MenuItem[];
}
export interface Menu {
  label: string;
  items: MenuItem[];
}

export function MenuPopup({
  items,
  id,
  anchor,
  nested = false,
  position,
  label,
  className = '',
  focus,
  onClose,
  onFinish,
}: {
  items: MenuItem[];
  id: string;
  anchor: HTMLButtonElement | null;
  nested?: boolean;
  position?: { x: number; y: number };
  label?: string;
  className?: string;
  focus: 'first' | 'last' | null;
  onClose: () => void;
  onFinish: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const triggers = useRef<(HTMLButtonElement | null)[]>([]);
  const [child, setChild] = useState<number | null>(null);
  const childFocus = useRef<'first' | 'last' | null>(null);
  const search = useRef({ text: '', time: 0 });
  const x = position?.x;
  const y = position?.y;
  useLayoutEffect(() => {
    const menu = root.current;
    if (!menu || (!anchor && (x === undefined || y === undefined))) return;
    const fit = () => {
      const rect = anchor?.getBoundingClientRect() ?? {
        left: x!,
        right: x!,
        top: y!,
        bottom: y!,
      };
      const box = menu.getBoundingClientRect();
      const bounds = anchor?.closest('dialog')?.getBoundingClientRect();
      const minLeft = (bounds?.left ?? 0) + 8;
      const maxRight = (bounds?.right ?? window.innerWidth) - 8;
      const minTop = (bounds?.top ?? 0) + 8;
      const maxBottom = (bounds?.bottom ?? window.innerHeight) - 8;
      let left = nested ? rect.right - 2 : rect.left;
      if (nested && left + box.width > maxRight) left = rect.left - box.width + 2;
      left = Math.max(minLeft, Math.min(left, maxRight - box.width));
      const top = Math.max(
        minTop,
        Math.min(nested ? rect.top - 6 : rect.bottom - 1, maxBottom - box.height),
      );
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu.style.maxHeight = `${Math.max(60, maxBottom - top)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('scroll', fit, true);
    if (focus) {
      const buttons = menu.querySelectorAll<HTMLButtonElement>(
        ':scope > .menu-items > .menu-row > button',
      );
      buttons[focus === 'first' ? 0 : buttons.length - 1]?.focus();
    }
    return () => {
      window.removeEventListener('resize', fit);
      window.removeEventListener('scroll', fit, true);
    };
  }, [anchor, focus, nested, x, y]);
  const openChild = (index: number, position: 'first' | 'last' | null) => {
    childFocus.current = position;
    if (child === index && position) {
      const buttons = root.current?.querySelectorAll<HTMLButtonElement>(
        `#${CSS.escape(`${id}-child-${index}`)} > .menu-items > .menu-row > button`,
      );
      buttons?.[position === 'first' ? 0 : buttons.length - 1]?.focus();
    } else setChild(index);
  };
  return (
    <div
      ref={root}
      id={id}
      role="menu"
      className={`menu-dropdown ${className}`}
      aria-label={label}
      aria-labelledby={anchor?.id}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        event.stopPropagation();
        if (event.key === 'Escape' || (nested && event.key === 'ArrowLeft')) {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key === 'Tab') {
          onFinish();
          return;
        }
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            ':scope > .menu-items > .menu-row > button',
          ),
        ];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0 || !buttons.length) return;
        const itemIndex = Number(buttons[index].dataset.index);
        if (items[itemIndex]?.items && ['ArrowRight', 'Enter', ' '].includes(event.key)) {
          event.preventDefault();
          if (!items[itemIndex].disabled) openChild(itemIndex, 'first');
          return;
        }
        let next: number;
        switch (event.key) {
          case 'ArrowDown':
            next = (index + 1) % buttons.length;
            break;
          case 'ArrowUp':
            next = (index + buttons.length - 1) % buttons.length;
            break;
          case 'Home':
            next = 0;
            break;
          case 'End':
            next = buttons.length - 1;
            break;
          default: {
            if (event.key.length !== 1 || event.key === ' ') return;
            const letter = event.key.toLocaleLowerCase();
            const previous = Date.now() - search.current.time < 500 ? search.current.text : '';
            const text =
              previous && [...previous].every((c) => c === letter) ? letter : previous + letter;
            search.current = { text, time: Date.now() };
            next = -1;
            for (let offset = 1; offset <= buttons.length; offset++) {
              const candidate = (index + offset) % buttons.length;
              if (buttons[candidate].dataset.label?.toLocaleLowerCase().startsWith(text)) {
                next = candidate;
                break;
              }
            }
          }
        }
        event.preventDefault();
        buttons[next]?.focus();
      }}
    >
      <div className="menu-items">
        {items.map((item, index) =>
          item.separator ? (
            <div role="separator" className="menu-separator" key={index} />
          ) : (
            <div
              className="menu-row"
              key={item.label}
              onMouseEnter={() => {
                if (child !== null && child !== index) {
                  const previous = document.getElementById(`${id}-child-${child}`);
                  if (previous?.contains(document.activeElement)) triggers.current[index]?.focus();
                }
                if (item.items && !item.disabled) openChild(index, null);
                else setChild(null);
              }}
            >
              <button
                ref={(element) => {
                  triggers.current[index] = element;
                }}
                id={`${id}-item-${index}`}
                role="menuitem"
                aria-disabled={item.disabled || undefined}
                data-destructive={item.destructive || undefined}
                tabIndex={-1}
                data-label={item.label}
                data-index={index}
                aria-haspopup={item.items ? 'menu' : undefined}
                aria-expanded={item.items ? child === index : undefined}
                aria-controls={child === index ? `${id}-child-${index}` : undefined}
                onFocus={() => {
                  if (child !== index) setChild(null);
                }}
                onClick={() => {
                  if (item.disabled) return;
                  if (item.items) {
                    openChild(index, 'first');
                    return;
                  }
                  onFinish();
                  item.action?.();
                }}
              >
                <span className="menu-item-label">
                  {item.icon && (
                    <span className="menu-item-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                  )}
                  {item.label}
                </span>
                {item.items ? (
                  <ChevronRight size={14} aria-hidden="true" />
                ) : (
                  item.shortcut && <kbd>{item.shortcut}</kbd>
                )}
              </button>
              {child === index && item.items && (
                <MenuPopup
                  items={item.items}
                  id={`${id}-child-${index}`}
                  anchor={triggers.current[index]}
                  nested
                  focus={childFocus.current}
                  onClose={() => {
                    triggers.current[index]?.focus();
                    setChild(null);
                  }}
                  onFinish={onFinish}
                />
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export default function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const triggers = useRef<(HTMLButtonElement | null)[]>([]);
  const focus = useRef<'first' | 'last' | null>(null);
  const show = (index: number, position: 'first' | 'last' = 'first') => {
    focus.current = position;
    setOpen(index);
  };
  const close = (restore = false) => {
    if (restore && open !== null) triggers.current[open]?.focus();
    setOpen(null);
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return (
    <nav
      className="menu-bar"
      aria-label="Main menu"
      ref={root}
      onBlur={(event) => {
        if (focusMovedOutside(event.currentTarget, event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if (open !== null && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span>Wayrill</span>
      </div>
      <div className="menus">
        {menus.map((menu, index) => (
          <div
            className="menu"
            key={menu.label}
            onMouseEnter={() => {
              if (open !== null && open !== index) {
                const previous = root.current?.querySelector('[role="menu"]');
                focus.current = previous?.contains(document.activeElement) ? 'first' : null;
                setOpen(index);
              }
            }}
          >
            <button
              ref={(element) => {
                triggers.current[index] = element;
              }}
              id={`${id}-trigger-${index}`}
              className={`menu-trigger${open === index ? ' is-open' : ''}`}
              aria-haspopup="menu"
              aria-controls={open === index ? `${id}-menu-${index}` : undefined}
              aria-expanded={open === index}
              onClick={() => (open === index ? close(true) : show(index))}
              onKeyDown={(event) => {
                if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  show(index, event.key === 'ArrowUp' ? 'last' : 'first');
                }
              }}
            >
              {menu.label}
            </button>
            {open === index && (
              <MenuPopup
                key={index}
                items={menu.items}
                id={`${id}-menu-${index}`}
                anchor={triggers.current[index]}
                focus={focus.current}
                onClose={() => close(true)}
                onFinish={() => close(true)}
              />
            )}
          </div>
        ))}
      </div>
    </nav>
  );
}
