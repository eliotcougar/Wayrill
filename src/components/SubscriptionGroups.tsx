import { useDeferredValue, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { StashGroup } from '../profiles/import';
import { DEFAULT_GROUP_ID } from '../profiles/stashModel';
import { maintenanceDefaults } from '../profiles/subscriptionState';
import type { MaintenanceStatus } from '../profiles/useSubscriptionMaintenance';
import type { RefreshProgress } from '../profiles/subscriptionManagement';
import ResultPager from './ResultPager';
import ActionMenu from './ActionMenu';

export default function SubscriptionGroups({
  groups,
  busy,
  canDownload,
  canTest,
  statuses,
  progress,
  problems,
  onBrowse,
  onEdit,
  onRefresh,
  onRefreshAll,
  onPause,
  onExport,
  onFile,
  onRemove,
  onTest,
  onCancel,
}: {
  groups: StashGroup[];
  busy: boolean;
  canDownload: boolean;
  canTest: boolean;
  statuses: Record<string, MaintenanceStatus>;
  progress: RefreshProgress | null;
  problems: Record<string, string>;
  onBrowse: (group: StashGroup, availability?: string) => void;
  onEdit: (group: StashGroup, trigger: HTMLButtonElement) => void;
  onRefresh: (group: StashGroup) => void;
  onRefreshAll: () => void;
  onPause: (group: StashGroup) => void;
  onExport: (group: StashGroup) => void;
  onFile: (group: StashGroup) => void;
  onRemove: (group: StashGroup) => void;
  onTest: (group: StashGroup) => void;
  onCancel: (id: string) => void;
}) {
  const interval = (minutes: number) =>
    minutes % 1440 === 0
      ? `${minutes / 1440} d`
      : minutes % 60 === 0
        ? `${minutes / 60} h`
        : `${minutes} min`;
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(0);
  const term = useDeferredValue(query.trim().toLocaleLowerCase());
  const filtered = useMemo(
    () =>
      groups.filter(
        (group) => group.id !== DEFAULT_GROUP_ID && group.name.toLocaleLowerCase().includes(term),
      ),
    [groups, term],
  );
  const summaries = useMemo(
    () =>
      new Map(
        groups.map((group) => {
          let locked = 0;
          for (const entry of group.entries) {
            if (entry.locked) locked++;
          }
          return [group.id, { locked }];
        }),
      ),
    [groups],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 30) - 1));
  const time = (value: number | null) =>
    value ? new Date(value).toLocaleString() : 'Never refreshed';
  return (
    <section aria-label="Subscription groups" className="subscription-groups">
      <div className="form-row subscription-group-tools">
        <label>
          Find group
          <input
            className="text-control"
            aria-label="Find subscription group"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            autoComplete="off"
          />
        </label>
        <button
          className="secondary-button"
          disabled={busy || !canDownload || !groups.some((group) => group.url)}
          title="Refresh all URL groups, including paused groups"
          onClick={onRefreshAll}
        >
          <RefreshCw size={14} /> Refresh all
        </button>
      </div>
      {progress && busy && (
        <p role="status">
          {progress.completed}/{progress.total} groups · {progress.active || 'Finishing…'}
        </p>
      )}
      <div className="subscription-group-list" role="list">
        {filtered.slice(currentPage * 30, (currentPage + 1) * 30).map((group) => {
          const summary = summaries.get(group.id)!;
          const settings = group.maintenance ?? maintenanceDefaults;
          const status = statuses[group.id];
          const running = status && ['testing', 'refreshing'].includes(status.state);
          return (
            <article key={group.id} role="listitem" className="subscription-group-row">
              <div className="subscription-group-summary">
                <button
                  className="subscription-group-name"
                  disabled={busy}
                  onClick={() => onBrowse(group)}
                >
                  <bdi>{group.name}</bdi>
                </button>
                <span>
                  {group.entries.length.toLocaleString()} entries
                  {summary.locked ? ` · ${summary.locked.toLocaleString()} locked` : ''}
                </span>
                <span>
                  {group.maintenancePaused
                    ? 'Automatic maintenance paused'
                    : [
                        group.url && settings.autoRefresh
                          ? `Refresh every ${interval(settings.refreshMinutes)}`
                          : 'Manual refresh',
                        settings.removeUnreachable ? 'Remove unreachable after loading' : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                  {' · '}
                  {group.url ? time(group.updatedAt) : 'File / pasted configurations'}
                </span>
                {(problems[group.id] || status?.state === 'error') && (
                  <span className="stash-problem" role="alert">
                    {problems[group.id] || status?.message}
                  </span>
                )}
                {running && <span role="status">{status.message}</span>}
              </div>
              <div className="action-row">
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={(event) => onEdit(group, event.currentTarget)}
                >
                  Settings…
                </button>
                <button
                  className="secondary-button"
                  disabled={busy || !canDownload || !group.url}
                  onClick={() => onRefresh(group)}
                >
                  <RefreshCw size={14} /> Refresh
                </button>
                <ActionMenu
                  label={`More actions for ${group.name}`}
                  items={[
                    {
                      label: group.maintenancePaused
                        ? 'Resume automatic maintenance'
                        : 'Pause automatic maintenance',
                      disabled: busy,
                      action: () => onPause(group),
                    },
                    {
                      label: 'Retest group',
                      disabled: busy || !canTest || !group.entries.length,
                      action: () => onTest(group),
                    },
                    ...(running
                      ? [{ label: 'Cancel current run', action: () => onCancel(group.id) }]
                      : []),
                    { label: 'Export group…', disabled: busy, action: () => onExport(group) },
                    { label: 'Update from file…', disabled: busy, action: () => onFile(group) },
                    { label: 'Remove group…', disabled: busy, action: () => onRemove(group) },
                  ]}
                />
              </div>
            </article>
          );
        })}
      </div>
      {!filtered.length && (
        <p className="stash-empty">
          {groups.length > 1
            ? 'No matching groups.'
            : 'Add a subscription or import configurations to create a group.'}
        </p>
      )}
      <ResultPager
        label="Subscription groups"
        count={filtered.length}
        size={30}
        page={currentPage}
        disabled={busy || term !== query.trim().toLocaleLowerCase()}
        onPage={setPage}
      />
    </section>
  );
}
