import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Folder, Layers, Plus, Send, Settings, Users, Waves } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Dialog from '../components/Dialog';
import useFieldValidity from '../components/useFieldValidity';
import { PoolSettingFields } from './PoolSettingFields';
import { poolSettingKeys, type PoolSettings } from '../graph/poolSettings';
import { errorText } from '../serviceClient';
import { layerNames, parseTransfer, type PoolTransfer } from './layers';
import {
  deliveryPending,
  getLayer,
  mayHaveDelivery,
  putLayer,
  removeLayer,
  reserveDelivery,
  setLayerUsers,
} from './management';
import { exportFile } from '../exportFile';
import {
  NewLayer,
  DeleteLayer,
  DeliveryAction,
  DeliveryPreview,
  InvitationReady,
  DuplicateLayer,
} from './PoolManagementDialogs';
import PoolViews, { userCount, type PoolView } from './PoolViews';
import PoolLayerAssignments from './PoolLayerAssignments';
import PoolInbox from './PoolInbox';
import { accountRevision, readObservedServers, type ObservedServer } from './accounts';
import {
  copyPoolInvitation,
  simulatePoolInvitation,
  createPoolInvite,
  prepareDelivery,
  preparePublication,
  completeDelivery,
  readDeliveryDigest,
  recoverDelivery,
  readPublishers,
  writeDelivery,
  writePublishers,
  type DeliveryTransition,
  type Member,
  type Publisher,
} from './publisher';
import PoolUserDialog from './PoolUserDialog';
import PoolFilterEditor from './PoolFilterEditor';
import { PoolGraphEditor, PoolStashEditor } from './PoolLayerEditors';
import { openGraphLayer, type PoolGraphStarter } from './graphLayer';
import { capturePoolGraph } from './model';
import { resolveGraphLinks } from './graphLinks';
import { isPoolShare } from './invitation';
import { copyLayer, withPrivateStashes } from './copy';
import { isDeviceLayer, type DeviceLayerData } from './deviceLayers';
import PoolDeviceLayerEditor from './PoolDeviceLayerEditor';

export type PoolModal =
  | { kind: 'settings'; pool?: Publisher }
  | { kind: 'import'; id: string; data: PoolTransfer; fromFile?: boolean }
  | { kind: 'user'; member?: Member; firstDelivery?: boolean; template?: Member }
  | { kind: 'invalid-export'; id: string }
  | { kind: 'edit-filter'; id: string; draft?: Extract<PoolTransfer, { kind: 'traffic' | 'dns' }> }
  | { kind: 'edit-device'; id: string; draft?: DeviceLayerData & { name: string } }
  | { kind: 'new-layer'; firstGraph?: boolean }
  | { kind: 'inbox' }
  | { kind: 'assign-layer'; id: string }
  | { kind: 'graph-settings'; id: string }
  | { kind: 'delete-layer'; id: string }
  | { kind: 'duplicate-layer'; id: string }
  | { kind: 'delete-pool' }
  | { kind: 'withdraw'; member?: Member }
  | { kind: 'resume' }
  | { kind: 'rotate'; member: Member }
  | { kind: 'preview'; member: Member; allowPublish?: boolean }
  | { kind: 'invitation'; memberId: string }
  | { kind: 'edit-graph'; id: string; name?: string; starter?: PoolGraphStarter }
  | { kind: 'edit-stash'; id: string; name?: string }
  | { kind: 'revoke'; member: Member }
  | { kind: 'layer'; id: string; name: string };

const navigation = [
  { key: 'layers', name: 'Layers', Icon: Layers },
  { key: 'users', name: 'Users', Icon: Users },
  { key: 'publish', name: 'Publishing', Icon: Send },
] as const;
const inboxIds = () => invoke<string[]>('pool_inbox');
const withMember = (pool: Publisher, member: Member): Publisher => ({
  ...pool,
  members: pool.members.map((item) => (item.id === member.id ? member : item)),
});

export default function PoolWorkspace() {
  const [pools, setPools] = useState<Publisher[]>();
  const savedPools = useRef<Publisher[]>([]);
  const [inbox, setInbox] = useState<string[]>([]);
  const inboxState = useRef<{ accepted?: Set<string>; read: number }>({ read: 0 });
  const [servers, setServers] = useState<ObservedServer[]>([]);
  const [accountError, setAccountError] = useState('');
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<PoolView>('layers');
  const [assignedLayerId, setAssignedLayerId] = useState<string>();
  const [modal, setModal] = useState<PoolModal>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [message, setMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const operation = useRef(false);
  const pool = pools?.find((item) => item.id === selected) ?? pools?.[0];
  const assignedLayer = pool && assignedLayerId ? getLayer(pool, assignedLayerId) : undefined;
  const managedLayer = pool && modal && 'id' in modal ? getLayer(pool, modal.id) : undefined;
  const editingFilter =
    modal?.kind === 'edit-filter'
      ? modal.draft
        ? { id: modal.id, name: modal.draft.name, data: modal.draft }
        : pool?.layers?.find((layer) => layer.id === modal.id)
      : undefined;
  const readyToPublish = (member: Member) => deliveryPending(member, servers);
  const editingDevice = modal?.kind === 'edit-device' ? (modal.draft ?? managedLayer) : undefined;
  const pending = pool?.members.filter(readyToPublish) ?? [];
  const firstDelivery = pool?.members.find(
    (member) => !!member.configurationId && !member.withdrawn && !member.deliveryTransition,
  );
  const invitation =
    modal?.kind === 'invitation'
      ? pool?.members.find(({ id }) => id === modal.memberId)
      : undefined;
  const setup =
    pool && !pool.members.some((member) => !!member.publishedAt)
      ? !pool.configurations.length
        ? 'graph'
        : !firstDelivery
          ? 'user'
          : 'publish'
      : undefined;

  const refreshInbox = useCallback(async () => {
    const state = inboxState.current;
    const accepted = state.accepted;
    if (!accepted) return;
    const read = ++state.read;
    const pending = [...accepted];
    const discarded = await Promise.allSettled(pending.map((id) => invoke('pool_discard', { id })));
    const ids = await inboxIds();
    if (read !== state.read) return;
    setInbox(ids.filter((id) => !accepted.has(id)));
    // Keep failed receipts and retry when the inbox next refreshes.
    discarded.forEach((result, index) => {
      if (result.status === 'fulfilled') accepted.delete(pending[index]);
    });
  }, []);

  useEffect(() => {
    const state = inboxState.current;
    let active = true;
    const updateInbox = () =>
      void refreshInbox().catch((reason: unknown) => {
        if (active) setFailure(errorText(reason));
      });
    void readPublishers()
      .then(async ({ pools: items, acceptedImports: accepted }) => {
        if (!active) return;
        state.accepted = new Set(accepted);
        updateInbox();
        const recovered: Publisher[] = [];
        const errors: string[] = [];
        let changed = false;
        for (const item of items) {
          let pool = item;
          for (const member of item.members) {
            if (!active) return;
            try {
              const next = await recoverDelivery(pool, member);
              if (next !== member) {
                pool = withMember(pool, next);
                changed = true;
              }
            } catch (reason) {
              errors.push(`${member.name} — ${errorText(reason)}`);
            }
          }
          recovered.push(pool);
        }
        if (!active) return;
        try {
          if (changed) await writePublishers(recovered, [...state.accepted]);
          if (active) {
            savedPools.current = recovered;
            setPools(recovered);
            if (errors.length) setFailure(errors.slice(0, 5).join('\n'));
          }
        } catch (reason) {
          if (active) {
            savedPools.current = items;
            setPools(items);
            setFailure(errorText(reason));
          }
        }
      })
      .catch((reason: unknown) => {
        if (active) setFailure(errorText(reason));
      });
    const updateAccounts = () =>
      void readObservedServers().then(
        (items) => {
          if (active) {
            setServers(items);
            setAccountError('');
          }
        },
        (reason: unknown) => {
          if (active) setAccountError(errorText(reason));
        },
      );
    updateAccounts();
    const subscription = listen('pool-inbox-changed', updateInbox);
    void subscription.catch((reason: unknown) => {
      if (active) setFailure(errorText(reason));
    });
    window.addEventListener('focus', updateInbox);
    window.addEventListener('focus', updateAccounts);
    return () => {
      active = false;
      state.read++;
      state.accepted = undefined;
      window.removeEventListener('focus', updateInbox);
      window.removeEventListener('focus', updateAccounts);
      void subscription.then(
        (stop) => stop(),
        () => {},
      );
    };
  }, [refreshInbox]);

  async function run(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setFailure('');
    setMessage('');
    try {
      await action();
    } catch (reason) {
      setFailure(errorText(reason));
    } finally {
      setBusy(false);
      operation.current = false;
    }
  }

  async function store(updated: Publisher[], acceptedImport?: string) {
    const state = inboxState.current;
    const pending = state.accepted;
    if (!pending) throw new Error('Pool settings are still loading.');
    await writePublishers(updated, acceptedImport ? [...pending, acceptedImport] : [...pending]);
    if (acceptedImport) {
      pending.add(acceptedImport);
      state.read++;
      setInbox((ids) => ids.filter((id) => id !== acceptedImport));
    }
    savedPools.current = updated;
    setPools(updated);
  }

  async function save(next: Publisher, acceptedImport?: string) {
    const current = savedPools.current;
    const updated = current.some((item) => item.id === next.id)
      ? current.map((item) => (item.id === next.id ? next : item))
      : [...current, next];
    await store(updated, acceptedImport);
    setSelected(next.id);
  }

  async function review(id: string) {
    if (inboxState.current.accepted?.has(id)) return;
    try {
      setModal({
        kind: 'import',
        id,
        data: parseTransfer(await invoke<string>('pool_import', { id })),
      });
    } catch (reason) {
      setModal({ kind: 'invalid-export', id });
      throw reason;
    }
  }

  async function removeImport(id: string) {
    await invoke('pool_discard', { id });
    await refreshInbox();
  }

  async function importLayer(
    data: PoolTransfer,
    transferId: string,
    name: string,
    replacement: string,
    fromFile?: boolean,
  ) {
    if (!pool || (!fromFile && inboxState.current.accepted?.has(transferId))) return;
    const id = replacement || transferId;
    await save(putLayer(pool, id, { ...data, name }), fromFile ? undefined : transferId);
    setModal(undefined);
    setView('layers');
    setMessage(`${layerNames[data.kind]} layer saved.`);
    if (!fromFile) await refreshInbox().catch(() => {});
  }

  async function recoverMember(target: Publisher, member: Member) {
    const recovered = await recoverDelivery(target, member);
    const next = recovered === member ? target : withMember(target, recovered);
    if (next !== target) await save(next);
    return { target: next, member: recovered };
  }

  async function changeDelivery(
    target: Publisher,
    member: Member,
    transition: DeliveryTransition,
    text: string | null,
  ) {
    const staged = {
      ...member,
      deliveryChanged: transition.phase === 'publishing' ? false : member.deliveryChanged,
      deliveryTransition: transition,
    };
    await save(withMember(target, staged));
    await writeDelivery(target, member, text, transition.before);
    await save(withMember(target, completeDelivery(staged, transition)));
  }

  async function publish(members: Member[]) {
    if (!pool) return;
    const latest = members.some((member) => member.accounts?.length)
      ? await readObservedServers()
      : servers;
    setServers(latest);
    const failures: string[] = [];
    let published = 0;
    for (const selected of members) {
      const current = savedPools.current.find((item) => item.id === pool.id) ?? pool;
      const saved = current.members.find((item) => item.id === selected.id);
      if (!saved) continue;
      try {
        const { target, member } = await recoverMember(current, saved);
        const reserved = reserveDelivery(member);
        const bundle = prepareDelivery(target, member, latest);
        const { transition, text } = await preparePublication(
          target,
          reserved,
          bundle,
          accountRevision(latest, member.accounts),
        );
        await changeDelivery(target, reserved, transition, text);
        published++;
      } catch (reason) {
        failures.push(`${saved.name} — ${errorText(reason)}`);
      }
    }
    if (published) setMessage(`Published ${userCount(published)}.`);
    if (failures.length)
      throw new Error(
        failures.slice(0, 5).join('\n') +
          (failures.length > 5 ? `\nAnd ${failures.length - 5} more.` : ''),
      );
  }

  async function withdraw(target: Publisher, members: readonly Member[]) {
    let removed = 0;
    const failures: string[] = [];
    for (const selected of members) {
      const current = savedPools.current.find((item) => item.id === target.id) ?? target;
      const saved = current.members.find((item) => item.id === selected.id);
      if (!saved || !mayHaveDelivery(saved)) continue;
      try {
        const { target, member } = await recoverMember(current, saved);
        if (mayHaveDelivery(member)) {
          const before = await readDeliveryDigest(target, member);
          await changeDelivery(target, member, { phase: 'withdrawing', before }, null);
        }
        removed++;
      } catch (reason) {
        failures.push(`${saved.name} — ${errorText(reason)}`);
      }
    }
    if (failures.length)
      throw new Error(`Withdrew ${userCount(removed)}.\n${failures.slice(0, 5).join('\n')}`);
    return savedPools.current.find((item) => item.id === target.id) ?? target;
  }

  const close = () => {
    if (!operation.current) {
      setModal(undefined);
      setFailure('');
    }
  };

  if (pool && modal?.kind === 'edit-graph') {
    const id = modal.id;
    return (
      <PoolGraphEditor
        bundle={pool.configurations.find((item) => item.id === modal.id)?.bundle}
        name={modal.name}
        starter={modal.starter}
        layers={pool.layers ?? []}
        onClose={close}
        onSave={async (bundle) => {
          const settings = pool.configurations.find((item) => item.id === id)?.bundle.settings;
          await save(
            putLayer(pool, id, {
              kind: 'graph',
              name: bundle.name,
              bundle: { ...bundle, settings },
            }),
          );
          setModal(undefined);
          setMessage('Graph layer saved.');
        }}
      />
    );
  }

  return (
    <div className="pool-app">
      <header className="pool-top">
        <Waves size={21} aria-hidden="true" />
        <strong>Wayrill Pool</strong>
        {!!pools?.length && (
          <button
            className="secondary-button"
            disabled={!pools || busy}
            onClick={() => setModal({ kind: 'settings' })}
          >
            <Plus size={15} /> Create Pool
          </button>
        )}
      </header>
      <aside className="pool-sidebar" aria-label="Pools">
        <h2>Pools</h2>
        {pools?.map((item) => (
          <button
            className="pool-nav-button"
            key={item.id}
            aria-current={pool?.id === item.id ? 'true' : undefined}
            disabled={busy}
            onClick={() => {
              setSelected(item.id);
              setView('layers');
              setAssignedLayerId(undefined);
              setMessage('');
              setFailure('');
            }}
          >
            <Folder size={16} aria-hidden="true" />
            <span>{item.name}</span>
          </button>
        ))}
      </aside>
      <main className="pool-main">
        {pool ? (
          <>
            <header className="pool-heading">
              <div>
                <h1>{pool.name}</h1>
                <p title={pool.folder}>{pool.folder}</p>
              </div>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => setModal({ kind: 'settings', pool })}
              >
                <Settings size={15} /> Settings
              </button>
            </header>
            <nav className="pool-navigation" aria-label="Pool workspace">
              {navigation.map(({ key, name, Icon }) => (
                <button
                  className="pool-nav-button"
                  key={key}
                  disabled={busy}
                  aria-current={view === key ? 'page' : undefined}
                  onClick={() => {
                    setView(key);
                    setFailure('');
                    setMessage('');
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                  {name}
                </button>
              ))}
            </nav>
            {setup && (
              <section className="pool-setup notice" aria-label="First delivery setup">
                <ol className="pool-setup-steps" aria-label="Setup steps">
                  <li aria-current={setup === 'graph' ? 'step' : undefined}>Routing graph</li>
                  <li aria-current={setup === 'user' ? 'step' : undefined}>First user</li>
                  <li aria-current={setup === 'publish' ? 'step' : undefined}>
                    Publish and invite
                  </li>
                </ol>
                <div className="pool-setup-next">
                  <div>
                    <h2>
                      {setup === 'graph'
                        ? 'Choose a starting graph'
                        : setup === 'user'
                          ? 'Set up the first user'
                          : 'Publish the first delivery'}
                    </h2>
                    <p>
                      {setup === 'graph'
                        ? 'The starter routes Proxy and TUN traffic directly. Design or import a graph if you want a server or rules in place first.'
                        : setup === 'user'
                          ? 'Give the first user access to a graph. You can add more graphs, layers and server accounts later.'
                          : 'Check what the first user will receive, then publish their invitation.'}
                    </p>
                  </div>
                  <div className="action-row">
                    {setup === 'graph' ? (
                      <>
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => fileInput.current?.click()}
                        >
                          Import graph file…
                        </button>
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => setModal({ kind: 'new-layer', firstGraph: true })}
                        >
                          Design graph…
                        </button>
                        <button
                          className="primary-button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const { graph, stash } = openGraphLayer(undefined, 'traffic');
                              const bundle = capturePoolGraph('Main routing', graph, stash, []);
                              await save(
                                putLayer(pool, crypto.randomUUID(), {
                                  kind: 'graph',
                                  name: bundle.name,
                                  bundle,
                                }),
                              );
                              setView('users');
                              setModal({ kind: 'user', firstDelivery: true });
                            })
                          }
                        >
                          Use starter graph
                        </button>
                      </>
                    ) : setup === 'user' ? (
                      <button
                        className="primary-button"
                        disabled={busy}
                        onClick={() => {
                          const member = pool.members.find((item) => !item.withdrawn);
                          setView('users');
                          setModal({ kind: 'user', member, firstDelivery: true });
                        }}
                      >
                        {pool.members.some((item) => !item.withdrawn)
                          ? 'Choose a graph for the user…'
                          : 'Add first user…'}
                      </button>
                    ) : (
                      firstDelivery && (
                        <button
                          className="primary-button"
                          disabled={busy}
                          onClick={() => {
                            setView('publish');
                            setModal({
                              kind: 'preview',
                              member: firstDelivery,
                              allowPublish: true,
                            });
                          }}
                        >
                          Review delivery…
                        </button>
                      )
                    )}
                  </div>
                </div>
              </section>
            )}
            {!!inbox.length && (
              <div className="notice pool-inbox">
                <span>
                  {inbox.length} incoming {inbox.length === 1 ? 'export' : 'exports'} from Wayrill
                </span>
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => setModal({ kind: 'inbox' })}
                >
                  Review exports
                </button>
              </div>
            )}
            {message && (
              <p className="notice pool-feedback" role="status">
                {message}
              </p>
            )}
            {failure && !modal && (
              <p className="notice notice--error pool-operation-error pool-feedback" role="alert">
                {failure}
              </p>
            )}
            {!(setup === 'graph' && view === 'layers' && !pool.layers?.length) && (
              <PoolViews
                key={pool.id + ':' + view}
                view={view}
                pool={pool}
                busy={busy}
                accountError={accountError}
                open={setModal}
                go={setView}
                assignedLayer={
                  assignedLayer && assignedLayerId
                    ? { id: assignedLayerId, name: assignedLayer.name }
                    : undefined
                }
                showLayerUsers={(id) => {
                  setAssignedLayerId(id);
                  setView('users');
                }}
                clearLayerUsers={() => setAssignedLayerId(undefined)}
                importFile={() => fileInput.current?.click()}
                refresh={() =>
                  void run(async () => {
                    const items = await readObservedServers();
                    setServers(items);
                    setAccountError('');
                    setMessage(
                      items.length
                        ? 'Aquifer accounts refreshed.'
                        : 'Read a server configuration in Aquifer to make its accounts available.',
                    );
                  })
                }
                pending={pending}
                publish={(members) => void run(() => publish(members))}
                recheck={(member) =>
                  void run(async () => {
                    await recoverMember(pool, member);
                    setMessage(`Delivery for ${member.name} checked.`);
                  })
                }
                simulate={(member) => void run(() => simulatePoolInvitation(pool, member))}
                copy={(member) =>
                  void run(async () => {
                    await copyPoolInvitation(pool, member);
                    setMessage(`Invitation for ${member.name} copied.`);
                  })
                }
              />
            )}
          </>
        ) : (
          <section className="pool-empty">
            <Waves size={40} aria-hidden="true" />
            <h1>{pools ? 'Create your first Pool' : 'Wayrill Pool'}</h1>
            <p>
              {pools
                ? 'Choose where to publish, set up routing for one user, and give them an invitation.'
                : failure
                  ? 'Could not open saved Pool settings.'
                  : 'Opening saved Pools…'}
            </p>
            {!!inbox.length && (
              <p>
                {inbox.length} incoming {inbox.length === 1 ? 'export is' : 'exports are'} ready to
                review after setup.
              </p>
            )}
            <button
              className="primary-button"
              disabled={!pools || busy}
              onClick={() => setModal({ kind: 'settings' })}
            >
              Create Pool
            </button>
          </section>
        )}
        <input
          hidden
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          aria-label="Pool layer file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file)
              void run(async () => {
                if (file.size > 16 * 1024 * 1024) throw new Error('The layer file exceeds 16 MiB.');
                setModal({
                  kind: 'import',
                  id: crypto.randomUUID(),
                  data: parseTransfer(await file.text()),
                  fromFile: true,
                });
              });
          }}
        />
        {!pool && message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        {!pool && failure && !modal && (
          <p className="notice notice--error pool-operation-error" role="alert">
            {failure}
          </p>
        )}
      </main>
      {modal?.kind === 'settings' && (
        <PoolSettings
          pool={modal.pool}
          busy={busy}
          failure={failure}
          onClose={close}
          onDelete={modal.pool ? () => setModal({ kind: 'delete-pool' }) : undefined}
          onSave={(settings) =>
            void run(async () => {
              if (settings.folder !== modal.pool?.folder)
                await invoke('pool_validate_folder', { folder: settings.folder });
              const next = {
                ...(modal.pool ?? { id: crypto.randomUUID(), configurations: [], members: [] }),
                ...settings,
              };
              if (modal.pool && settings.name !== modal.pool.name)
                next.members = next.members.map((member) => ({ ...member, deliveryChanged: true }));
              await save(next);
              setModal(undefined);
              if (!modal.pool) {
                setView('layers');
                setAssignedLayerId(undefined);
              }
            })
          }
        />
      )}
      {modal?.kind === 'inbox' && (
        <PoolInbox
          ids={inbox}
          busy={busy}
          onClose={close}
          onReview={(id) => void run(() => review(id))}
        />
      )}
      {pool && modal?.kind === 'import' && (
        <LayerImport
          pool={pool}
          data={modal.data}
          busy={busy}
          failure={failure}
          onClose={close}
          onDiscard={
            modal.fromFile
              ? undefined
              : () =>
                  void run(async () => {
                    await removeImport(modal.id);
                    setModal(undefined);
                  })
          }
          onSave={(name, id) =>
            void run(() => importLayer(modal.data, modal.id, name, id, modal.fromFile))
          }
        />
      )}
      {pool && modal?.kind === 'user' && (
        <PoolUserDialog
          pool={pool}
          member={modal.member}
          template={modal.template}
          firstDelivery={modal.firstDelivery}
          servers={servers}
          busy={busy}
          saveError={failure}
          onClose={close}
          onSave={(member, privateStashes) =>
            void run(async () => {
              const prepared = privateStashes ? withPrivateStashes(pool, member) : { pool, member };
              member = prepared.member;
              await save({
                ...prepared.pool,
                members: modal.member
                  ? pool.members.map((item) => (item.id === member.id ? member : item))
                  : [...pool.members, member],
              });
              if (modal.firstDelivery) {
                setView('publish');
                setModal({ kind: 'preview', member, allowPublish: true });
              } else {
                const copied = privateStashes
                  ? prepared.pool.layers?.find(
                      (layer) =>
                        !pool.layers?.some(({ id }) => id === layer.id) &&
                        layer.data.kind === 'stash',
                    )
                  : undefined;
                setModal(copied ? { kind: 'edit-stash', id: copied.id } : undefined);
                setMessage(
                  copied
                    ? 'User saved. Edit their copied Stash credentials, then save the Stash.'
                    : 'User delivery saved.',
                );
              }
            })
          }
        />
      )}
      {pool && managedLayer && modal?.kind === 'duplicate-layer' && (
        <DuplicateLayer
          pool={pool}
          layer={managedLayer}
          busy={busy}
          failure={failure}
          onClose={close}
          onDuplicate={(name) =>
            void run(async () => {
              const copied = copyLayer(pool, modal.id, name);
              await save(copied.pool);
              setView('layers');
              setModal({
                kind:
                  managedLayer.kind === 'graph'
                    ? 'edit-graph'
                    : managedLayer.kind === 'stash'
                      ? 'edit-stash'
                      : isDeviceLayer(managedLayer)
                        ? 'edit-device'
                        : 'edit-filter',
                id: copied.id,
              });
            })
          }
        />
      )}
      {pool && modal?.kind === 'new-layer' && (
        <NewLayer
          pool={pool}
          firstGraph={modal.firstGraph}
          onClose={close}
          onCreate={(draft) => {
            const id = crypto.randomUUID();
            if (draft.kind === 'graph') {
              setView('layers');
              setModal({ kind: 'edit-graph', id, name: draft.name, starter: draft.starter });
            } else if (draft.kind === 'stash')
              setModal({ kind: 'edit-stash', id, name: draft.name });
            else if (draft.kind === 'loopback' || draft.kind === 'app-protection')
              setModal({ kind: 'edit-device', id, draft });
            else setModal({ kind: 'edit-filter', id, draft });
          }}
        />
      )}
      {pool && modal?.kind === 'preview' && (
        <DeliveryPreview
          pool={pool}
          member={modal.member}
          servers={servers}
          busy={busy}
          failure={failure}
          onClose={close}
          onEdit={() => {
            setFailure('');
            setModal({ kind: 'user', member: modal.member, firstDelivery: !!setup });
          }}
          onPublish={
            modal.allowPublish
              ? () =>
                  void run(async () => {
                    await publish([modal.member]);
                    setView('publish');
                    setModal({ kind: 'invitation', memberId: modal.member.id });
                  })
              : undefined
          }
        />
      )}
      {pool && invitation && (
        <InvitationReady
          pool={pool}
          member={invitation}
          busy={busy}
          failure={failure}
          onClose={close}
          onCopy={() =>
            void run(async () => {
              await copyPoolInvitation(pool, invitation);
              setMessage(`Invitation for ${invitation.name} copied.`);
            })
          }
          copied={message === `Invitation for ${invitation.name} copied.`}
          onTest={() => void run(() => simulatePoolInvitation(pool, invitation))}
        />
      )}
      {pool && modal?.kind === 'edit-stash' && (
        <PoolStashEditor
          key={modal.id}
          name={
            modal.name ?? pool.layers?.find((layer) => layer.id === modal.id)?.name ?? 'New Stash'
          }
          layers={(pool.layers ?? []).filter((layer) => layer.id !== modal.id)}
          servers={servers}
          stash={(() => {
            const data = pool.layers?.find((item) => item.id === modal.id)?.data;
            return data?.kind === 'stash' ? data.stash : undefined;
          })()}
          onClose={close}
          onSave={async (stash, moved) => {
            const name = modal.name ?? pool.layers?.find((item) => item.id === modal.id)?.name;
            if (!name) throw new Error('Choose a Stash layer name.');
            let next = putLayer(pool, modal.id, { kind: 'stash', name, stash });
            for (const [id, source] of moved) {
              const layer = getLayer(pool, id);
              if (!layer || layer.kind !== 'stash') throw new Error('A source Stash was removed.');
              next = putLayer(next, id, { ...layer, stash: source });
            }
            await save(next);
            setModal(undefined);
            setMessage('Stash layer saved.');
          }}
        />
      )}
      {pool && modal?.kind === 'edit-device' && editingDevice && isDeviceLayer(editingDevice) && (
        <PoolDeviceLayerEditor
          key={modal.id}
          initial={editingDevice}
          name={editingDevice.name}
          busy={busy}
          failure={failure}
          onClose={close}
          onSave={(data) =>
            void run(async () => {
              await save(putLayer(pool, modal.id, { ...data, name: editingDevice.name }));
              setView('layers');
              setModal(undefined);
              setMessage('Windows settings layer saved.');
            })
          }
        />
      )}
      {pool && editingFilter && (
        <PoolFilterEditor
          key={editingFilter.id}
          pool={pool}
          layer={editingFilter}
          onClose={close}
          onSave={async (layer) => {
            if (operation.current)
              throw new Error('Wait for the current Pool operation to finish.');
            operation.current = true;
            setBusy(true);
            try {
              await save(putLayer(pool, layer.id, { ...layer.data, name: layer.name }));
              setMessage('Layer rules saved.');
            } finally {
              operation.current = false;
              setBusy(false);
            }
          }}
        />
      )}
      {pool && modal?.kind === 'layer' && (
        <LayerSettings
          name={modal.name}
          busy={busy}
          failure={failure}
          onClose={close}
          onSave={(name) =>
            void run(async () => {
              const layer = getLayer(pool, modal.id);
              if (layer) await save(putLayer(pool, modal.id, { ...layer, name }));
              setModal(undefined);
              setMessage('Layer renamed.');
            })
          }
          onDuplicate={() => setModal({ kind: 'duplicate-layer', id: modal.id })}
          onExport={() =>
            void run(async () => {
              const layer = getLayer(pool, modal.id);
              const transfer =
                layer?.kind === 'graph'
                  ? { ...layer, bundle: resolveGraphLinks(layer.bundle, pool.layers ?? []) }
                  : layer;
              if (
                transfer &&
                (await exportFile('wayrill-pool-layer.json', JSON.stringify(transfer, null, 2)))
              ) {
                setModal(undefined);
                setMessage('Layer file exported.');
              }
            })
          }
          onAssign={() => setModal({ kind: 'assign-layer', id: modal.id })}
          onSettings={
            managedLayer?.kind === 'graph'
              ? () => setModal({ kind: 'graph-settings', id: modal.id })
              : undefined
          }
          onRemove={() => setModal({ kind: 'delete-layer', id: modal.id })}
        />
      )}
      {pool && managedLayer?.kind === 'graph' && modal?.kind === 'graph-settings' && (
        <GraphSettings
          name={managedLayer.name}
          settings={managedLayer.bundle.settings}
          busy={busy}
          failure={failure}
          onClose={close}
          onSave={(settings) =>
            void run(async () => {
              const bundle = { ...managedLayer.bundle, settings };
              await save(putLayer(pool, modal.id, { ...managedLayer, bundle }));
              setModal(undefined);
              setMessage('Graph settings saved.');
            })
          }
        />
      )}
      {pool && managedLayer && modal?.kind === 'assign-layer' && (
        <PoolLayerAssignments
          layer={managedLayer}
          id={modal.id}
          pool={pool}
          busy={busy}
          failure={failure}
          onClose={close}
          onSave={(users) =>
            void run(async () => {
              await save(setLayerUsers(pool, modal.id, users));
              setModal(undefined);
              setMessage('Assignments saved.');
            })
          }
        />
      )}
      {pool && managedLayer && modal?.kind === 'delete-layer' && (
        <DeleteLayer
          layer={managedLayer}
          id={modal.id}
          pool={pool}
          busy={busy}
          failure={failure}
          onClose={close}
          onDelete={(replacement) =>
            void run(async () => {
              await save(removeLayer(pool, modal.id, replacement));
              setModal(undefined);
              setMessage('Layer deleted.');
            })
          }
        />
      )}
      {pool && modal?.kind === 'delete-pool' && (
        <DeliveryAction
          title={`Delete ${pool.name}?`}
          label="Delete Pool"
          busy={busy}
          failure={failure}
          onClose={close}
          onConfirm={() =>
            void run(async () => {
              await withdraw(pool, pool.members);
              await store((pools ?? []).filter((item) => item.id !== pool.id));
              setSelected('');
              setAssignedLayerId(undefined);
              setView('layers');
              setModal(undefined);
              setMessage('Pool deleted.');
            })
          }
        >
          <p>
            This deletes the Pool’s layers and user assignments and withdraws its published
            deliveries. Other files in the publishing folder stay in place.
          </p>
        </DeliveryAction>
      )}
      {pool && modal?.kind === 'withdraw' && (
        <DeliveryAction
          title={
            modal.member ? `Withdraw ${modal.member.name}’s delivery?` : 'Withdraw all deliveries?'
          }
          label="Withdraw deliveries"
          busy={busy}
          failure={failure}
          onClose={close}
          onConfirm={() =>
            void run(async () => {
              const members = modal.member ? [modal.member] : pool.members.filter(mayHaveDelivery);
              await withdraw(pool, members);
              setModal(undefined);
              setMessage(members.length === 1 ? 'Delivery withdrawn.' : 'Deliveries withdrawn.');
            })
          }
        >
          <p>
            Subscribers keep their last working configuration. Use Resume publishing when their next
            delivery is ready.
          </p>
          {!modal.member && (
            <p className="field-help">
              After withdrawing every delivery, you can change the publishing folder in Pool
              settings.
            </p>
          )}
        </DeliveryAction>
      )}
      {pool && modal?.kind === 'resume' && (
        <DeliveryAction
          title="Resume withdrawn deliveries?"
          label="Publish deliveries"
          destructive={false}
          busy={busy}
          failure={failure}
          onClose={close}
          onConfirm={() =>
            void run(async () => {
              await publish(
                pool.members.filter((member) => member.withdrawn && member.configurationId),
              );
              setModal(undefined);
            })
          }
        >
          <p>
            This publishes current drafts for withdrawn users with a base graph. Subscribers whose
            access address changed need a new invitation.
          </p>
        </DeliveryAction>
      )}
      {pool && modal?.kind === 'rotate' && (
        <DeliveryAction
          title={`New invitation for ${modal.member.name}?`}
          label="Generate new invitation"
          busy={busy}
          failure={failure}
          onClose={close}
          onConfirm={() =>
            void run(async () => {
              const current = savedPools.current.find((item) => item.id === pool.id) ?? pool;
              const saved = current.members.find((item) => item.id === modal.member.id);
              if (!saved) return;
              const { target, member } = await recoverMember(current, saved);
              // A retry of the confirmation completes the saved rotation.
              if (saved.deliveryTransition?.phase !== 'rotating') {
                const hasDelivery = mayHaveDelivery(member);
                const transition: DeliveryTransition = {
                  phase: 'rotating',
                  before: hasDelivery ? await readDeliveryDigest(target, member) : null,
                  invite: createPoolInvite(),
                };
                if (hasDelivery) await changeDelivery(target, member, transition, null);
                else await save(withMember(target, completeDelivery(member, transition)));
              }
              setModal(undefined);
              setMessage(
                'New invitation prepared. Publish the delivery, then copy the invitation.',
              );
            })
          }
        >
          <p>
            This withdraws the previous delivery and replaces its access key. The user will need the
            new invitation after you publish.
          </p>
        </DeliveryAction>
      )}
      {modal?.kind === 'invalid-export' && (
        <Dialog
          title="Could not open this export"
          busy={busy}
          onClose={close}
          footer={
            <>
              <button className="secondary-button" disabled={busy} onClick={close}>
                Close
              </button>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await removeImport(modal.id);
                    setModal(undefined);
                  })
                }
              >
                Discard export
              </button>
            </>
          }
        >
          <Failure text={failure} />
        </Dialog>
      )}
      {pool && modal?.kind === 'revoke' && (
        <Dialog
          title={`Remove ${modal.member.name}?`}
          busy={busy}
          onClose={close}
          footer={
            <>
              <button className="secondary-button" disabled={busy} onClick={close}>
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const updated = await withdraw(pool, [modal.member]);
                    await save({
                      ...updated,
                      members: updated.members.filter((item) => item.id !== modal.member.id),
                    });
                    setModal(undefined);
                    setMessage('User removed.');
                  })
                }
              >
                Remove user
              </button>
            </>
          }
        >
          <p>
            This withdraws their Pool file. Previously received server credentials stay valid until
            revoked on the server.
          </p>
          <Failure text={failure} />
        </Dialog>
      )}
    </div>
  );
}

function Failure({ text }: { text: string }) {
  return text ? (
    <p role="alert" className="notice notice--error">
      {text}
    </p>
  ) : null;
}
type FormProps = { busy: boolean; failure: string; onClose: () => void };
function PoolSettings({
  pool,
  busy,
  failure,
  onClose,
  onSave,
  onDelete,
}: FormProps & {
  pool?: Publisher;
  onDelete?: () => void;
  onSave: (value: Pick<Publisher, 'name' | 'folder' | 'url' | 'subscriberFolder'>) => void;
}) {
  const [name, setName] = useState(pool?.name ?? '');
  const [folder, setFolder] = useState(pool?.folder ?? '');
  const [url, setUrl] = useState(pool?.url ?? '');
  const [share, setShare] = useState(pool?.subscriberFolder ?? '');
  const [access, setAccess] = useState(
    pool?.url ? 'https' : pool?.subscriberFolder ? 'share' : 'local',
  );
  const [error, setError] = useState('');
  const [choosing, setChoosing] = useState(false);
  const locked = pool?.members.some(mayHaveDelivery);
  const save = () => {
    setError('');
    if (access === 'share' && !isPoolShare(share.trim())) {
      setError('Enter the network path of the Windows share.');
      return;
    }
    if (access === 'https') {
      try {
        const value = new URL(url.trim());
        if (
          value.protocol !== 'https:' ||
          value.username ||
          value.password ||
          value.search ||
          value.hash
        )
          throw new Error();
      } catch {
        setError('Enter an HTTPS folder URL without credentials, a query or a fragment.');
        return;
      }
    }
    onSave({
      name: name.trim(),
      folder: folder.trim(),
      url: access === 'https' ? url.trim() : undefined,
      subscriberFolder: access === 'share' ? share.trim() : undefined,
    });
  };
  return (
    <Dialog
      title={pool ? 'Pool settings' : 'Create Pool'}
      busy={busy || choosing}
      onClose={onClose}
      footer={
        <>
          {onDelete && (
            <button
              className="secondary-button button--danger"
              disabled={busy || choosing}
              onClick={onDelete}
            >
              Delete Pool…
            </button>
          )}
          <button className="secondary-button" disabled={busy || choosing} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy || choosing || !name.trim() || !folder.trim()}
            onClick={save}
          >
            {pool ? 'Save settings' : 'Create Pool'}
          </button>
        </>
      }
    >
      <label className="editor-field">
        <span>Pool name</span>
        <input
          autoFocus
          value={name}
          maxLength={128}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <div className="pool-path-row">
        <label className="editor-field">
          <span>Publishing folder</span>
          <input
            value={folder}
            readOnly={!!locked}
            maxLength={2048}
            onChange={(event) => setFolder(event.currentTarget.value)}
          />
        </label>
        {!locked && (
          <button
            className="secondary-button"
            disabled={busy || choosing}
            onClick={() => {
              setChoosing(true);
              setError('');
              void invoke<string | null>('pool_folder')
                .then((value) => {
                  if (value) setFolder(value);
                })
                .catch((reason: unknown) => setError(errorText(reason)))
                .finally(() => setChoosing(false));
            }}
          >
            Choose folder…
          </button>
        )}
      </div>
      {!pool && (
        <p className="field-help">
          Choose a local folder where Wayrill can write the encrypted deliveries.
        </p>
      )}
      {locked && (
        <p className="field-help">
          To move the folder, withdraw the existing deliveries in Publishing. Give subscribers new
          invitations if their access address changes.
        </p>
      )}
      <label className="editor-field">
        <span>How will subscribers reach this Pool?</span>
        <select
          value={access}
          onChange={(event) => {
            setAccess(event.currentTarget.value);
            setError('');
          }}
        >
          <option value="local">On this computer</option>
          <option value="share">Through a Windows share</option>
          <option value="https">Through HTTPS</option>
        </select>
      </label>
      {access === 'share' && (
        <>
          <label className="editor-field">
            <span>Network share address</span>
            <input
              value={share}
              placeholder={'\\\\server\\WayrillPool'}
              maxLength={2048}
              onChange={(event) => {
                setShare(event.currentTarget.value);
                setError('');
              }}
            />
          </label>
          <p className="field-help">
            Use the network path to the publishing folder. Subscribers need read access.
          </p>
        </>
      )}
      {access === 'https' && (
        <>
          <label className="editor-field">
            <span>Subscriber URL</span>
            <input
              value={url}
              placeholder="https://example.com/pool/"
              maxLength={2048}
              onChange={(event) => {
                setUrl(event.currentTarget.value);
                setError('');
              }}
            />
          </label>
          <p className="field-help">Use the HTTPS address that serves the publishing folder.</p>
        </>
      )}
      <Failure text={error || failure} />
    </Dialog>
  );
}
function LayerImport({
  pool,
  data,
  busy,
  failure,
  onClose,
  onDiscard,
  onSave,
}: FormProps & {
  pool: Publisher;
  data: PoolTransfer;
  onDiscard?: () => void;
  onSave: (name: string, id: string) => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState(data.name);
  const options =
    data.kind === 'graph'
      ? pool.configurations.map((item) => ({ id: item.id, name: item.bundle.name }))
      : (pool.layers?.filter((item) => item.data.kind === data.kind) ?? []);
  return (
    <Dialog
      title={`Review ${layerNames[data.kind].toLowerCase()} export`}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          {onDiscard && (
            <button className="secondary-button" disabled={busy} onClick={onDiscard}>
              Discard export
            </button>
          )}
          <button className="secondary-button" disabled={busy} onClick={onClose}>
            {onDiscard ? 'Review later' : 'Cancel'}
          </button>
          <button
            className="primary-button"
            disabled={busy || !name.trim()}
            onClick={() => onSave(name.trim(), id)}
          >
            {id ? 'Replace layer' : 'Add layer'}
          </button>
        </>
      }
    >
      <p>
        Add <strong>{data.name}</strong> to <strong>{pool.name}</strong>.
      </p>
      {!!options.length && (
        <label className="editor-field">
          <span>Save as</span>
          <select
            value={id}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setId(next);
              setName(options.find((item) => item.id === next)?.name ?? data.name);
            }}
          >
            <option value="">New layer</option>
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="editor-field">
        <span>Layer name</span>
        <input
          value={name}
          maxLength={128}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {id && (
        <p className="field-help">
          Users assigned to this layer will receive the replacement at the next publication.
        </p>
      )}
      <Failure text={failure} />
    </Dialog>
  );
}
function LayerSettings({
  name,
  busy,
  failure,
  onClose,
  onSave,
  onRemove,
  onDuplicate,
  onAssign,
  onExport,
  onSettings,
}: FormProps & {
  name: string;
  onSave: (name: string) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onAssign: () => void;
  onExport: () => void;
  onSettings?: () => void;
}) {
  const [draft, setDraft] = useState(name);
  return (
    <Dialog
      title="Manage layer"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button button--danger" disabled={busy} onClick={onRemove}>
            Delete layer…
          </button>
          <button className="secondary-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy || !draft.trim() || draft.trim() === name}
            onClick={() => onSave(draft.trim())}
          >
            Save name
          </button>
        </>
      }
    >
      <label className="editor-field">
        <span>Layer name</span>
        <input
          autoFocus
          value={draft}
          maxLength={128}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      </label>
      <div className="pool-row-actions">
        <button className="secondary-button" disabled={busy} onClick={onAssign}>
          Assign users…
        </button>
        {onSettings && (
          <button className="secondary-button" disabled={busy} onClick={onSettings}>
            Graph settings…
          </button>
        )}
        <button className="secondary-button" disabled={busy} onClick={onDuplicate}>
          Duplicate layer
        </button>
        <button className="secondary-button" disabled={busy} onClick={onExport}>
          Export layer file…
        </button>
      </div>
      <p className="field-help">
        A duplicate starts without user assignments. Exported layer files can contain plaintext
        credentials.
      </p>
      <Failure text={failure} />
    </Dialog>
  );
}

function GraphSettings({
  name,
  settings,
  busy,
  failure,
  onClose,
  onSave,
}: FormProps & {
  name: string;
  settings?: PoolSettings;
  onSave: (settings?: PoolSettings) => void;
}) {
  const [draft, setDraft] = useState(settings ?? {});
  const validity = useFieldValidity();
  const changed = poolSettingKeys.some((key) => draft[key] !== settings?.[key]);
  return (
    <Dialog
      title={`Graph settings for ${name}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="secondary-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy || validity.blocked || !changed}
            onClick={() => onSave(Object.keys(draft).length ? draft : undefined)}
          >
            Save graph settings
          </button>
        </>
      }
    >
      <p className="field-help">
        These settings take effect when this graph is selected and a delivery is published.
        Individual user overrides take precedence.
      </p>
      <fieldset className="pool-assignments" disabled={busy}>
        <legend>Published defaults</legend>
        <PoolSettingFields
          value={draft}
          inheritedLabel="Subscriber setting"
          onChange={setDraft}
          onValidity={validity.report}
        />
      </fieldset>
      <Failure text={failure} />
    </Dialog>
  );
}
