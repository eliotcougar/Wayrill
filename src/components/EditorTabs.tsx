import { useEffect, useId, useState, type ReactNode } from 'react';

interface EditorTab<K extends string> {
  key: K;
  label: ReactNode;
}

export function useEditorTabs<K extends string>(
  items: readonly EditorTab<K>[],
  selected: K,
  onSelect: (key: K) => void,
) {
  return { id: useId(), items, selected, onSelect };
}

type Tabs<K extends string> = ReturnType<typeof useEditorTabs<K>>;

/** Manual activation keeps arrow-key exploration from compiling costly previews. */
export function EditorTabs<K extends string>({
  tabs,
  label,
  disabled = false,
  children,
}: {
  tabs: Tabs<K>;
  label: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const { id, items, selected, onSelect } = tabs;
  const [focused, setFocused] = useState(selected);
  useEffect(() => setFocused(selected), [selected]);
  const focusKey = items.some((item) => item.key === focused) ? focused : selected;
  return (
    <div className="rule-editor-tabs">
      <div
        className="editor-tab-list"
        role="tablist"
        aria-label={label}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(selected);
        }}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
          ];
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          let next: number;
          switch (event.key) {
            case 'ArrowLeft':
              next = (index + buttons.length - 1) % buttons.length;
              break;
            case 'ArrowRight':
              next = (index + 1) % buttons.length;
              break;
            case 'Home':
              next = 0;
              break;
            case 'End':
              next = buttons.length - 1;
              break;
            default:
              return;
          }
          event.preventDefault();
          event.stopPropagation();
          buttons[next]?.focus();
        }}
      >
        {items.map(({ key, label: title }) => (
          <button
            key={key}
            id={`${id}-tab-${key}`}
            role="tab"
            aria-selected={selected === key}
            aria-controls={`${id}-panel-${key}`}
            aria-disabled={disabled || undefined}
            tabIndex={focusKey === key ? 0 : -1}
            onFocus={(event) => {
              setFocused(key);
              event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }}
            onClick={() => {
              if (!disabled) onSelect(key);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                if (!disabled) onSelect(key);
              }
            }}
          >
            {title}
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

/** Render functions retain visited sections and their unfinished drafts; previews remain lazy. */
export function EditorTabPanels<K extends string>({
  tabs,
  className,
  children,
  inert = false,
}: {
  tabs: Tabs<K>;
  className: string | ((key: K) => string);
  children: ReactNode | ((key: K) => ReactNode);
  inert?: boolean;
}) {
  const [visited, setVisited] = useState<K[]>([tabs.selected]);
  useEffect(() => {
    setVisited((current) =>
      current.includes(tabs.selected) ? current : [...current, tabs.selected],
    );
  }, [tabs.selected]);
  return tabs.items.map(({ key }) => (
    <div
      key={key}
      id={`${tabs.id}-panel-${key}`}
      role="tabpanel"
      inert={inert || undefined}
      aria-labelledby={`${tabs.id}-tab-${key}`}
      hidden={key !== tabs.selected}
      tabIndex={0}
      className={`${typeof className === 'function' ? className(key) : className} editor-tab-panel`}
    >
      {typeof children === 'function'
        ? key === tabs.selected || visited.includes(key)
          ? children(key)
          : null
        : key === tabs.selected
          ? children
          : null}
    </div>
  ));
}

/** Independently rendered panes keep their field drafts mounted when hidden. */
export function EditorTabPanel<K extends string>({
  tabs,
  tab,
  className,
  children,
}: {
  tabs: Tabs<K>;
  tab: K;
  className: string;
  children: ReactNode;
}) {
  if (!tabs.items.some((item) => item.key === tab)) return null;
  return (
    <div
      id={`${tabs.id}-panel-${tab}`}
      role="tabpanel"
      aria-labelledby={`${tabs.id}-tab-${tab}`}
      hidden={tab !== tabs.selected}
      tabIndex={0}
      className={`${className} editor-tab-panel`}
    >
      {children}
    </div>
  );
}
