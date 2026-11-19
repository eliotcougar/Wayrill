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
import { invitationDestination, prepareDelivery, type Member, type Publisher } from './publisher';
import { resolvePoolDelivery } from './delivery';
import { PoolSettingSummary } from './PoolSettingFields';
import type { PoolGraphStarter } from './graphLayer';
import { availableLayerName } from './copy';
import type { DeviceLayerData } from './deviceLayers';

type Form = { busy: boolean; failure: string; onClose: () => void };
type LayerKind = keyof typeof layerNames;
type FilterLayer = Extract<PoolTransfer, { kind: 'traffic' | 'dns' }>;
export type NewLayerDraft =
  | { kind: 'graph'; name: string; starter: PoolGraphStarter }
  | { kind: 'stash'; name: string }
  | (DeviceLayerData & { name: string })
  | FilterLayer;

export function DuplicateLayer({
  pool,
  layer,
  busy,
  failure,
  onClose,
  onDuplicate,
}: Form & {
  pool: Publisher;
  layer: PoolTransfer;
  onDuplicate: (name: string) => void;
}) {
  const [name, setName] = useState(() =>
    availableLayerName(layer.name.slice(0, 123) + ' copy', [
      ...pool.configurations.map(({ bundle }) => bundle.name),
      ...(pool.layers ?? []).map((item) => item.name),
    ]),
  );
  return (
    <Dialog
      title={'Duplicate ' + layer.name}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="secondary-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy || !name.trim()}
            onClick={() => onDuplicate(name.trim())}
          >
            Create copy and edit
          </button>
        </>
      }
    >
      <label className="editor-field">
        <span>Layer name</span>
        <input
          autoFocus
          value={name}
          maxLength={128}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <p className="field-help">
        {layer.kind === 'stash'
          ? 'The copy keeps the same servers, policy groups and chains. Edit its credentials, then assign it to the users who need them.'
          : 'Edit the copy independently, then assign it to users.'}
      </p>
      {failure && (
        <p className="notice notice--error" role="alert">
          {failure}
        </p>
      )}
    </Dialog>
  );
}

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
    if (kind === 'loopback' || kind === 'app-protection') {
      onCreate(
        kind === 'loopback'
          ? { kind, name: label, packages: [] }
          : { kind, name: label, protection: { enabled: true, applications: [] } },
      );
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
            : !filter
              ? 'Assign this layer to users so they can choose to apply it on their own PCs.'
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
  busy,
  failure,
  onClose,
  onEdit,
  onPublish,
}: {
  pool: Publisher;
  member: Member;
  servers: readonly ObservedServer[];
  busy: boolean;
  failure: string;
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
        groups: parseStash(bundle.stash)
          .groups.filter(({ entries }) => entries.length)
          .map(({ id, name, entries }) => ({
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
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" disabled={busy} onClick={onClose}>
            {onPublish ? 'Cancel' : 'Done'}
          </button>
          <button
            className={typeof summary === 'string' ? 'primary-button' : 'secondary-button'}
            disabled={busy}
            onClick={onEdit}
          >
            Edit delivery
          </button>
          {onPublish && typeof summary !== 'string' && (
            <button className="primary-button" disabled={busy} onClick={onPublish}>
              {busy ? 'Publishing…' : 'Publish delivery'}
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
            <dd>{summary.name}</dd>
            <dt>Main outbound</dt>
            <dd>{summary.main || 'No Main outbound selected'}</dd>
          </dl>
          {(summary.graphs.length > 1 || summary.layers.length > 0) && (
            <>
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
            </>
          )}
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
          {!!summary.groups.length && (
            <>
              <h3>Stash included by default</h3>
              <ul>
                {summary.groups.map((group) => (
                  <li key={group.id}>
                    {group.name} · {group.count} entries
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {failure && (
        <p className="notice notice--error pool-operation-error" role="alert">
          {failure}
        </p>
      )}
    </Dialog>
  );
}

export function InvitationReady({
  pool,
  member,
  busy,
  failure,
  copied,
  onClose,
  onCopy,
  onTest,
}: Form & {
  pool: Publisher;
  member: Member;
  copied: boolean;
  onCopy: () => void;
  onTest: () => void;
}) {
  const { kind, address } = invitationDestination(pool);
  return (
    <Dialog
      title={`Invitation ready for ${member.name}`}
      className="pool-dialog"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" disabled={busy} onClick={onClose}>
            Done
          </button>
          <button className="secondary-button" disabled={busy} onClick={onTest}>
            Test as subscriber
          </button>
          <button className="primary-button" disabled={busy} onClick={onCopy}>
            Copy invitation
          </button>
        </>
      }
    >
      <p>
        Send this invitation privately. {member.name} can paste it into{' '}
        <strong>Tools → Connect to Pool</strong> in Wayrill.
      </p>
      <dl className="pool-summary">
        <dt>{kind === 'url' ? 'Subscriber URL' : 'Subscriber folder'}</dt>
        <dd>{address}</dd>
      </dl>
      {kind === 'folder' && (
        <p className="field-help">
          {pool.subscriberFolder
            ? 'The subscriber needs read access to this network share.'
            : 'This invitation uses a local path. For another computer, set a network share or HTTPS address in Pool settings.'}
        </p>
      )}
      {copied && (
        <p className="notice" role="status">
          Invitation copied.
        </p>
      )}
      {failure && (
        <p className="notice notice--error" role="alert">
          {failure}
        </p>
      )}
    </Dialog>
  );
}
