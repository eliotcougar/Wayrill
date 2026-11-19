import { Copy, FlaskConical, Plus, RefreshCw, Send } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { layerNames } from './layers';
import { mayHaveDelivery, usesLayer } from './management';
import { memberGraphs, memberLayers } from './publisher';
import type { Member, Publisher } from './publisher';
import type { PoolModal } from './PoolWorkspace';

export const userCount = (count: number) => `${count} ${count === 1 ? 'user' : 'users'}`;
export type PoolView = 'layers' | 'users' | 'publish';
const deliveryStates = {
  pending: 'Pending publication',
  unassigned: 'Needs a default graph',
  published: 'Published',
  withdrawn: 'Withdrawn',
} as const;
type DeliveryState = keyof typeof deliveryStates;
type Props = {
  view: PoolView;
  pool: Publisher;
  busy: boolean;
  accountError: string;
  open: (modal: PoolModal) => void;
  go: (view: PoolView) => void;
  assignedLayer?: { id: string; name: string };
  showLayerUsers: (id: string) => void;
  clearLayerUsers: () => void;
  importFile: () => void;
  refresh: () => void;
  pending: Member[];
  publish: (members: Member[]) => void;
  copy: (member: Member) => void;
  simulate: (member: Member) => void;
};
function Row({
  title,
  detail,
  children,
}: {
  title: string;
  detail: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="item-row">
      <div className="item-content">
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      <div className="pool-row-actions">{children}</div>
    </div>
  );
}
function Actions({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pool-toolbar">
      <h2>{title}</h2>
      <div>{children}</div>
    </div>
  );
}
export default function PoolViews({
  view,
  pool,
  busy,
  accountError,
  open,
  go,
  assignedLayer,
  showLayerUsers,
  clearLayerUsers,
  importFile,
  refresh,
  pending,
  publish,
  copy,
  simulate,
}: Props) {
  const [query, setQuery] = useState('');
  const [deliveryState, setDeliveryState] = useState<DeliveryState | ''>('');
  const searchText = query.trim().toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(searchText);
  const search = (label: string) => (
    <input
      className="text-control pool-search"
      type="search"
      aria-label={label}
      placeholder={label + '…'}
      value={query}
      onChange={(event) => setQuery(event.currentTarget.value)}
    />
  );
  if (view === 'layers') {
    const layers = [
      ...pool.configurations.map(({ id, bundle }) => ({
        id,
        name: bundle.name,
        kind: 'graph' as const,
      })),
      ...(pool.layers ?? []).map(({ id, name, data }) => ({ id, name, kind: data.kind })),
    ];
    const visible = layers.filter(({ name, kind }) => matches(name + ' ' + layerNames[kind]));
    const kinds = ['graph', 'stash', 'traffic', 'dns', 'loopback', 'app-protection'] as const;
    const assignedCounts = new Map<string, number>();
    for (const member of pool.members) {
      for (const id of new Set([...memberGraphs(member), ...memberLayers(member)]))
        assignedCounts.set(id, (assignedCounts.get(id) ?? 0) + 1);
    }
    return (
      <section className="pool-section">
        <Actions title="Configuration layers">
          <button className="secondary-button" disabled={busy} onClick={importFile}>
            Import layer file…
          </button>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => open({ kind: 'new-layer' })}
          >
            <Plus size={15} /> New layer…
          </button>
        </Actions>
        <p className="field-help">
          Graphs define routing and its default rules. Assign other layers to give subscribers more
          choices, including Windows loopback exemptions and app protection.
        </p>
        {layers.length > 0 && search('Find layers')}
        {layers.length > 0 && (
          <div className="pool-layer-groups">
            {kinds.map((kind) => {
              const group = visible.filter((entry) => entry.kind === kind);
              return (
                group.length > 0 && (
                  <section key={kind} aria-label={layerNames[kind]}>
                    <h3>
                      {
                        {
                          graph: 'Graphs',
                          stash: 'Stashes',
                          traffic: 'Traffic filters',
                          dns: 'DNS filters',
                          loopback: layerNames.loopback,
                          'app-protection': layerNames['app-protection'],
                        }[kind]
                      }
                    </h3>
                    <div className="item-list">
                      {group.map(({ id, name }) => (
                        <Row key={id} title={name} detail={userCount(assignedCounts.get(id) ?? 0)}>
                          <button
                            className="secondary-button"
                            disabled={busy}
                            onClick={() =>
                              open({
                                kind:
                                  kind === 'graph'
                                    ? 'edit-graph'
                                    : kind === 'stash'
                                      ? 'edit-stash'
                                      : kind === 'traffic' || kind === 'dns'
                                        ? 'edit-filter'
                                        : 'edit-device',
                                id,
                              })
                            }
                          >
                            {kind === 'graph'
                              ? 'Edit graph'
                              : kind === 'stash'
                                ? 'Edit Stash'
                                : kind === 'traffic' || kind === 'dns'
                                  ? 'Edit rules'
                                  : 'Edit settings'}
                          </button>
                          <button
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => open({ kind: 'duplicate-layer', id })}
                          >
                            <Copy size={15} /> Duplicate…
                          </button>
                          {(assignedCounts.get(id) ?? 0) > 0 && (
                            <button
                              className="secondary-button"
                              disabled={busy}
                              onClick={() => showLayerUsers(id)}
                            >
                              View users
                            </button>
                          )}
                          <button
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => open({ kind: 'layer', id, name })}
                          >
                            Manage…
                          </button>
                        </Row>
                      ))}
                    </div>
                  </section>
                )
              );
            })}
            {!visible.length && <p className="empty-state">No matching layers.</p>}
          </div>
        )}
        {!!pool.configurations.length && (
          <button className="secondary-button" disabled={busy} onClick={() => go('users')}>
            Manage user assignments
          </button>
        )}
      </section>
    );
  }

  const graphNames = new Map(pool.configurations.map(({ id, bundle }) => [id, bundle.name]));
  const layerLabels = new Map(pool.layers?.map(({ id, name }) => [id, name]));
  const detail = (member: Member) =>
    [
      graphNames.get(member.configurationId) ?? 'No default graph',
      ...memberGraphs(member)
        .filter((id) => id !== member.configurationId)
        .map((id) => graphNames.get(id) ?? 'Missing graph'),
      ...memberLayers(member).map((id) => layerLabels.get(id) ?? 'Missing layer'),
      ...(member.accounts?.length
        ? [
            `${member.accounts.length} Aquifer ${member.accounts.length === 1 ? 'server' : 'servers'}`,
          ]
        : member.aquifer
          ? ['Aquifer credentials']
          : []),
    ].join(' · ');
  const due = new Set(pending.map((member) => member.id));
  const status = (member: Member): DeliveryState =>
    member.withdrawn
      ? 'withdrawn'
      : !member.configurationId
        ? 'unassigned'
        : due.has(member.id)
          ? 'pending'
          : 'published';
  const relevant = assignedLayer
    ? pool.members.filter((member) => usesLayer(member, assignedLayer.id))
    : pool.members;
  const counts = { pending: 0, unassigned: 0, published: 0, withdrawn: 0 };
  const visible = relevant.flatMap((member) => {
    const state = status(member);
    counts[state]++;
    if (deliveryState && state !== deliveryState) return [];
    const summary = detail(member);
    const label =
      state === 'pending'
        ? member.publishedAt
          ? 'Update pending'
          : 'Ready to publish'
        : deliveryStates[state];
    return matches(`${member.name} ${summary} ${label}`) ? [{ member, state, summary, label }] : [];
  });
  const filtered = !!(deliveryState || searchText || assignedLayer);
  const publishTargets = visible
    .filter(({ state }) => state === 'pending')
    .map(({ member }) => member);
  return (
    <section className="pool-section">
      {view === 'users' ? (
        <>
          <Actions title="Users">
            <button className="secondary-button" disabled={busy} onClick={refresh}>
              <RefreshCw size={15} /> Refresh Aquifer accounts
            </button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => open({ kind: 'user' })}
            >
              <Plus size={15} /> Add user
            </button>
          </Actions>
          <p className="field-help">
            Assign graphs, Stashes, filters and private server accounts to each user.
          </p>
        </>
      ) : (
        <>
          <Actions title="Publish deliveries">
            {pool.members.some(mayHaveDelivery) && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => open({ kind: 'withdraw' })}
              >
                Withdraw all…
              </button>
            )}
            {pool.members.some((member) => member.withdrawn && member.configurationId) && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => open({ kind: 'resume' })}
              >
                Resume withdrawn…
              </button>
            )}
            <button
              className="primary-button"
              disabled={busy || !publishTargets.length}
              onClick={() => publish(publishTargets)}
            >
              <Send size={15} />{' '}
              {publishTargets.length
                ? `Publish ${userCount(publishTargets.length)}${filtered ? ' in view' : ''}`
                : 'Publish updates'}
            </button>
          </Actions>
          <p className="field-help">
            Publish each user’s delivery, then copy their invitation. Subscribers paste it in Tools
            → Connect to Pool in Wayrill.
          </p>
        </>
      )}
      {!!pool.members.length && (
        <div className="pool-list-controls">
          {search(view === 'users' ? 'Find users' : 'Find deliveries')}
          <select
            className="text-control"
            aria-label="Delivery status"
            value={deliveryState}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDeliveryState(value in deliveryStates ? (value as DeliveryState) : '');
            }}
          >
            <option value="">All delivery statuses</option>
            {(Object.keys(deliveryStates) as DeliveryState[]).map((state) => (
              <option key={state} value={state}>
                {deliveryStates[state]} ({counts[state]})
              </option>
            ))}
          </select>
          {assignedLayer && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={clearLayerUsers}
              title="Clear layer filter"
            >
              Layer: {assignedLayer.name} ×
            </button>
          )}
          {filtered && (
            <span className="field-help" role="status">
              {visible.length} of {userCount(pool.members.length)}
            </span>
          )}
        </div>
      )}
      {pool.members.length ? (
        <div className="item-list">
          {visible.map(({ member, state, summary, label }) => (
            <Row
              key={member.id}
              title={member.name}
              detail={
                <>
                  <span className="pool-user-status" data-status={state}>
                    {label}
                  </span>
                  {' · '}
                  {view === 'users'
                    ? summary
                    : member.publishedAt && !member.withdrawn
                      ? 'Last published ' + new Date(member.publishedAt).toLocaleString()
                      : summary}
                </>
              }
            >
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => open({ kind: 'preview', member, allowPublish: state === 'pending' })}
              >
                Preview
              </button>
              {!!member.publishedAt && !member.withdrawn && (
                <button
                  className="secondary-button"
                  disabled={busy}
                  title="Open their published invitation in a simulated Wayrill window"
                  onClick={() => simulate(member)}
                >
                  <FlaskConical size={15} /> Test invitation…
                </button>
              )}
              {view === 'users' ? (
                <>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => open({ kind: 'user', member })}
                  >
                    Edit delivery
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => open({ kind: 'user', template: member })}
                  >
                    Add similar user…
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => open({ kind: 'revoke', member })}
                  >
                    Remove…
                  </button>
                </>
              ) : (
                <>
                  {member.configurationId ? (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => publish([member])}
                    >
                      {member.withdrawn
                        ? 'Resume publishing'
                        : due.has(member.id)
                          ? 'Publish'
                          : 'Republish'}
                    </button>
                  ) : (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => open({ kind: 'user', member })}
                    >
                      Assign graph…
                    </button>
                  )}
                  <button
                    className={
                      member.publishedAt && !member.withdrawn
                        ? 'primary-button'
                        : 'secondary-button'
                    }
                    disabled={busy || member.withdrawn || !member.publishedAt}
                    onClick={() => copy(member)}
                  >
                    Copy invitation
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => open({ kind: 'rotate', member })}
                  >
                    New invitation…
                  </button>
                  {mayHaveDelivery(member) && (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => open({ kind: 'withdraw', member })}
                    >
                      Withdraw…
                    </button>
                  )}
                </>
              )}
            </Row>
          ))}
          {!visible.length && <p className="empty-state">No matching users.</p>}
        </div>
      ) : (
        <p>
          {view === 'users'
            ? 'Add a user and choose the graph they should receive.'
            : 'Add a user and assign their default graph before publishing.'}
        </p>
      )}
      {view === 'users' && accountError && (
        <p className="notice notice--error" role="alert">
          {accountError}
        </p>
      )}
      {view === 'users' && !!pool.members.length && (
        <button className="secondary-button" disabled={busy} onClick={() => go('publish')}>
          Review publishing
        </button>
      )}
    </section>
  );
}
