import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Dialog from './Dialog';
import {
  domainEntryProblem,
  type CompanionRuleRequest,
  type DomainAddition,
} from '../companionRules';
import { readRuleTable } from '../graph/rules';
import { readResources } from '../graph/resources';
import { geoSources, type GeoGroup, type GeoPage } from '../geodata';
import { errorText, serviceCall } from '../serviceClient';
import type { GraphState } from '../graph/types';
import './CompanionRuleDialog.css';

type MatchGroup = GeoGroup & { matchedBy?: string };
export default function CompanionRuleDialog({
  request,
  graph,
  blocked,
  onAdd,
  onClose,
}: {
  request: CompanionRuleRequest;
  graph: GraphState;
  blocked: boolean;
  onAdd: (addition: DomainAddition) => void;
  onClose: () => void;
}) {
  const filters = graph.nodes.filter((node) => node.data.kind === 'routing-filter');
  const [filterId, setFilter] = useState(
    () =>
      request.filterIds.find((id) => filters.some((node) => node.id === id)) ??
      (filters.length === 1 ? filters[0].id : ''),
  );
  const filter = filters.find((node) => node.id === filterId);
  const table = filter ? readRuleTable(filter.data.settings) : null;
  const [ruleId, setRule] = useState('');
  const [name, setName] = useState(request.host.slice(0, 128));
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState('full');
  const [entry, setEntry] = useState(`full:${request.host}`);
  const [error, setError] = useState('');
  const [added, setAdded] = useState(false);
  const sources = useMemo(
    () => geoSources(readResources(graph.defaults), 'geosite'),
    [graph.defaults],
  );
  const [file, setFile] = useState(sources[0]?.file ?? '');
  const source = sources.find((source) => source.file === file);
  const [lookup, setLookup] = useState<{ file: string; offset: number; attempt: number } | null>(
    null,
  );
  const lookupKey = JSON.stringify(lookup);
  const [result, setResult] = useState<{ key: string; page?: GeoPage; error?: string }>({
    key: '',
  });
  useEffect(() => {
    if (!lookup) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const page = await serviceCall<GeoPage>('resources.browse', {
          file: lookup.file,
          kind: 'geosite',
          domain: request.host,
          offset: lookup.offset,
          limit: 100,
        });
        if (!active) return;
        if (!page.ready) {
          timer = setTimeout(() => void read(), 250);
          return;
        }
        setResult({ key: lookupKey, page });
      } catch (failure) {
        if (!active) return;
        if (
          failure &&
          typeof failure === 'object' &&
          'code' in failure &&
          ['BUSY', 'RESOURCE_CHANGED'].includes(String(failure.code))
        ) {
          timer = setTimeout(() => void read(), 350);
          return;
        }
        setResult({ key: lookupKey, error: errorText(failure) });
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [lookup, lookupKey, request.host]);
  const page = result.key === lookupKey ? result.page : undefined;
  const groups = (page?.rows ?? []) as MatchGroup[];
  const [group, setGroup] = useState('');
  const selectedGroup = groups.find((row) => row.code === group);
  const newRule = ruleId === '__new_rule__';
  const selectedRule = table?.rules.find((rule) => rule.id === ruleId);
  const problem = domainEntryProblem(entry);
  const canAdd =
    !!filter &&
    (newRule
      ? !!table?.outputs.some((row) => row.id === output)
      : !!selectedRule && !selectedRule.matchAll) &&
    !problem &&
    !added &&
    !blocked;
  const add = () => {
    if (!canAdd) return;
    try {
      onAdd({ filterId, ruleId, entry, ...(newRule ? { newRule: { name, output } } : {}) });
      setAdded(true);
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const chooseMode = (value: string) => {
    setMode(value);
    setGroup('');
    if (value !== 'custom')
      setEntry(value === 'contains' ? request.host : `${value}:${request.host}`);
  };
  return (
    <Dialog
      title="Add domain to rule"
      className="companion-rule-dialog"
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={!canAdd} onClick={add}>
            Add to draft
          </button>
        </>
      }
    >
      <div className="companion-rule-fields">
        <label className="editor-field">
          <span>Traffic filter</span>
          <select
            value={filterId}
            onChange={(event) => {
              setFilter(event.target.value);
              setRule('');
              setOutput('');
              setError('');
            }}
          >
            <option value="">
              {filters.length ? 'Choose a filter' : 'Add a traffic filter to the graph first'}
            </option>
            {filters.map((node) => (
              <option key={node.id} value={node.id}>
                {node.data.label}
              </option>
            ))}
          </select>
        </label>
        <label className="editor-field">
          <span>Rule</span>
          <select
            disabled={!table}
            value={ruleId}
            onChange={(event) => {
              setRule(event.target.value);
              setError('');
            }}
          >
            <option value="">Choose a rule</option>
            <option value="__new_rule__">New rule…</option>
            {table?.rules.map((rule) => (
              <option key={rule.id} value={rule.id} disabled={rule.matchAll}>
                {rule.name || 'Unnamed rule'}
                {rule.enabled ? '' : ' (disabled)'} ·{' '}
                {table.outputs.find((output) => output.id === rule.output)?.name ??
                  'Missing output'}
              </option>
            ))}
          </select>
        </label>
        {newRule && (
          <div className="companion-new-rule">
            <label className="editor-field">
              <span>Name</span>
              <input
                value={name}
                maxLength={128}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="editor-field">
              <span>Output</span>
              <select value={output} onChange={(event) => setOutput(event.target.value)}>
                <option value="">Choose an output</option>
                {table?.outputs.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <label className="editor-field">
          <span>Entry type</span>
          <select value={mode} onChange={(event) => chooseMode(event.target.value)}>
            <option value="full">full:{request.host} — exact</option>
            <option value="domain">domain:{request.host} — domain and subdomains</option>
            <option value="contains">{request.host} — contains</option>
            <option value="custom">Custom</option>
            {mode === 'geosite' && <option value="geosite">GeoSite group</option>}
          </select>
        </label>
        <label className="editor-field">
          <span>Entry</span>
          <input
            value={entry}
            maxLength={4096}
            onChange={(event) => {
              setEntry(event.target.value);
              setMode('custom');
              setError('');
            }}
          />
        </label>
        {problem && (
          <p className="notice error" role="alert">
            {problem}
          </p>
        )}
        <details>
          <summary>Find matching GeoSite groups</summary>
          <div className="companion-geo-lookup">
            <div className="companion-geo-source">
              <label className="editor-field">
                <span>Resource file</span>
                <select
                  value={file}
                  onChange={(event) => {
                    setFile(event.target.value);
                    setLookup(null);
                    setGroup('');
                    if (mode === 'geosite') chooseMode('full');
                  }}
                >
                  {sources.map((row) => (
                    <option key={row.file} value={row.file}>
                      {row.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="secondary-button"
                disabled={!source || (!!lookup && result.key !== lookupKey)}
                onClick={() => {
                  setGroup('');
                  setLookup({ file, offset: 0, attempt: (lookup?.attempt ?? 0) + 1 });
                }}
              >
                Find groups
              </button>
            </div>
            {lookup && !page && result.key !== lookupKey && (
              <p role="status">Finding matching groups…</p>
            )}
            {result.key === lookupKey && result.error && (
              <p role="alert" className="notice error">
                {result.error}
              </p>
            )}
            {page && (
              <>
                <label className="editor-field">
                  <span>Matching groups</span>
                  <select
                    value={group}
                    onChange={(event) => {
                      const code = event.target.value;
                      setGroup(code);
                      if (code && source) {
                        setMode('geosite');
                        setEntry(`${source.prefix}${code}`);
                        setError('');
                      }
                    }}
                  >
                    <option value="">{page.total ? 'Choose a group' : 'No matching groups'}</option>
                    {groups.map((row) => (
                      <option key={row.code} value={row.code}>
                        {row.code} · {row.count.toLocaleString()} entries
                      </option>
                    ))}
                  </select>
                </label>
                {selectedGroup && mode === 'geosite' && (
                  <p className="companion-rule-hint">
                    Matched by {selectedGroup.matchedBy}. Adds the entire group.
                  </p>
                )}
                {(page.total ?? 0) > 100 && (
                  <div className="companion-geo-pages">
                    <button
                      className="icon-button"
                      aria-label="Previous matching groups"
                      disabled={!lookup?.offset}
                      onClick={() => {
                        setGroup('');
                        setLookup(
                          (value) => value && { ...value, offset: Math.max(0, value.offset - 100) },
                        );
                      }}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span>
                      {(lookup?.offset ?? 0) + 1}–
                      {Math.min((lookup?.offset ?? 0) + 100, page.total ?? 0)} / {page.total}
                    </span>
                    <button
                      className="icon-button"
                      aria-label="Next matching groups"
                      disabled={(lookup?.offset ?? 0) + 100 >= (page.total ?? 0)}
                      onClick={() => {
                        setGroup('');
                        setLookup((value) => value && { ...value, offset: value.offset + 100 });
                      }}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </details>
        {selectedRule && !selectedRule.enabled && (
          <p className="notice">The selected rule is disabled.</p>
        )}
        <p className="companion-rule-hint">
          Saved to the draft. Apply the graph to activate the change.
        </p>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
