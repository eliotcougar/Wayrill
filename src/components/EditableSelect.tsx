import { focusMovedOutside } from './focusBoundary';
import { Check, ChevronDown } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from 'react';

/** An editable value with a full-width, unfiltered preset list. */
export default function EditableSelect({
  options,
  label,
  value,
  onChange,
  ...inputProps
}: Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'list'> & {
  options: readonly string[];
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const field = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(-1);
  useLayoutEffect(() => {
    const popup = menu.current;
    if (!popup || !open) return;
    if (inputProps.disabled || !options.length) {
      setOpen(false);
      return;
    }
    const position = () => {
      if (!field.current) return;
      const box = field.current.getBoundingClientRect();
      const width = Math.min(box.width, Math.max(0, window.innerWidth - 16));
      const below = Math.max(0, window.innerHeight - box.bottom - 12),
        above = Math.max(0, box.top - 12);
      const upward = below < 120 && above > below;
      const height = Math.min(288, options.length * 32 + 10, upward ? above : below);
      Object.assign(popup.style, {
        left: `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`,
        top: `${upward ? box.top - height - 4 : box.bottom + 4}px`,
        width: `${width}px`,
        maxHeight: `${height}px`,
      });
    };
    position();
    popup.showPopover();
    input.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !field.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    document.addEventListener('pointerdown', dismiss, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      document.removeEventListener('pointerdown', dismiss, true);
      if (popup.isConnected) popup.hidePopover();
    };
  }, [open, options.length, inputProps.disabled]);
  useEffect(() => {
    if (open && active >= 0) menu.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);
  const show = (last = false) => {
    const selected = options.indexOf(value);
    setActive(selected >= 0 ? selected : last ? options.length - 1 : 0);
    setOpen(true);
  };
  const choose = (option: string) => {
    if (inputProps.disabled) return;
    onChange(option);
    setOpen(false);
    input.current?.focus({ preventScroll: true });
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (open && (event.key === 'Escape' || event.key === 'Tab')) {
      setOpen(false);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
    } else if (inputProps.disabled || !options.length) return;
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const previous = event.key === 'ArrowUp';
      if (!open) show(previous);
      else
        setActive((index) =>
          index < 0
            ? previous
              ? options.length - 1
              : 0
            : (index + (previous ? options.length - 1 : 1)) % options.length,
        );
    } else if (open && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (options[active] !== undefined) choose(options[active]);
      else setOpen(false);
    }
  };
  return (
    <div
      className="editable-select"
      ref={field}
      onKeyDown={keyDown}
      onBlur={(event) => {
        if (focusMovedOutside(event.currentTarget, event.relatedTarget)) setOpen(false);
      }}
    >
      <input
        {...inputProps}
        ref={input}
        role="combobox"
        aria-label={inputProps['aria-label'] ?? label}
        aria-autocomplete="none"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={
          open && options[active] !== undefined ? `${menuId}-${active}` : undefined
        }
        autoComplete="off"
        value={value}
        onChange={(event) => {
          setActive(-1);
          onChange(event.target.value);
        }}
      />
      <button
        type="button"
        className="editable-select-toggle"
        tabIndex={-1}
        aria-label={`Presets for ${label}`}
        title={`Presets for ${label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={inputProps.disabled || !options.length}
        onClick={() => {
          if (open) {
            setOpen(false);
            input.current?.focus();
          } else show();
        }}
      >
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <div
        ref={menu}
        id={menuId}
        className="popover-surface editable-select-options"
        role="listbox"
        aria-label={`Presets for ${label}`}
        popover="manual"
      >
        {options.map((option, index) => (
          <div
            key={option}
            id={`${menuId}-${index}`}
            role="option"
            aria-selected={active === index}
            className={active === index ? 'active' : undefined}
            title={option}
            onPointerMove={() => setActive(index)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => choose(option)}
          >
            <Check
              size={14}
              aria-hidden="true"
              style={{ visibility: option === value ? 'visible' : 'hidden' }}
            />
            <span>{option}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
