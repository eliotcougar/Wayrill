import { useMemo, useState, type ReactNode } from 'react';
import Dialog from '../components/Dialog';
import { readDnsFilter } from '../graph/dns';
import { detachDnsSource } from '../graph/dnsRuleSource';
import { parseGraph } from '../graph/model';
import { readRuleTable } from '../graph/rules';
import { detachTrafficSource } from '../graph/trafficRuleSource';
import { parseStash } from '../profiles/import';
import { errorText } from '../serviceClient';
import type { ObservedServer } from './accounts';
import { layerNames, type PoolTransfer } from './layers';
import { usesLayer } from './management';
import { prepareDelivery, type Member, type Publisher } from './publisher';
import { resolvePoolDelivery } from './delivery';
import { PoolSettingSummary } from './PoolSettingFields';
import type { PoolGraphStarter } from './graphLayer';

type Form = { busy: boolean; failure: string; onClose: () => void };
type LayerKind = keyof typeof layerNames;
type FilterLayer = Extract<PoolTransfer, { kind: 'traffic' | 'dns' }>;
export type NewLayerDraft =
  | { kind: 'graph'; name: string; starter: PoolGraphStarter }
  | { kind: 'stash'; name: string }
  | FilterLayer;

export function NewLayer({
  pool,
  firstGraph = false,
  onClose,
  onCreate,
}: {
  pool: Publisher;
  firstGraph?: boolean;
  onClose: () => void;
  onCreate: (draft: NewLayerDraft) => void;
}) {
  const [kind, setKind] = useState<LayerKind>('graph');
  const [name, setName] = useState(firstGraph ? 'Main routing' : '');
  const [starter, setStarter] = useState<PoolGraphStarter>(firstGraph ? 'traffic' : 'direct');
  const [choice, setChoice] = useState('');
  const [copyRules, setCopyRules] = useState(false);
  const filter = kind === 'traffic' || kind === 'dns';
  const candidates = useMemo(() => {
    if (kind !== 'traffic' && kind !== 'dns') return [];
    return pool.configurations.flatMap(({ id, bundle }) =>
      parseGraph(bundle.graph)
        .nodes.filter(
          (node) =>
            node.data.kind === (kind === 'traffic' ? 'routing-filter' : 'dns-routing-filter'),
        )
        .map((node) => ({ key: JSON.stringify([id, node.id]), node, graph: bundle.name })),
    );
  }, [kind, pool.configurations]);
  const source = candidates.find((item) => item.key === choice);
  const outputs =
    source &&
    (kind === 'dns'
      ? readDnsFilter(source.node.data.settings).outputs
      : readRuleTable(source.node.data.settings).outputs);
  function create() {
    const label = name.trim();
    if (kind === 'graph' || kind === 'stash') {
      onCreate(kind === 'graph' ? { kind, name: label, starter } : { kind, name: label });
      return;
    }
    if (!source) return;
    const { id, data } = source.node;
    if (kind === 'traffic') {
      const table = detachTrafficSource(readRuleTable(data.settings));
      onCreate({
        kind,
        name: label,
        filter: { nodeId: id, table: copyRules ? table : { ...table, rules: [] } },
      });
    } else {
      const rules = detachDnsSource(readDnsFilter(data.settings));
      onCreate({
        kind,
        name: label,
        nodeId: id,
        filter: copyRules ? rules : { ...rules, rules: [] },
      });
    }
  }
  return (
    <Dialog
      title={firstGraph ? 'Create the first graph' : 'New layer'}
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={!name.trim() || (filter && !source)}
            onClick={create}
          >
            Open editor
          </button>
        </>
      }
    >
      {!firstGraph && (
        <label className="editor-field">
          <span>Layer type</span>
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.currentTarget.value as LayerKind);
              setChoice('');
            }}
          >
            {(Object.entries(layerNames) as [LayerKind, string][]).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="editor-field">
        <span>Name</span>
        <input
          autoFocus
          maxLength={128}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {kind === 'graph' && (
        <label className="editor-field">
          <span>Start with</span>
          <select
            value={starter}
            onChange={(event) =>
              setStarter(event.target.value === 'traffic' ? 'traffic' : 'direct')
            }
          >
            <option value="traffic">Traffic filter with Direct and Block</option>
            <option value="direct">Direct only</option>
          </select>
          <small className="field-help">
            Subscribers choose their own capture. Replace the Direct node with a server from the
            graph’s Stash if the default route should use a proxy.
          </small>
        </label>
      )}
      {filter && candidates.length > 0 && (
        <>
          <label className="editor-field">
            <span>Use outputs from</span>
            <select value={choice} onChange={(event) => setChoice(event.currentTarget.value)}>
              <option value="">Choose a filter in a base graph</option>
              {candidates.map(({ key, graph, node }) => (
                <option value={key} key={key}>
                  {graph} · {node.data.label}
                </option>
              ))}
            </select>
          </label>
          {outputs && (
            <p className="field-help">
              Outputs available to this layer: {outputs.map(({ name }) => name).join(', ')}.
            </p>
          )}
          <label className="check-control">
            <input
              type="checkbox"
              checked={copyRules}
              onChange={(event) => setCopyRules(event.currentTarget.checked)}
            />
            Start with the selected filter’s rules
          </label>
        </>
      )}
      <p className="field-help">
        {kind === 'graph'
          ? 'A base graph defines the routing and DNS wiring for a user.'
          : kind === 'stash'
            ? 'A Stash layer adds a reusable set of outbounds, policy groups, and chains.'
            : candidates.length
              ? 'A filter layer replaces the rules for a filter while using that graph’s output connections.'
              : `Add a ${layerNames[kind].toLowerCase()} node to a base graph first. Its output connections are used by the layer.`}
      </p>
    </Dialog>
  );
}

export function DeleteLayer({
  pool,
  id,
  layer,
  busy,
  failure,
  onClose,
  onDelete,
}: Form & {
  pool: Publisher;
  id: string;
  layer: PoolTransfer;
  onDelete: (replacement: string) => void;
}) {
  const [replacement, setReplacement] = useState('');
  const users = pool.members.filter((member) => usesLayer(member, id));
  const graph = layer.kind === 'graph';
  return (
    <DeliveryAction
      title={`Delete ${layer.name}?`}
      label="Delete layer"
      busy={busy}
      failure={failure}
      onClose={onClose}
      onConfirm={() => onDelete(replacement)}
    >
      {users.length ? (
        <>
          <p>
            Assigned to {users.length} {users.length === 1 ? 'user' : 'users'}.
          </p>
          <ul className="pool-affected">
            {users.map((user) => (
              <li key={user.id}>{user.name}</li>
            ))}
          </ul>
          {graph ? (
            <>
              <label className="editor-field">
                <span>Replacement default graph</span>
                <select
                  value={replacement}
                  onChange={(event) => setReplacement(event.currentTarget.value)}
                >
                  <option value="">Use another assigned graph if available</option>
                  {pool.configurations
                    .filter((item) => item.id !== id)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.bundle.name}
                      </option>
                    ))}
                </select>
              </label>
              <p className="field-help">
                This choice applies to users who had selected the deleted graph as their default.
              </p>
            </>
          ) : (
            <p>This removes the layer from those users’ assignments.</p>
          )}
          <p className="field-help">
            Their current deliveries stay available until you publish a replacement.
          </p>
        </>
      ) : (
        <p>This layer has no user assignments.</p>
      )}
    </DeliveryAction>
  );
}

export function DeliveryAction({
  title,
  label,
  busy,
  failure,
  onClose,
  onConfirm,
  children,
  destructive = true,
}: Form & {
  title: string;
  label: string;
  onConfirm: () => void;
  children: ReactNode;
  destructive?: boolean;
}) {
  return (
    <Dialog
      title={title}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className={destructive ? 'secondary-button button--danger' : 'primary-button'}
            disabled={busy}
            onClick={onConfirm}
          >
            {label}
          </button>
        </>
      }
    >
      {children}
      {failure && (
        <p className="notice notice--error pool-operation-error" role="alert">
          {failure}
        </p>
      )}
    </Dialog>
  );
}

export function DeliveryPreview({
  pool,
  member,
  servers,
  onClose,
  onEdit,
  onPublish,
}: {
  pool: Publisher;
  member: Member;
  servers: readonly ObservedServer[];
  onClose: () => void;
  onEdit: () => void;
  onPublish?: () => void;
}) {
  const summary = useMemo(() => {
    try {
      const delivery = prepareDelivery(pool, member, servers);
      const { bundle } = resolvePoolDelivery(delivery);
      const graph = parseGraph(bundle.graph);
      const main = graph.nodes.find((node) => node.id === graph.mainOutboundId);
      const labels = new Map(graph.nodes.map(({ id, data }) => [id, data.label]));
      const defaults = new Map(delivery.defaultLayers.map(({ id, target }) => [id, target]));
      return {
        name: bundle.name,
        graphs: delivery.graphs.map(({ id, bundle }) => ({
          id,
          name: bundle.name,
          byDefault: id === delivery.defaultGraph,
          settings: bundle.settings,
        })),
        layers: delivery.layers.map(({ id, name, data }) => {
          const target = defaults.get(id);
          const label = target && labels.get(target);
          return {
            id,
            name,
            kind: layerNames[data.kind],
            usage: label
              ? `Default for ${label}`
              : defaults.has(id)
                ? 'Included by default'
                : 'Subscriber choice',
          };
        }),
        main: main?.data.label,
        nodes: graph.nodes.length,
        groups: parseStash(bundle.stash).groups.map(({ id, name, entries }) => ({
          id,
          name,
          count: entries.length,
        })),
      };
    } catch (reason) {
      return errorText(reason);
    }
  }, [pool, member, servers]);
  return (
    <Dialog
      title={`Delivery for ${member.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" onClick={onClose}>
            Done
          </button>
          <button
            className={typeof summary === 'string' ? 'primary-button' : 'secondary-button'}
            onClick={onEdit}
          >
            Edit delivery
          </button>
          {onPublish && typeof summary !== 'string' && (
            <button className="primary-button" onClick={onPublish}>
              Publish delivery
            </button>
          )}
        </>
      }
    >
      {typeof summary === 'string' ? (
        <p className="notice notice--error" role="alert">
          {summary}
        </p>
      ) : (
        <>
          <dl className="pool-summary">
            <dt>Default graph</dt>
            <dd>
              {summary.name} · {summary.nodes} nodes
            </dd>
            <dt>Main outbound</dt>
            <dd>{summary.main || 'No Main outbound selected'}</dd>
          </dl>
          <h3>Available graphs and layers</h3>
          <ul>
            {summary.graphs.map(({ id, name, byDefault }) => (
              <li key={id}>
                {name} · {byDefault ? 'Default graph' : 'Subscriber choice'}
              </li>
            ))}
            {summary.layers.map(({ id, name, kind, usage }) => (
              <li key={id}>
                {name} · {kind} · {usage}
              </li>
            ))}
          </ul>
          {summary.graphs.some(({ settings }) => settings) && (
            <>
              <h3>Published app settings</h3>
              {summary.graphs
                .filter(({ settings }) => settings)
                .map(({ id, name, settings, byDefault }) => (
                  <details key={id} className="editor-advanced" open={byDefault || undefined}>
                    <summary>{name}</summary>
                    <PoolSettingSummary settings={settings} />
                  </details>
                ))}
            </>
          )}
          <h3>Stash with defaults</h3>
          {summary.groups.length ? (
            <ul>
              {summary.groups.map((group) => (
                <li key={group.id}>
                  {group.name} · {group.count} entries
                </li>
              ))}
            </ul>
          ) : (
            <p>No Stash entries.</p>
          )}
        </>
      )}
    </Dialog>
  );
}
