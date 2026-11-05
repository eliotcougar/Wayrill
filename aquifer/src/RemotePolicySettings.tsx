import { useState, type ReactNode } from 'react';
import { jsonArray, jsonText } from './graph/xrayJson';
import { get, objectAt, setProperty } from './nativeProperties';
import type { RouteDestination, Settings } from './routingEditor';
import ListInput from './ListInput';
import { fieldsIssues, settingsStructures } from './settingsFields';

export function policyCandidates(value: Settings, destinations: RouteDestination[]) {
  const selectors = get(value, 'selector');
  const prefixes = jsonArray(selectors)
    ? selectors.map(jsonText)
    : typeof selectors === 'string'
      ? [selectors]
      : [];
  return destinations.filter(
    (item) =>
      !item.group && !item.internal && prefixes.some((prefix) => item.tag.startsWith(prefix)),
  );
}
export function policyIssues(value: Settings, destinations: RouteDestination[]) {
  const issues: { path: string; message: string; tab: string }[] = [];
  const add = (path: string, message: string) => issues.push({ path, message, tab: 'Group' });
  const tag = get(value, 'tag');
  if (typeof tag !== 'string' || !tag.trim()) add('tag', 'Enter a policy group tag.');
  const selector = get(value, 'selector');
  if (
    typeof selector !== 'string' &&
    !(
      jsonArray(selector) &&
      selector.length &&
      selector.every((value) => typeof value === 'string')
    )
  )
    add('selector', 'Add at least one outbound tag prefix.');
  const fallback = get(value, 'fallbackTag');
  if (
    fallback &&
    !destinations.some((item) => !item.group && !item.internal && item.tag === fallback)
  )
    add('fallbackTag', 'Choose an available fallback outbound.');
  const strategy = objectAt(value, 'strategy');
  if (String(get(strategy, 'type')).toLowerCase() === 'leastload')
    issues.push(
      ...fieldsIssues(
        objectAt(strategy, 'settings'),
        settingsStructures.strategyLeastLoadConfig,
        'Group',
        'strategy.settings.',
      ),
    );
  return issues;
}
export default function RemotePolicySettings({
  value,
  destinations,
  onChange,
  tuning,
}: {
  value: Settings;
  destinations: RouteDestination[];
  onChange: (value: Settings) => void;
  tuning: (value: Settings, onChange: (value: Settings) => void) => ReactNode;
}) {
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(0);
  const strategy = objectAt(value, 'strategy'),
    type = jsonText(get(strategy, 'type') ?? '').toLowerCase();
  const selector = get(value, 'selector');
  const all = selector === '' || (jsonArray(selector) && selector.includes(''));
  const matches = policyCandidates(value, destinations),
    filtered = matches.filter((item) => item.tag.toLowerCase().includes(query.toLowerCase()));
  const active = Math.min(page, Math.max(0, Math.ceil(filtered.length / 100) - 1));
  const options = destinations.filter((item) => !item.group && !item.internal),
    fallback = jsonText(get(value, 'fallbackTag') ?? '');
  return (
    <div className="server-inbound-editor">
      <div className="field-grid server-fields-grid">
        <label className="editor-field" data-setting-path="tag">
          Group tag
          <input
            className="text-control"
            aria-label="Group tag"
            value={jsonText(get(value, 'tag') ?? '')}
            onChange={(event) =>
              onChange(setProperty(value, 'tag', event.target.value || undefined))
            }
          />
        </label>
        <label className="editor-field">
          Selection strategy
          <select
            className="text-control"
            aria-label="Selection strategy"
            value={type}
            onChange={(event) =>
              onChange(
                setProperty(
                  value,
                  'strategy',
                  setProperty(strategy, 'type', event.target.value || undefined),
                ),
              )
            }
          >
            <option value="">Random (default)</option>
            {[
              ...new Set([
                'random',
                'roundrobin',
                'leastping',
                'leastload',
                ...(type ? [type] : []),
              ]),
            ].map((name) => (
              <option key={name} value={name}>
                {(
                  {
                    random: 'Random',
                    roundrobin: 'Round robin',
                    leastping: 'Least ping',
                    leastload: 'Least load',
                  } as Record<string, string>
                )[name] ?? name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="editor-field">
        Candidate selection
        <select
          className="text-control"
          aria-label="Candidate selection"
          value={all ? 'all' : 'prefixes'}
          onChange={(event) =>
            onChange(setProperty(value, 'selector', event.target.value === 'all' ? [''] : []))
          }
        >
          <option value="prefixes">Outbound tag prefixes</option>
          <option value="all">All outbounds</option>
        </select>
      </label>
      {!all && (
        <label className="editor-field" data-setting-path="selector">
          Outbound tag prefixes
          <ListInput
            aria-label="Outbound tag prefixes"
            value={get(value, 'selector')}
            trim
            onChange={(next) => onChange(setProperty(value, 'selector', next))}
          />
          <span className="field-help">
            Each prefix matches outbound tags starting with it. Matching is case-sensitive.
          </span>
        </label>
      )}
      <section className="editor-panel policy-preview">
        <header>
          <strong>
            {matches.length} matching {matches.length === 1 ? 'outbound' : 'outbounds'}
          </strong>
          <input
            className="text-control"
            aria-label="Find matching outbounds"
            placeholder="Find in matches"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </header>
        <ul>
          {filtered.slice(active * 100, (active + 1) * 100).map(({ tag }) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
        {!filtered.length && (
          <p className="field-help">
            {matches.length ? 'No matching outbounds.' : 'No outbounds match these prefixes.'}
          </p>
        )}
        {filtered.length > 100 && (
          <div className="user-pagination">
            <button
              className="secondary-button"
              type="button"
              disabled={!active}
              onClick={() => setPage(active - 1)}
            >
              Previous
            </button>
            <span>
              {active + 1} / {Math.ceil(filtered.length / 100)}
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={(active + 1) * 100 >= filtered.length}
              onClick={() => setPage(active + 1)}
            >
              Next
            </button>
          </div>
        )}
      </section>
      {(type === 'leastping' || type === 'leastload') && (
        <p className="field-help">
          Uses the server’s observatory results. Configure observation on the Observatory node.
        </p>
      )}
      <label className="editor-field" data-setting-path="fallbackTag">
        Fallback outbound
        <select
          className="text-control"
          aria-label="Fallback outbound"
          value={fallback}
          onChange={(event) =>
            onChange(setProperty(value, 'fallbackTag', event.target.value || undefined))
          }
        >
          <option value="">No explicit fallback</option>
          {fallback && !options.some(({ tag }) => tag === fallback) && (
            <option value={fallback}>Unavailable: {fallback}</option>
          )}
          {options.map(({ tag }) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
      </label>
      {type === 'leastload' && (
        <details className="editor-advanced server-advanced">
          <summary>Least-load tuning</summary>
          {tuning(objectAt(strategy, 'settings'), (next) =>
            onChange(setProperty(value, 'strategy', setProperty(strategy, 'settings', next))),
          )}
        </details>
      )}
    </div>
  );
}
