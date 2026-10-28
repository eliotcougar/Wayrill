import {
  policyPreviewView,
  type PolicyPreviewQuery,
  type PolicyPreviewView,
} from '../profiles/policyPreviewView';
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { policySetSummary, referenceSummary } from './editorSummaries';
import { Trash2 } from 'lucide-react';
import { LIMITS, OUTBOUND_LIMIT_LABEL, CONFIG_LIMIT_LABEL } from '../limits';
import {
  subscriptionSource,
  type PolicyFilter,
  type PolicyReference,
  type PolicySources,
} from '../graph/policySources';
import type { GraphState, RuleNode } from '../graph/types';
import type { Stash } from '../profiles/import';
import PolicyOutboundPicker from './PolicyOutboundPicker';
import ResultPager from './ResultPager';
import { libraryTerm } from '../profiles/library';

const referenceKey = (ref: PolicyReference) =>
  ref.type === 'node' ? `node:${ref.nodeId}` : `profile:${ref.id}`;

export default function PolicySourcesEditor({
  graph,
  node,
  stash,
  sources,
  controls,
  previewResult,
  previewSubscriptions,
  previewQuery,
  onPreviewQuery,
  pending = false,
  problem = '',
  pristineEmpty = false,
  onChange,
}: {
  graph: GraphState;
  node: RuleNode;
  stash: Stash;
  sources: PolicySources;
  controls?: ReactNode;
  previewResult?: PolicyPreviewView['summary'];
  previewSubscriptions?: PolicyPreviewView['subscriptions'];
  previewQuery?: PolicyPreviewQuery;
  onPreviewQuery?: (query: PolicyPreviewQuery) => void;
  pending?: boolean;
  problem?: string;
  pristineEmpty?: boolean;
  onChange: (sources: PolicySources) => void;
}) {
  const [page, setPage] = useState(0),
    [previewSearch, setPreviewSearch] = useState(''),
    [manualSearch, setManualSearch] = useState(''),
    [manualPage, setManualPage] = useState(0);
  const deferredSearch = useDeferredValue(libraryTerm(previewSearch));
  const mode = node.data.settings.selection;
  const subscriptions = mode === 'subscription' || mode === 'combined',
    manual = mode === 'manual' || mode === 'combined';
  const provided = useMemo(
    () => (previewResult ? { ...previewResult, problem: '' } : undefined),
    [previewResult],
  );
  const preview = useMemo(() => {
    try {
      if (provided) return provided;
      if (pending || problem) throw new Error(problem);
      const summary = policySetSummary(graph, node);
      const view = policyPreviewView(
        graph,
        { summary, sources, serialized: '', issues: [], observed: false, corePreview: '' },
        { search: deferredSearch, page },
      );
      return { ...view.summary, problem: '' };
    } catch (e) {
      return {
        rows: [],
        total: 0,
        matched: 0,
        page: 0,
        manual: 0,
        subscription: 0,
        duplicates: 0,
        rejected: 0,
        problem: pristineEmpty ? '' : e instanceof Error ? e.message : 'Invalid outbound set.',
      };
    }
  }, [graph, node, provided, pending, problem, pristineEmpty, sources, deferredSearch, page]);
  const searchPending = !onPreviewQuery && libraryTerm(previewSearch) !== deferredSearch;
  const manualMatches = useMemo(
    () =>
      sources.manual
        .map((reference, index) => ({
          reference,
          index,
          summary: referenceSummary(graph, reference),
        }))
        .filter(
          (row) =>
            !libraryTerm(manualSearch) ||
            libraryTerm(Object.values(row.summary).join(' ')).includes(libraryTerm(manualSearch)),
        ),
    [sources.manual, graph, manualSearch],
  );
  const manualCurrent = Math.min(manualPage, Math.max(0, Math.ceil(manualMatches.length / 30) - 1));
  const currentPage = preview.page;
  const query = previewQuery ?? { search: previewSearch, page };
  const changeQuery = (next: PolicyPreviewQuery) => {
    if (onPreviewQuery) onPreviewQuery(next);
    else {
      setPreviewSearch(next.search);
      setPage(next.page);
    }
  };
  const updateFilter = (groupId: string, key: keyof PolicyFilter, value: string) => {
    onChange({
      ...sources,
      subscriptions: sources.subscriptions.map((s) =>
        s.groupId === groupId ? { ...s, filter: { ...s.filter, [key]: value } } : s,
      ),
    });
    setPage(0);
  };
  const displayedSources = sources.subscriptions.map((source) => {
    const resolved = previewSubscriptions?.find((s) => s.groupId === source.groupId);
    return {
      ...source,
      ...resolved,
      entryCount: resolved?.entryCount ?? source.entries.length,
      filter: source.filter,
    };
  });
  return (
    <div className="policy-set-layout">
      <div className="policy-set-sources">
        {controls}
        {subscriptions && (
          <section aria-label="Subscription sources">
            <h3>Subscription sources</h3>
            <label className="editor-field">
              <span>Add subscription group</span>
              <select
                aria-label="Add subscription group"
                value=""
                onChange={(e) => {
                  const group = stash.groups.find((g) => g.id === e.target.value);
                  if (group)
                    onChange({
                      ...sources,
                      subscriptions: [...sources.subscriptions, subscriptionSource(group)],
                    });
                  setPage(0);
                }}
              >
                <option value="">Choose a stash group…</option>
                {stash.groups
                  .filter((g) => !sources.subscriptions.some((s) => s.groupId === g.id))
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} · {g.entries.length.toLocaleString()} configurations
                    </option>
                  ))}
              </select>
            </label>
            {!stash.groups.length && (
              <p className="field-help">Import a subscription into Configuration stash first.</p>
            )}
            {displayedSources.map((source) => (
              <div className="editor-panel policy-source-card" key={source.groupId}>
                <div className="section-heading">
                  <h4>{source.name}</h4>
                  <button
                    className="icon-button"
                    aria-label={`Remove subscription ${source.name}`}
                    onClick={() =>
                      onChange({
                        ...sources,
                        subscriptions: sources.subscriptions.filter(
                          (s) => s.groupId !== source.groupId,
                        ),
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <p className="policy-source-count">
                  {pending
                    ? 'Updating matches…'
                    : `${source.entryCount.toLocaleString()} usable matches`}
                  {source.rejected
                    ? ` · ${source.rejected.toLocaleString()} unsupported excluded`
                    : ''}
                  {source.missing ? ' · saved snapshot (group missing)' : ''}
                </p>
                <p className="field-help">
                  Local snapshot:{' '}
                  {source.updatedAt === null
                    ? 'Timestamp unavailable'
                    : new Date(source.updatedAt).toLocaleString()}
                  . Editing filters does not fetch the subscription.
                </p>
                {source.missing && (
                  <label className="editor-field">
                    <span>Relink {source.name}</span>
                    <select
                      aria-label={`Relink ${source.name}`}
                      value=""
                      onChange={(e) => {
                        const group = stash.groups.find((g) => g.id === e.target.value);
                        if (group)
                          onChange({
                            ...sources,
                            subscriptions: sources.subscriptions.map((s) =>
                              s.groupId === source.groupId
                                ? { ...subscriptionSource(group), filter: source.filter }
                                : s,
                            ),
                          });
                        setPage(0);
                      }}
                    >
                      <option value="">Keep saved snapshot…</option>
                      {stash.groups
                        .filter((g) => !sources.subscriptions.some((s) => s.groupId === g.id))
                        .map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                    </select>
                    <small className="field-help">
                      Relink to edit filters; the saved snapshot contains only the last matching
                      configurations.
                    </small>
                  </label>
                )}
                <label className="editor-field">
                  <span>Text matching · {source.name}</span>
                  <select
                    aria-label={`Text matching · ${source.name}`}
                    disabled={source.missing}
                    value={source.filter.mode}
                    onChange={(e) => updateFilter(source.groupId, 'mode', e.target.value)}
                  >
                    <option value="contains">Contains text</option>
                    <option value="glob">Wildcard pattern (* and ?)</option>
                  </select>
                </label>
                {(['name', 'exclude', 'address'] as const).map((key) => (
                  <label className="editor-field" key={key}>
                    <span>
                      {
                        {
                          name: 'Include names',
                          exclude: 'Exclude names',
                          address: 'Server addresses',
                        }[key]
                      }{' '}
                      · {source.name}
                    </span>
                    <textarea
                      aria-label={`${{ name: 'Include names', exclude: 'Exclude names', address: 'Server addresses' }[key]} · ${source.name}`}
                      disabled={source.missing}
                      rows={2}
                      maxLength={4096}
                      value={source.filter[key]}
                      placeholder={
                        key === 'exclude'
                          ? 'Optional exclusions, one per line'
                          : 'All when empty; one match per line'
                      }
                      onChange={(e) => updateFilter(source.groupId, key, e.target.value)}
                    />
                  </label>
                ))}
                <label className="editor-field">
                  <span>Protocol · {source.name}</span>
                  <select
                    aria-label={`Protocol · ${source.name}`}
                    disabled={source.missing}
                    value={source.filter.protocol}
                    onChange={(e) => updateFilter(source.groupId, 'protocol', e.target.value)}
                  >
                    <option value="">Any protocol</option>
                    {[
                      ...new Set(
                        [
                          source.filter.protocol,
                          ...(stash.groups
                            .find((g) => g.id === source.groupId)
                            ?.entries.map((e) => e.protocol) ??
                            source.entries.map((e) => e.profile.kind.replace('-outbound', ''))),
                        ].filter(Boolean),
                      ),
                    ]
                      .sort()
                      .map((p) => (
                        <option key={p} value={p}>
                          {p.toUpperCase()}
                        </option>
                      ))}
                  </select>
                </label>
                <p className="field-help">
                  Case-insensitive. Lines within a field are alternatives; name, exclusion, address
                  and protocol checks all apply.
                </p>
              </div>
            ))}
          </section>
        )}
        {manual && (
          <section aria-label="Manual outbound set">
            <h3>Manual outbound set</h3>
            <PolicyOutboundPicker
              label="Add outbound"
              excludeId={node.id}
              graph={graph}
              stash={stash}
              onSelect={(ref) => {
                if (!sources.manual.some((r) => referenceKey(r) === referenceKey(ref)))
                  onChange({ ...sources, manual: [...sources.manual, ref] });
              }}
            />
            {!!sources.manual.length && (
              <label className="editor-field">
                <span>Search manual set</span>
                <input
                  autoComplete="off"
                  aria-label="Search manual set"
                  value={manualSearch}
                  onChange={(e) => {
                    setManualSearch(e.target.value);
                    setManualPage(0);
                  }}
                  placeholder="Name, server or protocol"
                />
              </label>
            )}
            <ResultPager
              compact
              label="Manual set"
              count={manualMatches.length}
              size={30}
              page={manualCurrent}
              onPage={setManualPage}
            />
            <div className="policy-manual-list">
              {manualMatches
                .slice(manualCurrent * 30, (manualCurrent + 1) * 30)
                .map(({ reference, index: i, summary }) => {
                  return (
                    <div className="policy-picker-row" key={`${referenceKey(reference)}-${i}`}>
                      <span>
                        <strong dir="auto" title={summary.name}>
                          {summary.name}
                        </strong>
                        <small>
                          {summary.protocol} ·{' '}
                          {summary.address || summary.tag || 'No server address'} ·{' '}
                          {reference.type === 'node' ? 'Graph reference' : 'Copied configuration'}
                        </small>
                      </span>
                      <button
                        className="icon-button"
                        aria-label={`Remove manual ${summary.name}`}
                        onClick={() =>
                          onChange({
                            ...sources,
                            manual: sources.manual.filter((_, index) => index !== i),
                          })
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  );
                })}
            </div>
            {!sources.manual.length && (
              <p className="field-help">
                Add graph outbounds or copy configurations from the stash.
              </p>
            )}
          </section>
        )}
        {mode === 'prefixes' && (
          <p className="notice">
            Native Xray selectors match outbound tag prefixes. The preview follows the current graph
            tags. Imported prefix semantics stay intact.
          </p>
        )}
      </div>
      <section
        className="editor-panel editor-panel--subtle policy-set-preview"
        aria-label="Resolved outbound set"
        aria-busy={pending || searchPending}
      >
        {pending && (
          <p role="status" className="field-help">
            Updating the current filters… Previous results are shown until the current draft is
            checked.
          </p>
        )}
        <h3>
          Resulting outbound set{' '}
          <span className="policy-count">
            {preview.problem ? 'Unavailable' : preview.total.toLocaleString()}
          </span>
        </h3>
        {mode === 'combined' && (
          <p className="field-help">
            Subscription matches and manual outbounds are combined; duplicates appear once.
          </p>
        )}
        {!preview.problem &&
          (mode === 'combined' || preview.duplicates > 0 || preview.rejected > 0) && (
            <dl className="policy-source-totals" aria-label="Candidate source totals">
              {mode === 'prefixes' ? (
                <>
                  <dt>Native prefix matches</dt>
                  <dd>{preview.total.toLocaleString()}</dd>
                </>
              ) : (
                <>
                  {manual && (
                    <>
                      <dt>Manual entries</dt>
                      <dd>{preview.manual.toLocaleString()}</dd>
                    </>
                  )}
                  {subscriptions && (
                    <>
                      <dt>Usable subscription matches</dt>
                      <dd>{preview.subscription.toLocaleString()}</dd>
                    </>
                  )}
                  {preview.duplicates > 0 && (
                    <>
                      <dt>Duplicate entries merged</dt>
                      <dd>{preview.duplicates.toLocaleString()}</dd>
                    </>
                  )}
                  {preview.rejected > 0 && (
                    <>
                      <dt>Unsupported matches excluded</dt>
                      <dd>{preview.rejected.toLocaleString()}</dd>
                    </>
                  )}
                </>
              )}
            </dl>
          )}

        <label className="editor-field">
          <span>Search resulting outbounds</span>
          <input
            autoComplete="off"
            aria-label="Search resulting outbounds"
            value={query.search}
            placeholder="Name, server, protocol or source"
            onChange={(e) => {
              changeQuery({ search: e.target.value, page: 0 });
            }}
          />
        </label>
        {(preview.matched > 25 || query.search.trim()) && (
          <ResultPager
            label="Policy"
            compact
            count={preview.matched}
            size={25}
            page={currentPage}
            disabled={pending || searchPending}
            onPage={(page) => changeQuery({ ...query, page })}
          />
        )}
        {searchPending && (
          <p role="status" className="field-help">
            Updating search…
          </p>
        )}
        {preview.problem && <p className="error">{preview.problem}</p>}
        {!pending && !preview.total && !preview.problem && (
          <p className="empty-state empty-state--inline">
            {pristineEmpty
              ? 'Choose an outbound from Stash or a subscription group'
              : 'No matching outbound. Adjust the sources or filters'}
            {!pristineEmpty && node.data.settings.fallbackEnabled
              ? '; choose or review the fallback below'
              : pristineEmpty
                ? ''
                : '; enable a fallback below to handle an empty set'}
            .
          </p>
        )}

        {preview.total > LIMITS.maxOutbounds && (
          <p className="warning">
            The service supports {OUTBOUND_LIMIT_LABEL} total core outbounds. All matches are shown;
            narrow this set before running.
          </p>
        )}
        <div className="policy-candidate-table">
          <table className="data-table data-table--compact data-table--sticky">
            <thead>
              <tr>
                <th>Outbound</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map(({ key, summary, origins }) => {
                return (
                  <tr key={key}>
                    <td>
                      <strong dir="auto" title={summary.name}>
                        {summary.name}
                      </strong>
                      <small>
                        {summary.protocol}
                        {summary.address ? ` · ${summary.address}` : ''}
                      </small>
                    </td>
                    <td>{origins.join(' · ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <details className="editor-advanced">
          <summary>Candidate details and limits</summary>
          <p className="field-help">
            Availability is not tested. Graph references track their nodes; copied configurations
            stay independent.
          </p>
          <p className="field-help">
            {OUTBOUND_LIMIT_LABEL} total core outbounds · {CONFIG_LIMIT_LABEL} of configuration.
            Helper stages and other graph destinations count too.
          </p>
        </details>
        {!!query.search && !preview.matched && (
          <p className="field-help">
            No preview row matches your search. The outbound set itself is unchanged.
          </p>
        )}
      </section>
    </div>
  );
}
