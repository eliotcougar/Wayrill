import { useMemo, useState } from 'react';
import Dialog from '../components/Dialog';
import useFieldValidity from '../components/useFieldValidity';
import { poolSettingKeys, type PoolSettings } from '../graph/poolSettings';
import { PoolSettingFields } from './PoolSettingFields';
import { accountKey, observedAccount, type AccountRef, type ObservedServer } from './accounts';
import PoolAccountPicker, { EditAccount } from './PoolAccountPicker';
import { retargetAssignments } from './management';
import { graphLinks } from './graphLinks';
import { layerNames, layerTargets, type LayerAssignment } from './layers';
import {
  createPoolInvite,
  memberGraphs,
  memberLayers,
  type Member,
  type Publisher,
} from './publisher';

export default function PoolUserDialog({
  pool,
  member,
  template,
  firstDelivery = false,
  servers,
  busy,
  saveError,
  onClose,
  onSave,
}: {
  pool: Publisher;
  member?: Member;
  template?: Member;
  firstDelivery?: boolean;
  servers: ObservedServer[];
  busy: boolean;
  saveError: string;
  onClose: () => void;
  onSave: (member: Member, privateStashes: boolean) => void;
}) {
  const [name, setName] = useState(member?.name ?? '');
  const initialAccess = member ?? template;
  const soleGraph =
    firstDelivery && pool.configurations.length === 1 ? pool.configurations[0].id : '';
  const [configurationId, setGraph] = useState(initialAccess?.configurationId || soleGraph);
  const [assignments, setAssignments] = useState<LayerAssignment[]>(
    initialAccess?.assignments ?? [],
  );
  const [graphIds, setGraphIds] = useState(() => {
    const assigned = initialAccess ? memberGraphs(initialAccess) : [];
    return assigned.length || !soleGraph ? assigned : [soleGraph];
  });
  const [layerIds, setLayerIds] = useState(() =>
    initialAccess ? memberLayers(initialAccess) : [],
  );
  const [accounts, setAccounts] = useState<AccountRef[]>(member?.accounts ?? []);
  const [settings, setSettings] = useState<PoolSettings>(initialAccess?.settings ?? {});
  const [privateStashes, setPrivateStashes] = useState(false);
  const settingsValidity = useFieldValidity();
  const [main, setMain] = useState(member?.mainAccount ?? '');
  const [keepLegacy, setKeepLegacy] = useState(!!member?.aquifer);
  const [endpoint, setEndpoint] = useState('');
  const [replacing, setReplacing] = useState<AccountRef>();
  const graph = pool.configurations.find((item) => item.id === configurationId);
  const stashIds = new Set([
    ...layerIds,
    ...pool.configurations
      .filter(({ id }) => graphIds.includes(id))
      .flatMap(({ bundle }) => graphLinks(bundle).map(({ id }) => id)),
  ]);
  const hasStashes = pool.layers?.some(
    (layer) => layer.data.kind === 'stash' && stashIds.has(layer.id),
  );
  const targetsByLayer = useMemo(
    () =>
      new Map(
        (pool.layers ?? []).map((layer) => [
          layer.id,
          graph && layer.data.kind !== 'stash' ? layerTargets(graph.bundle, layer.data, true) : [],
        ]),
      ),
    [pool.layers, graph],
  );
  function save() {
    const next: Member = {
      ...member,
      id: member?.id ?? crypto.randomUUID(),
      invite: member?.invite ?? createPoolInvite(),
      name: name.trim(),
      configurationId,
      graphIds,
      layerIds,
      settings: Object.keys(settings).length ? settings : undefined,
      assignments,
      accounts,
      mainAccount: main || undefined,
      aquifer: keepLegacy && !main ? member?.aquifer : undefined,
      deliveryChanged:
        !!member?.deliveryChanged ||
        configurationId !== member?.configurationId ||
        JSON.stringify(graphIds) !== JSON.stringify(member ? memberGraphs(member) : []) ||
        JSON.stringify(layerIds) !== JSON.stringify(member ? memberLayers(member) : []) ||
        JSON.stringify(assignments) !== JSON.stringify(member?.assignments ?? []) ||
        poolSettingKeys.some((key) => settings[key] !== member?.settings?.[key]) ||
        JSON.stringify(accounts) !== JSON.stringify(member?.accounts ?? []) ||
        main !== (member?.mainAccount ?? '') ||
        keepLegacy !== !!member?.aquifer,
    };
    onSave(next, privateStashes && !!hasStashes);
  }
  return (
    <Dialog
      title={firstDelivery ? 'Set up the first user' : member ? 'Edit user delivery' : 'Add user'}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary-button"
            onClick={save}
            disabled={
              busy ||
              !name.trim() ||
              !!endpoint ||
              !!replacing ||
              settingsValidity.blocked ||
              (firstDelivery && !configurationId)
            }
          >
            {firstDelivery ? 'Review delivery' : 'Save user'}
          </button>
        </>
      }
    >
      <label className="editor-field">
        <span>Name</span>
        <input
          autoFocus
          value={name}
          maxLength={128}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {template && (
        <p className="field-help">
          Started with {template.name}’s graph, layer choices and app settings. This user gets a new
          invitation. Assign their private server account below if needed.
        </p>
      )}
      {!!pool.members.some((item) => item.id !== member?.id) && (
        <label className="editor-field">
          <span>Copy graph and layer assignments</span>
          <select
            value=""
            onChange={(event) => {
              const template = pool.members.find((item) => item.id === event.currentTarget.value);
              if (template) {
                setGraph(template.configurationId);
                setGraphIds(memberGraphs(template));
                setLayerIds(memberLayers(template));
                setAssignments(template.assignments ?? []);
              }
            }}
          >
            <option value="">Choose another user</option>
            {pool.members
              .filter((item) => item.id !== member?.id)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
          <small className="field-help">
            Copies graph and layer choices. Private accounts stay with their current user.
          </small>
        </label>
      )}
      {firstDelivery && graph && pool.configurations.length === 1 ? (
        <dl className="pool-summary">
          <dt>Routing graph</dt>
          <dd>{graph.bundle.name}</dd>
        </dl>
      ) : (
        <fieldset className="pool-assignments" disabled={busy}>
          <legend>Graphs this user can access</legend>
          <p className="field-help">
            Only selected graphs are delivered. The default is selected when the user connects.
          </p>
          {pool.configurations.map(({ id, bundle }) => (
            <label key={id} className="check-control">
              <input
                type="checkbox"
                checked={graphIds.includes(id)}
                onChange={(event) => {
                  const next = event.currentTarget.checked
                    ? [...graphIds, id]
                    : graphIds.filter((value) => value !== id);
                  setGraphIds(next);
                  if (!next.includes(configurationId)) {
                    const defaultId = next[0] ?? '';
                    setGraph(defaultId);
                    setAssignments(
                      retargetAssignments(
                        pool,
                        pool.configurations.find((item) => item.id === defaultId)?.bundle,
                        assignments,
                      ),
                    );
                  }
                }}
              />
              {bundle.name}
            </label>
          ))}
          <label className="editor-field">
            <span>Default graph</span>
            <select
              value={configurationId}
              onChange={(event) => {
                const id = event.currentTarget.value;
                const next = pool.configurations.find((item) => item.id === id);
                setGraph(id);
                setAssignments((current) => retargetAssignments(pool, next?.bundle, current));
              }}
            >
              {!graphIds.length && <option value="">Select a graph above</option>}
              {pool.configurations
                .filter(({ id }) => graphIds.includes(id))
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.bundle.name}
                  </option>
                ))}
            </select>
          </label>
        </fieldset>
      )}
      {!graph && (
        <p className="field-help">
          {firstDelivery
            ? 'Choose at least one graph to continue.'
            : 'You can save this user now. Choose a default graph before publishing.'}
        </p>
      )}
      {!!pool.layers?.length && (
        <details className="editor-advanced" open={layerIds.length > 0 || undefined}>
          <summary>Optional Stashes and filters</summary>
          <fieldset className="pool-assignments" disabled={busy}>
            <p className="field-help">
              Select which layers the subscriber can use. Set defaults for the layers that should be
              active at enrollment.
            </p>
            {pool.layers.map((layer) => {
              const assignment = assignments.find((item) => item.id === layer.id);
              const isFilter = layer.data.kind !== 'stash';
              const targets = targetsByLayer.get(layer.id) ?? [];
              return (
                <div key={layer.id} className="pool-assignment">
                  <label className="check-control">
                    <input
                      type="checkbox"
                      checked={layerIds.includes(layer.id)}
                      disabled={busy}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setLayerIds((current) =>
                          checked
                            ? [...current, layer.id]
                            : current.filter((id) => id !== layer.id),
                        );
                        if (!checked)
                          setAssignments((current) => current.filter(({ id }) => id !== layer.id));
                      }}
                    />
                    <span>
                      {layer.name} <small>{layerNames[layer.data.kind]}</small>
                    </span>
                  </label>
                  {layerIds.includes(layer.id) && !isFilter && (
                    <label className="check-control">
                      <input
                        type="checkbox"
                        checked={!!assignment}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setAssignments((current) =>
                            checked
                              ? [...current, { id: layer.id }]
                              : current.filter(({ id }) => id !== layer.id),
                          );
                        }}
                      />
                      Include by default
                    </label>
                  )}
                  {isFilter && layerIds.includes(layer.id) && !!targets.length && (
                    <select
                      className="text-control"
                      aria-label={`Destination for ${layer.name}`}
                      value={
                        targets.some((node) => node.id === assignment?.target)
                          ? assignment?.target
                          : ''
                      }
                      onChange={(event) => {
                        const target = event.currentTarget.value;
                        setAssignments((current) => [
                          ...current.filter(
                            (item) => item.id !== layer.id && (!target || item.target !== target),
                          ),
                          ...(target ? [{ id: layer.id, target }] : []),
                        ]);
                      }}
                    >
                      <option value="">Subscriber choice only</option>
                      {targets.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.data.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {isFilter && layerIds.includes(layer.id) && graph && !targets.length && (
                    <small className="field-help">No compatible filter in the default graph.</small>
                  )}
                </div>
              );
            })}
          </fieldset>
        </details>
      )}
      {hasStashes && (
        <label className="check-control">
          <input
            type="checkbox"
            checked={privateStashes}
            disabled={busy}
            onChange={(event) => setPrivateStashes(event.currentTarget.checked)}
          />
          Make separate copies of this user’s Stashes to change their credentials
        </label>
      )}
      <details
        className="editor-advanced"
        open={!!Object.keys(member?.settings ?? {}).length || undefined}
      >
        <summary>App settings overrides</summary>
        <fieldset className="pool-assignments" disabled={busy}>
          <legend>Settings for this user</legend>
          <p className="field-help">
            Overrides apply to every graph this user receives. Inherited values follow the selected
            graph and the subscriber’s local defaults.
          </p>
          <PoolSettingFields
            value={settings}
            inheritedLabel="Selected graph"
            onChange={setSettings}
            onValidity={settingsValidity.report}
          />
        </fieldset>
      </details>
      <details
        className="editor-advanced"
        open={accounts.length > 0 || !!member?.aquifer || undefined}
      >
        <summary>Aquifer server accounts</summary>
        <fieldset className="pool-assignments" disabled={busy}>
          <legend>Aquifer servers for this user</legend>
          {accounts.map((ref) => {
            const match = observedAccount(servers, ref);
            const key = accountKey(ref);
            const server = servers.find((item) => item.id === ref.server);
            return (
              <div className="pool-assignment" key={key}>
                <div className="item-row">
                  <span className="item-content">
                    {ref.stashName && <strong>{ref.stashName}</strong>}
                    {match
                      ? `${match.server.name} · ${match.account.inbound} · ${match.account.name}`
                      : (server?.name ?? 'Aquifer server') +
                        ' · Account missing from the latest read'}
                    {(ref.host || ref.port) && (
                      <small>
                        Endpoint override {ref.host ?? ''}
                        {ref.port ? `:${ref.port}` : ''}
                      </small>
                    )}
                  </span>
                  <button
                    className="secondary-button"
                    aria-expanded={endpoint === key}
                    onClick={() => setEndpoint(endpoint === key ? '' : key)}
                  >
                    Edit entry settings
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setEndpoint('');
                      setReplacing(ref);
                    }}
                  >
                    Replace account
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      if (replacing && accountKey(replacing) === key) setReplacing(undefined);
                      setAccounts((current) => current.filter((item) => accountKey(item) !== key));
                      if (main === key) setMain('');
                      if (endpoint === key) setEndpoint('');
                    }}
                  >
                    Remove
                  </button>
                </div>
                {endpoint === key && (
                  <EditAccount
                    refValue={ref}
                    onClose={() => setEndpoint('')}
                    onSave={(updated) => {
                      setAccounts((current) =>
                        current.map((item) => (accountKey(item) === key ? updated : item)),
                      );
                      setEndpoint('');
                    }}
                  />
                )}
              </div>
            );
          })}
          {replacing && (
            <div className="pool-row-actions">
              <span>Choose a replacement for the selected account.</span>
              <button className="secondary-button" onClick={() => setReplacing(undefined)}>
                Cancel replacement
              </button>
            </div>
          )}
          <PoolAccountPicker
            key={replacing ? accountKey(replacing) : 'add'}
            servers={servers}
            assigned={[
              ...accounts,
              ...pool.members.flatMap((user) =>
                user.id === member?.id ? [] : (user.accounts ?? []),
              ),
            ]}
            replacement={replacing}
            onAdd={(ref) => {
              if (!replacing) {
                setAccounts((current) => [...current, ref]);
                return;
              }
              const previous = accountKey(replacing);
              setAccounts((current) =>
                current.map((item) => (accountKey(item) === previous ? ref : item)),
              );
              if (main === previous) setMain(accountKey(ref));
              setReplacing(undefined);
            }}
          />
          {!!accounts.length && (
            <label className="editor-field">
              <span>Main outbound</span>
              <select value={main} onChange={(event) => setMain(event.currentTarget.value)}>
                <option value="">Use the base graph’s Main outbound</option>
                {accounts.map((ref) => {
                  const match = observedAccount(servers, ref);
                  return (
                    <option key={accountKey(ref)} value={accountKey(ref)} disabled={!match}>
                      {ref.stashName ??
                        (match
                          ? `${match.server.name} · ${match.account.inbound} · ${match.account.name}`
                          : 'Missing account')}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
          {member?.aquifer && !main && (
            <label className="check-control">
              <input
                type="checkbox"
                checked={keepLegacy}
                onChange={(event) => setKeepLegacy(event.currentTarget.checked)}
              />
              Keep the previously imported Main outbound
            </label>
          )}
        </fieldset>
      </details>
      {saveError && (
        <p className="notice notice--error" role="alert">
          {saveError}
        </p>
      )}
    </Dialog>
  );
}
