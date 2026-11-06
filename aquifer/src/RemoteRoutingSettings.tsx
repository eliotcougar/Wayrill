import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Plus, Search, Trash2 } from 'lucide-react';
import { cloneJson, jsonArray, jsonRecord, jsonText } from './graph/xrayJson';
import { detectedProtocols, routingConditionFields } from './graph/rules';
import { get, setProperty } from './nativeProperties';
import {
  conditionKey,
  malformedRules,
  ruleList,
  ruleTarget,
  type RouteDestination,
  type Settings,
} from './routingEditor';
import ListInput from './ListInput';
import MapInput from './MapInput';
import ExpandedListField from './ExpandedListField';
import { OrderedEntries, moveEntry } from '@wayrill/ui/OrderedEntries';
import RemoteRoutingOutputs from './RemoteRoutingOutputs';
import { destinationKey, type RoutingOutput } from './routingOutputs';
export type { RouteDestination } from './routingEditor';

export default function RemoteRoutingSettings({
  value,
  destinations,
  onChange,
  selectedRule,
  onSelectRule,
  focusPath,
  tab = 'Rules',
  outputs = [],
  onOutputsChange = () => {},
}: {
  value: Settings;
  destinations: RouteDestination[];
  onChange: (value: Settings) => void;
  selectedRule?: number;
  onSelectRule?: (index: number) => void;
  focusPath?: string;
  tab?: string;
  outputs?: RoutingOutput[];
  onOutputsChange?: (outputs: RoutingOutput[]) => void;
}) {
  const [localSelected, setLocalSelected] = useState(0),
    [query, setQuery] = useState('');
  const [identities] = useState(() => new WeakMap<Settings, string>());
  const identity = (rule: Settings) => {
    let id = identities.get(rule);
    if (!id) {
      id = crypto.randomUUID();
      identities.set(rule, id);
    }
    return id;
  };
  useEffect(() => {
    if (focusPath) setQuery('');
  }, [focusPath]);
  const rules = ruleList(value);
  const matches = rules
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => JSON.stringify(entry).toLowerCase().includes(query.toLowerCase()));
  const preferred = Math.min(selectedRule ?? localSelected, Math.max(0, rules.length - 1));
  const selected = matches.some(({ index }) => index === preferred)
    ? preferred
    : (matches[0]?.index ?? -1);
  const setSelected = (index: number) => {
    setLocalSelected(index);
    onSelectRule?.(index);
  };
  const rule = rules[selected];
  const update = (next: Settings[]) => onChange(setProperty(value, 'rules', next));
  const change = (next: Settings) => {
    identities.set(next, identity(rule));
    setQuery('');
    setSelected(selected);
    update(rules.map((entry, index) => (index === selected ? next : entry)));
  };
  const move = (offset: number) => {
    const to = selected + offset;
    if (!rule || to < 0 || to >= rules.length) return;
    const next = [...rules];
    [next[selected], next[to]] = [next[to], next[selected]];
    update(next);
    setSelected(to);
    setQuery('');
  };
  const reorder = (id: string, to: number) => {
    const from = rules.findIndex((rule) => identity(rule) === id);
    const destination = matches[to]?.index;
    if (destination === undefined || from === destination) return;
    update(moveEntry(rules, from, destination));
    setSelected(destination);
    setQuery('');
  };
  const add = (entry?: Settings) => {
    const first =
      outputs.find((output) => output.fallback) ??
      outputs[0] ??
      destinations.find((item) => !item.hidden);
    if (!entry && !first) return;
    const index = rule ? selected + 1 : rules.length;
    const next = [...rules];
    next.splice(
      index,
      0,
      entry
        ? cloneJson(entry)
        : { type: 'field', [first.group ? 'balancerTag' : 'outboundTag']: first.tag },
    );
    update(next);
    setSelected(index);
    setQuery('');
  };
  const writeCondition = (key: string, next: unknown) => {
    if (!rule) return;
    let updated = setProperty(rule, conditionKey(rule, key), next);
    if (next === undefined)
      for (const alias of key === 'domain'
        ? ['domain', 'domains']
        : key === 'sourceIP'
          ? ['sourceIP', 'source']
          : [key])
        updated = setProperty(updated, alias, undefined);
    change(updated);
  };
  const renderCondition = (field: (typeof routingConditionFields)[number]) => {
    const entry = rule[conditionKey(rule, field.key)];
    const path = `rules.${selected}.${field.key}`;
    if (field.key === 'network' || field.key === 'protocol') {
      const items = jsonArray(entry)
        ? entry.map(jsonText)
        : typeof entry === 'string'
          ? entry.split(',').map((item) => item.trim())
          : [];
      const choices =
        field.key === 'network'
          ? [
              { value: 'tcp', label: 'TCP' },
              { value: 'udp', label: 'UDP' },
            ]
          : detectedProtocols;
      const values = [
        ...choices,
        ...items
          .filter((item) => !choices.some(({ value }) => value === item))
          .map((value) => ({ value, label: value })),
      ];
      return (
        <fieldset className="server-protocol-options" key={field.key} data-setting-path={path}>
          <legend>
            {field.label} <span className="muted">(none selected = any)</span>
          </legend>
          {values.map(({ value, label }) => (
            <label key={value} className="check-control check-control--compact">
              <input
                type="checkbox"
                checked={items.includes(value)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...items, value]
                    : items.filter((item) => item !== value);
                  writeCondition(
                    field.key,
                    next.length ? (field.key === 'network' ? next.join(',') : next) : undefined,
                  );
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
      );
    }
    if (field.key === 'domain' || field.key === 'ip')
      return (
        <div className="editor-field" key={field.key} data-setting-path={path}>
          <ExpandedListField
            key={selected}
            id={path}
            label={field.label}
            value={entry}
            placeholder={field.hint}
            onChange={(next) => writeCondition(field.key, next)}
          />
        </div>
      );
    return (
      <label className="editor-field" key={field.key} data-setting-path={path}>
        {field.label}
        {field.list ? (
          <ListInput
            aria-label={field.label}
            value={entry}
            trim
            placeholder={
              field.key === 'process' ? 'Linux executable names, paths or folders' : field.hint
            }
            onChange={(next) => writeCondition(field.key, next)}
          />
        ) : (
          <input
            className="text-control"
            aria-label={field.label}
            value={jsonText(entry ?? '')}
            placeholder={field.hint}
            onChange={(event) => writeCondition(field.key, event.target.value || undefined)}
          />
        )}
      </label>
    );
  };
  const target = rule ? ruleTarget(rule) : undefined;
  const advanced = routingConditionFields.filter(
    ({ key }) => !['domain', 'ip', 'port', 'network', 'protocol', 'attrs'].includes(key),
  );
  if (malformedRules(value))
    return (
      <p role="alert" className="user-error">
        Rules contain an unsupported value. Use Edit JSON to correct it before editing rules.
      </p>
    );
  if (tab === 'Outputs')
    return (
      <RemoteRoutingOutputs
        value={value}
        outputs={outputs}
        destinations={destinations}
        onChange={onChange}
        onOutputsChange={onOutputsChange}
      />
    );
  return (
    <div className="remote-routing-editor">
      <div className="remote-rule-sidebar">
        <label className="search-control">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Find routing rules"
            placeholder="Find rules"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="remote-rule-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Add rule"
            disabled={!destinations.length}
            onClick={() => add()}
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Duplicate rule"
            disabled={!rule}
            onClick={() => add(rule)}
          >
            <Copy size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Move rule up"
            disabled={!rule || selected === 0}
            onClick={() => move(-1)}
          >
            <ArrowUp size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Move rule down"
            disabled={!rule || selected >= rules.length - 1}
            onClick={() => move(1)}
          >
            <ArrowDown size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Remove rule"
            disabled={!rule}
            onClick={() => {
              update(rules.filter((_, index) => index !== selected));
              setSelected(Math.max(0, Math.min(selected, rules.length - 2)));
              setQuery('');
            }}
          >
            <Trash2 size={16} />
          </button>
        </div>
        <OrderedEntries
          entries={matches.map(({ entry, index }) => ({
            id: identity(entry),
            position: index + 1,
            name: jsonText(get(entry, 'ruleTag') || `Rule ${index + 1}`),
            enabled: true,
            summary: '',
            destination:
              outputs.find((output) => destinationKey(output) === destinationKey(ruleTarget(entry)))
                ?.name ?? ruleTarget(entry).tag,
          }))}
          selected={rule ? identity(rule) : null}
          onSelect={(id) => setSelected(rules.findIndex((rule) => identity(rule) === id))}
          onMove={reorder}
          label="Routing rules"
          empty={rules.length ? 'No matching rules' : 'No routing rules'}
          compact
        />
        <details className="editor-advanced remote-routing-fallback">
          <summary>Unmatched traffic</summary>
          <p>{outputs.find((output) => output.fallback)?.name ?? 'First outbound'}</p>
        </details>
      </div>
      {rule && target && (
        <div className="remote-rule-fields">
          <div className="field-grid server-fields-grid">
            <label className="editor-field" data-setting-path={`rules.${selected}.destination`}>
              Output
              <select
                className="text-control"
                aria-label="Rule destination"
                value={JSON.stringify([target.group, target.tag])}
                onChange={(event) => {
                  const [group, tag] = JSON.parse(event.target.value) as [boolean, string];
                  change(
                    setProperty(
                      setProperty(
                        setProperty(rule, 'outboundTag', undefined),
                        'balancerTag',
                        undefined,
                      ),
                      group ? 'balancerTag' : 'outboundTag',
                      tag,
                    ),
                  );
                }}
              >
                {!destinations.some(
                  (item) => item.tag === target.tag && item.group === target.group,
                ) && (
                  <option value={JSON.stringify([target.group, target.tag])}>
                    Unavailable: {target.tag || 'no destination'}
                  </option>
                )}
                {destinations
                  .filter((item) => !item.hidden || item.tag === target.tag)
                  .map(({ tag, group, internal }) => (
                    <option key={JSON.stringify([group, tag])} value={JSON.stringify([group, tag])}>
                      {outputs.find(
                        (output) => destinationKey(output) === destinationKey({ tag, group }),
                      )?.name ?? tag}
                      {group ? ' · Policy group' : internal ? ' · Internal' : ''}
                    </option>
                  ))}
              </select>
            </label>
            <label className="editor-field">
              Rule name
              <input
                className="text-control"
                aria-label="Rule name"
                value={jsonText(get(rule, 'ruleTag') ?? '')}
                onChange={(event) =>
                  change(setProperty(rule, 'ruleTag', event.target.value || undefined))
                }
              />
            </label>
          </div>
          <div data-setting-path={`rules.${selected}.conditions`}>
            {routingConditionFields
              .filter(({ key }) => ['domain', 'ip', 'port', 'network', 'protocol'].includes(key))
              .map(renderCondition)}
          </div>
          <details className="editor-advanced server-advanced" key={selected}>
            <summary>
              Source & advanced conditions
              {advanced.some(({ key }) => rule[conditionKey(rule, key)] !== undefined) ||
              get(rule, 'attrs') !== undefined
                ? ' · Configured'
                : ''}
            </summary>
            {advanced.map(renderCondition)}
            <div className="server-field">
              <span className="server-field-label">HTTP attributes</span>
              <MapInput
                value={get(rule, 'attrs')}
                lists={false}
                label="HTTP attributes"
                onChange={(next) =>
                  writeCondition(
                    'attrs',
                    jsonRecord(next) && Object.keys(next).length ? next : undefined,
                  )
                }
              />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
