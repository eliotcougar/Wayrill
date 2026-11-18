import {
  createContext,
  useContext,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  type AriaAttributes,
} from 'react';
import { graphTagChoices, type TagReferenceKind } from '../graph/tagReferences';
import type { GraphState } from '../graph/types';
import { searchText } from '../text';
import ResultPager from './ResultPager';

export const TagGraphContext = createContext<{ graph: GraphState; ownerId?: string } | undefined>(
  undefined,
);

/** Select by display name while retaining native references, including imported prefixes. */
export default function TagReferencePicker({
  id,
  label,
  kind,
  value,
  onChange,
  graph: suppliedGraph,
  multiple = false,
  prefixes = false,
  ...accessibility
}: {
  id: string;
  label: string;
  kind: TagReferenceKind;
  value: string;
  onChange: (value: string) => void;
  graph?: GraphState;
  multiple?: boolean;
  prefixes?: boolean;
} & Pick<AriaAttributes, 'aria-invalid' | 'aria-describedby'>) {
  const context = useContext(TagGraphContext),
    graph = suppliedGraph ?? context?.graph;
  const toggle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [page, setPage] = useState(0);
  const collapse = () => {
    setOpen(false);
    toggle.current?.focus({ preventScroll: true });
  };
  const term = useDeferredValue(searchText(query));
  const pending = term !== searchText(query);
  const excludeId = suppliedGraph ? undefined : context?.ownerId;
  const choices = useMemo(
    () => (graph ? graphTagChoices(graph, kind, excludeId) : []),
    [graph, kind, excludeId],
  );
  const byTag = useMemo(() => new Map(choices.map((choice) => [choice.tag, choice])), [choices]);
  const ambiguousNames = useMemo(() => {
    const seen = new Set<string>(),
      duplicates = new Set<string>();
    for (const choice of choices) {
      if (seen.has(choice.name)) duplicates.add(choice.name);
      else seen.add(choice.name);
    }
    return duplicates;
  }, [choices]);
  const selected = useMemo(
    () =>
      multiple
        ? value
            .split(/\r?\n/)
            .map((v) => v.trim())
            .filter(Boolean)
        : value
          ? [value]
          : [],
    [multiple, value],
  );
  const selectedInfo = useMemo(
    () =>
      selected.map((tag) => {
        const exact = byTag.get(tag);
        const display = (choice: (typeof choices)[number]) =>
          choice.name +
          ((!multiple || ambiguousNames.has(choice.name)) && choice.detail !== choice.name
            ? ' · ' + choice.detail
            : '');
        if (exact && !prefixes) return { name: display(exact), native: false };
        const matching = prefixes ? choices.filter((c) => c.tag.startsWith(tag)) : [];
        return {
          name: matching.length
            ? matching.slice(0, 3).map(display).join(', ') +
              (matching.length > 3 ? ` (+${matching.length - 3} more)` : '')
            : `External reference: ${tag}`,
          native: !exact || matching.length > 1,
        };
      }),
    [selected, byTag, prefixes, choices, multiple, ambiguousNames],
  );
  const names = selectedInfo.map((info) => info.name);
  const matches = useMemo(
    () =>
      open
        ? choices.filter((c) => searchText(`${c.name} ${c.detail} ${c.tag}`).includes(term))
        : [],
    [choices, open, term],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / 30) - 1));
  const selectedMatches = selected
    .map((tag, index) => ({ tag, index }))
    .filter(
      ({ tag, index }) =>
        selectedInfo[index].native &&
        (!term ||
          searchText(names[index] + ' ' + tag).includes(term) ||
          (prefixes && matches.some((choice) => choice.tag.startsWith(tag)))),
    );
  return (
    <div
      className="tag-reference"
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          collapse();
        }
      }}
    >
      <button
        {...accessibility}
        ref={toggle}
        type="button"
        id={id}
        className="secondary-button tag-reference-toggle"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={names.slice(0, 8).join(', ')}
      >
        {names.length
          ? names.length > 3
            ? `${names.length} selected`
            : names.join(', ')
          : multiple
            ? kind === 'inbound'
              ? 'Any source'
              : 'No destinations selected'
            : 'None'}
      </button>
      {open && (
        <div className="editor-panel tag-reference-panel" aria-busy={pending}>
          <label className="editor-field">
            <span>Search {label.toLowerCase()}</span>
            <input
              autoComplete="off"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <button
            type="button"
            className="secondary-button button--small"
            onClick={() => {
              onChange('');
              if (!multiple) collapse();
            }}
          >
            {multiple ? 'Clear selection' : 'None'}
          </button>
          {multiple && selectedMatches.length > 0 && (
            <div className="tag-reference-list" aria-label="Selected references">
              {selectedMatches.slice(0, 30).map(({ tag, index }) => (
                <button
                  key={tag + index}
                  type="button"
                  className="secondary-button tag-reference-toggle"
                  title={names[index]}
                  aria-label={`Remove ${names[index]}`}
                  onClick={() => onChange(selected.filter((_, i) => i !== index).join('\n'))}
                >
                  {names[index]} ×
                </button>
              ))}
              {selectedMatches.length > 30 && (
                <small>
                  {selectedMatches.length} selected · use search to change individual destinations
                </small>
              )}
            </div>
          )}
          <div className="tag-reference-list" role="group" aria-label={`${label} choices`}>
            {matches.slice(currentPage * 30, (currentPage + 1) * 30).map((choice) => {
              const explicit = selected.includes(choice.tag);
              const inherited =
                !explicit && prefixes && selected.some((tag) => choice.tag.startsWith(tag));
              return (
                <label className="tag-reference-choice" key={choice.tag}>
                  <input
                    type={multiple ? 'checkbox' : 'radio'}
                    name={id}
                    checked={explicit || inherited}
                    disabled={inherited || pending}
                    onChange={() => {
                      onChange(
                        multiple
                          ? (selected.includes(choice.tag)
                              ? selected.filter((t) => t !== choice.tag)
                              : [...selected, choice.tag]
                            ).join('\n')
                          : choice.tag,
                      );
                      if (!multiple) collapse();
                    }}
                  />
                  <span>
                    <strong dir="auto">{choice.name}</strong>
                    <small>
                      {choice.detail}
                      {inherited ? ' · Included by a native prefix' : ''}
                    </small>
                  </span>
                </label>
              );
            })}
            {!matches.length && (
              <p className="field-help">
                {kind === 'inbound' &&
                !choices.length &&
                graph?.nodes.some((node) => node.data.kind === 'inbound-placeholder')
                  ? 'Pool placeholders are assigned on the client. Connect them to separate filters to distinguish their traffic.'
                  : `No matching ${kind === 'inbound' ? 'sources' : 'outbounds'}.`}
              </p>
            )}
          </div>
          <ResultPager
            compact
            label={label}
            count={matches.length}
            size={30}
            page={currentPage}
            onPage={setPage}
          />
          <details className="settings-section">
            <summary>
              {prefixes ? 'Native prefix expressions' : 'External or native references'}
            </summary>
            <div className="settings-section-body">
              <p className="field-help">
                For imported configurations and destinations outside this graph. Existing references
                are preserved.
              </p>
              <label className="editor-field">
                <span>{prefixes ? 'Tag prefixes' : 'Native references'}</span>
                <textarea
                  rows={multiple ? 3 : 1}
                  spellCheck={false}
                  value={value}
                  onChange={(e) => onChange(e.target.value)}
                />
              </label>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
