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
  const id = useId();
  return {
    id,
    items,
    selected,
    onSelect,
    tabId: (key: K) => `${id}-tab-${encodeURIComponent(key)}`,
    panelId: (key: K) => `${id}-panel-${encodeURIComponent(key)}`,
  };
}

type Tabs<K extends string> = ReturnType<typeof useEditorTabs<K>>;

/** Manual activation keeps arrow-key exploration from compiling costly previews. */
export function EditorTabList<K extends string>({
  tabs,
  label,
  disabled = false,
  className = 'editor-tab-list',
  panelId,
}: {
  tabs: Tabs<K>;
  label: string;
  disabled?: boolean;
  className?: string;
  /** One live panel may serve all tabs instead of keeping one panel per tab. */
  panelId?: string;
}) {
  const { items, selected, onSelect } = tabs;
  const [focused, setFocused] = useState(selected);
  useEffect(() => setFocused(selected), [selected]);
  const focusKey = items.some((item) => item.key === focused) ? focused : selected;
  return (
    <div
      className={className}
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
          type="button"
          key={key}
          id={tabs.tabId(key)}
          role="tab"
          aria-selected={selected === key}
          aria-controls={panelId ?? tabs.panelId(key)}
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
  );
}

export function EditorTabs<K extends string>({
  children,
  ...props
}: {
  tabs: Tabs<K>;
  label: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="rule-editor-tabs">
      <EditorTabList {...props} />
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
      id={tabs.panelId(key)}
      role="tabpanel"
      inert={inert || undefined}
      aria-labelledby={tabs.tabId(key)}
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
      id={tabs.panelId(tab)}
      role="tabpanel"
      aria-labelledby={tabs.tabId(tab)}
      hidden={tab !== tabs.selected}
      tabIndex={0}
      className={`${className} editor-tab-panel`}
    >
      {children}
    </div>
  );
}
