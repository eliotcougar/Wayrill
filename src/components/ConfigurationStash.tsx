import { OutboundTestsContext, OutboundTestSummary } from '../useOutboundTests';
import StashStar from './StashStar';
import OutboundTestButtons from './OutboundTestButtons';
import SubscriptionGroups from './SubscriptionGroups';
import {
  refreshSubscriptionGroups,
  type RefreshProgress,
} from '../profiles/subscriptionManagement';
import SubscriptionSettingsForm, { type SubscriptionSubmission } from './SubscriptionSettingsForm';
import { SubscriptionMaintenanceContext } from '../profiles/useSubscriptionMaintenance';
import { entryAvailable, setGroupMaintenance } from '../profiles/subscriptionState';
import { readImportText } from '../importText';
import StashEntryEditor from './StashEntryEditor';
import {
  DEFAULT_GROUP_ID,
  stashRows,
  entryIsPrepared,
  entryLink,
  findStashEntry,
  putStashEntry,
  removeStashEntries,
  lockStashEntry,
  starStashEntry,
  type StashEntryEdit,
} from '../profiles/stashModel';
import { exportFile } from '../exportFile';
import PreparedOutboundLibrary from './PreparedOutboundLibrary';
import { EditorTabs, EditorTabPanels, useEditorTabs } from './EditorTabs';
import ResultPager from './ResultPager';
import { libraryRows, libraryTerm, searchLibrary } from '../profiles/library';
import { refreshStashComposites, readPolicySources } from '../graph/policySources';
import type { GraphState, StashLink } from '../graph/types';
import useModalDialog from './useModalDialog';
import {
  useContext,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Archive,
  Download,
  Plus,
  RefreshCw,
  Replace,
  Trash2,
  Upload,
  X,
  Pencil,
  LockKeyhole,
  LockKeyholeOpen,
} from 'lucide-react';
import { protectedStorageAvailable } from '../protectedStorage';
import { MAX_STASH, serializeStash, type StashEntry, type StashGroup } from '../profiles/import';
import type useStash from '../profiles/useStash';
type Props = {
  store: ReturnType<typeof useStash>;
  replaceLabel?: string;
  replacementConnections?: number;
  graph?: GraphState;
  onUse: (entry: StashEntry, replace: boolean, link: StashLink) => void;
  onClose: () => void;
};
const PAGE = 60;
export default function ConfigurationStash({
  store,
  replaceLabel,
  replacementConnections = 0,
  graph,
  onUse,
  onClose,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null),
    file = useRef<HTMLInputElement>(null),
    importTrigger = useRef<HTMLButtonElement>(null),
    operationFocus = useRef<HTMLElement | null>(null),
    restoreOperationFocus = useRef(false);
  const [groupId, setGroupId] = useState('all'),
    [query, setQuery] = useState(''),
    [preparedQuery, setPreparedQuery] = useState(''),
    [page, setPage] = useState(0),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [editor, setEditor] = useState<{ group?: StashGroup } | null>(null);
  const [removeId, setRemoveId] = useState('');
  const [batch, setBatch] = useState<RefreshProgress | null>(null);
  const batchRef = useRef<RefreshProgress | null>(null);
  const [groupProblems, setGroupProblems] = useState<Record<string, string>>({});
  const editorTrigger = useRef<HTMLElement | null>(null);
  const latestGraph = useRef(graph);
  latestGraph.current = graph;
  const [chosen, setChosen] = useState<{
    groupId: string;
    entryId: string;
  } | null>(null);
  const [tab, setTab] = useState<'outbounds' | 'policyGroups' | 'proxyChains' | 'subscriptions'>(
    'outbounds',
  );
  const tabs = useEditorTabs(
    [
      { key: 'outbounds', label: 'Outbounds' },
      { key: 'policyGroups', label: 'Policy groups' },
      { key: 'proxyChains', label: 'Proxy chains' },
      { key: 'subscriptions', label: 'Subscriptions' },
    ] as const,
    tab,
    (value) => {
      setTab(value);
      setError('');
      setPreparedQuery('');
      setChosen(null);
      setEditor(null);
    },
  );
  const outboundTests = useContext(OutboundTestsContext);
  const maintenance = useContext(SubscriptionMaintenanceContext);
  const [availability, setAvailability] = useState('all');
  const candidate = chosen ? findStashEntry(store.stash, chosen) : undefined;
  const [editingEntry, setEditingEntry] = useState<StashEntryEdit>();
  const policies = useMemo(() => stashRows(store.stash, 'policy-group'), [store.stash]);
  const chains = useMemo(() => stashRows(store.stash, 'proxy-chain'), [store.stash]);
  const choiceId = useId();
  const importFormId = useId();
  const deferred = useDeferredValue(libraryTerm(query)),
    pending = deferred !== libraryTerm(query);
  const operation = useRef<AbortController | null>(null),
    updateFile = useRef<StashGroup | undefined>(undefined);
  useEffect(
    () => () => {
      operation.current?.abort(new DOMException('View closed.', 'ViewClosed'));
      operation.current = null;
    },
    [],
  );
  useLayoutEffect(() => {
    if (busy || !restoreOperationFocus.current) return;
    restoreOperationFocus.current = false;
    // Disabled or removed action controls lose focus. Do not disturb a user who
    // navigated to another control while the operation was pending.
    if (document.activeElement !== document.body) return;
    const origin = operationFocus.current;
    const target =
      origin?.isConnected && dialog.current?.contains(origin) && !origin.matches(':disabled')
        ? origin
        : importTrigger.current;
    target?.focus();
  }, [busy, editor]);
  useModalDialog(dialog);
  const groups = store.stash.groups;
  const subscriptionCount = groups.filter((group) => group.id !== DEFAULT_GROUP_ID).length;
  const subscriptionSummary = `${subscriptionCount.toLocaleString()} subscription ${subscriptionCount === 1 ? 'group' : 'groups'}`;
  const indexed = useMemo(
    () => libraryRows(groups).filter((row) => !entryIsPrepared(row.entry)),
    [groups],
  );
  const filtered = useMemo(
    () =>
      searchLibrary(indexed, deferred, groupId === 'all' ? '' : groupId).filter(
        ({ entry }) => availability === 'all' || entryAvailable(entry),
      ),
    [indexed, groupId, deferred, availability],
  );
  const preparedTerm = useDeferredValue(libraryTerm(preparedQuery));
  const preparedPending = preparedTerm !== libraryTerm(preparedQuery);
  const testEntries = useMemo(
    () =>
      tab === 'outbounds'
        ? filtered.map((row) => row.entry)
        : (tab === 'policyGroups' ? policies : chains)
            .filter((row) => !preparedTerm || libraryTerm(row.entry.name).includes(preparedTerm))
            .map((row) => row.entry),
    [tab, filtered, policies, chains, preparedTerm],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE)),
    currentPage = Math.min(page, pages - 1),
    rows = filtered.slice(currentPage * PAGE, (currentPage + 1) * PAGE);
  const selectedGroup = groups.find((g) => g.id === groupId),
    total = indexed.length;
  const removingGroup = groups.find((group) => group.id === removeId);
  useLayoutEffect(() => {
    if (removeId)
      dialog.current?.querySelector<HTMLElement>('.stash-remove-confirmation button')?.focus();
  }, [removeId]);
  function cancelOperation() {
    restoreOperationFocus.current = true;
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    const progress = batchRef.current;
    setNotice(
      progress
        ? `Refresh cancelled: ${progress.updated.length} updated · ${progress.failed.length} failed · ${progress.total - progress.completed} not completed.`
        : 'Operation cancelled. Existing configurations were preserved.',
    );
  }
  async function perform(action: (signal: AbortSignal) => void | Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    operationFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(true);
    setError('');
    setNotice('');
    batchRef.current = null;
    setBatch(null);
    try {
      if (maintenance)
        await maintenance.withForeground(() => action(controller.signal), controller.signal);
      else await action(controller.signal);
    } catch (e) {
      if (operation.current === controller) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        restoreOperationFocus.current = true;
        setBusy(false);
      }
    }
  }
  async function accept(
    text: string,
    title: string,
    previous: StashGroup | undefined,
    signal: AbortSignal,
    report = true,
  ) {
    signal.throwIfAborted();
    const oldIds = new Set(store.get().groups.map((group) => group.id));
    const affected = previous
      ? (graph?.nodes
          .filter((node) => {
            if (node.data.kind !== 'policy-group') return false;
            try {
              return readPolicySources(node.data).subscriptions.some(
                (source) => source.groupId === previous.id,
              );
            } catch {
              return false;
            }
          })
          .map((node) => node.data.label) ?? [])
      : [];
    const result = await store.importText(text, title, previous, signal, latestGraph.current);
    const { ready, retained } = result;
    const added = store.get().groups.filter((group) => !oldIds.has(group.id));
    // Explicit file loads finish their scan even when scheduled maintenance is paused.
    if (maintenance?.available)
      for (const group of previous ? [currentGroup(previous)] : added)
        if (group.maintenance?.removeUnreachable)
          await maintenance.run(group.id, 'test', undefined, signal);

    if (previous && report) {
      const summary = result.summary!;
      setNotice(
        `${previous.name} updated: ${summary.added.toLocaleString()} added · ${summary.updated.toLocaleString()} updated · ${summary.removed.toLocaleString()} removed · ${summary.unchanged.toLocaleString()} unchanged · ${summary.unsupported.toLocaleString()} unsupported.${affected.length ? ` Updated policy sets: ${affected.join(', ')}.` : ''}`,
      );
    } else if (report) {
      setNotice(
        `${added.length && !ready && !retained ? `${added.length} subscription ${added.length === 1 ? 'group' : 'groups'} imported. Refresh to load their outbounds.` : `${ready.toLocaleString()} ready · ${retained.toLocaleString()} retained without a node · ${result.duplicates} duplicates skipped · ${result.rejected} rejected.`}${result.problems.length ? ` ${result.problems.slice(0, 5).join(' ')}${result.problems.length > 5 ? ` (${result.problems.length - 5} more import notes)` : ''}` : ''}`,
      );
    }
    if (!previous) {
      setGroupId(added.length === 1 ? added[0].id : 'all');
      setTab(added.length > 1 ? 'subscriptions' : 'outbounds');
      setQuery('');
      setAvailability('all');
      setPage(0);
    }
    setEditor(null);
  }
  function currentGroup(group: StashGroup) {
    const latest = store.get().groups.find((value) => value.id === group.id);
    if (!latest) throw new Error('This subscription group was removed.');
    return latest;
  }
  async function download(group: StashGroup, signal: AbortSignal, report = true) {
    if (!protectedStorageAvailable())
      throw new Error(
        'Download subscriptions in the Windows app, or import their downloaded text here.',
      );
    const latest = currentGroup(group);
    setGroupProblems((old) => {
      const next = { ...old };
      delete next[group.id];
      return next;
    });
    try {
      if (!maintenance) throw new Error('The subscription service is unavailable.');
      await maintenance.run(latest.id, 'refresh', undefined, signal);
      if (report) setNotice(`${latest.name} updated.`);
    } catch (error) {
      if (!signal.aborted)
        setGroupProblems((old) => ({
          ...old,
          [group.id]: error instanceof Error ? error.message : String(error),
        }));
      throw error;
    }
  }
  function openEditor(group: StashGroup, trigger: HTMLElement) {
    editorTrigger.current = trigger;
    setEditor({ group });
    setError('');
    setRemoveId('');
  }
  function browse(group: StashGroup, availability = 'all') {
    setError('');
    setGroupId(group.id);
    setTab('outbounds');
    setQuery('');
    setAvailability(availability);
    setPage(0);
    setChosen(null);
  }
  async function refreshAll(signal: AbortSignal) {
    const ids = store
      .get()
      .groups.filter((group) => group.url)
      .map((group) => group.id);
    const result = await refreshSubscriptionGroups(
      ids,
      (id) => store.get().groups.find((group) => group.id === id),
      (group) => download(group, signal, false),
      signal,
      (progress) => {
        if (signal.aborted) return;
        batchRef.current = progress;
        setBatch(progress);
      },
    );
    signal.throwIfAborted();
    setNotice(
      `${result.updated.length} groups updated · ${result.failed.length} failed${result.skipped ? ` · ${result.skipped} skipped` : ''}.`,
    );
  }
  function pauseGroup(group: StashGroup) {
    const paused = !group.maintenancePaused;
    try {
      store.update((stash) => ({
        ...stash,
        groups: stash.groups.map((value) =>
          value.id === group.id ? { ...value, maintenancePaused: paused } : value,
        ),
      }));
      if (paused) maintenance?.cancelAutomatic(group.id);
      setError('');
      setNotice(`${group.name}: automatic maintenance ${paused ? 'paused' : 'resumed'}.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  async function exportGroup(group: StashGroup) {
    try {
      const selected = currentGroup(group);
      if (
        await exportFile(
          'wayrill-subscription.json',
          serializeStash({ ...store.get(), groups: [selected] }),
        )
      ) {
        setError('');
        setNotice(
          `${selected.name} exported. The file contains credentials and its subscription URL.`,
        );
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  function closeEditor() {
    if (busy) {
      cancelOperation();
      return;
    }
    const trigger = editor?.group ? editorTrigger.current : importTrigger.current;
    operationFocus.current = trigger;
    restoreOperationFocus.current = true;
    setEditor(null);
  }
  async function saveSubscription(value: SubscriptionSubmission, signal: AbortSignal) {
    if (value.kind === 'paste') {
      await accept(value.content, value.name, undefined, signal);
      return;
    }
    const { settings } = value;
    if (editor?.group) {
      const id = editor.group.id;
      store.update((current) => {
        if (!current.groups.some((group) => group.id === id && id !== DEFAULT_GROUP_ID))
          throw new Error('This subscription group no longer exists.');
        return refreshStashComposites({
          ...current,
          groups: current.groups.map((group) =>
            group.id === id
              ? setGroupMaintenance(
                  { ...group, ...settings, maintenance: group.maintenance },
                  settings.maintenance,
                )
              : group,
          ),
        });
      });
      operationFocus.current = editorTrigger.current;
      setEditor(null);
      setNotice('Subscription settings saved.');
      if (value.refresh) await download(currentGroup(editor.group), signal);
      return;
    }
    const group: StashGroup = {
      ...settings,
      id: crypto.randomUUID(),
      updatedAt: null,
      entries: [],
    };
    const next = store.importResult({ groups: [group], duplicates: 0, rejected: 0, problems: [] });
    // Import normalizes identity. Download against the committed group snapshot.
    const committed = next.groups[next.groups.length - 1];
    setGroupId(committed.id);
    setTab('outbounds');
    setQuery('');
    setAvailability('all');
    setPage(0);
    setEditor(null);
    await download(committed, signal);
  }
  function chooseEntry(entry: StashEntry, replace: boolean) {
    try {
      if (!entryAvailable(entry))
        throw new Error('This entry has no usable outbound configuration.');
      onUse(entry, replace, entryLink(store.stash, entry));
      setError('');
      if (replace) {
        onClose();
        return;
      }
      setNotice(`Added ${entry.name}. Edits are shared with Stash.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  async function exportStash() {
    try {
      if (await exportFile('wayrill-stash.json', store.serialize())) {
        setError('');
        setNotice('Stash exported. The file contains credentials and subscription URLs.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window stash-window"
      onClose={onClose}
      aria-labelledby="stash-title"
      onCancel={(e) => {
        if (busy) {
          e.preventDefault();
          cancelOperation();
        } else if (editor) {
          e.preventDefault();
          closeEditor();
        }
      }}
    >
      <div className="rule-editor-titlebar">
        <div>
          <h2 id="stash-title">
            <Archive size={19} /> {replaceLabel ? 'Replace outbound' : 'Configuration stash'}
          </h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close configuration stash"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <EditorTabs tabs={tabs} label="Stash sections" disabled={busy} />
      <div className="stash-toolbar">
        <button
          ref={importTrigger}
          aria-expanded={!!editor && !editor.group}
          aria-controls={editor && !editor.group ? importFormId : undefined}
          className="primary-button"
          disabled={busy || !store.ready || !!editor?.group}
          onClick={() => {
            setTab('outbounds');
            setEditor(editor && !editor.group ? null : {});
            setError('');
            setRemoveId('');
          }}
        >
          <Upload size={14} /> Import / add subscription
        </button>
        <button
          className="secondary-button"
          disabled={busy || !store.ready || !!editor}
          onClick={() => {
            updateFile.current = undefined;
            file.current?.click();
          }}
        >
          Import file
        </button>
        <button
          className="secondary-button"
          disabled={
            busy || !store.ready || !(total + policies.length + chains.length || groups.length > 1)
          }
          onClick={() => void exportStash()}
        >
          <Download size={14} /> Export stash
        </button>
        {tab !== 'subscriptions' && (
          <OutboundTestButtons
            entries={testEntries}
            all
            iconOnly={false}
            disabled={
              !store.ready ||
              (!outboundTests?.busy &&
                (!testEntries.length || (tab === 'outbounds' ? pending : preparedPending)))
            }
          />
        )}
        <span>
          {tab === 'subscriptions' ? (
            subscriptionSummary
          ) : (
            <>
              {(tab === 'outbounds'
                ? total
                : tab === 'policyGroups'
                  ? policies.length
                  : chains.length
              ).toLocaleString()}{' '}
              {tab === 'outbounds'
                ? total === 1
                  ? 'outbound'
                  : 'outbounds'
                : tab === 'policyGroups'
                  ? policies.length === 1
                    ? 'policy group'
                    : 'policy groups'
                  : chains.length === 1
                    ? 'proxy chain'
                    : 'proxy chains'}{' '}
              · {tab === 'outbounds' ? subscriptionSummary : 'prepared outbounds'}
            </>
          )}
        </span>
      </div>
      <input
        autoComplete="off"
        ref={file}
        type="file"
        accept=".txt,.json,.conf,.sub"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0],
            previous = updateFile.current;
          updateFile.current = undefined;
          e.target.value = '';
          if (f)
            void perform(async (signal) => {
              if (f.size > MAX_STASH)
                throw new Error(
                  'File exceeds 64 MiB. Subscriptions support 32 MiB and Wayrill stash files support 64 MiB.',
                );
              const latest = previous && currentGroup(previous);
              await accept(await readImportText(f), latest?.name ?? f.name, latest, signal);
            });
        }}
      />
      <EditorTabPanels tabs={tabs} className="stash-body">
        {(panel) => (
          <>
            {panel === tab &&
              ((error && !editor) ||
                store.error ||
                maintenance?.statuses.service?.state === 'error' ||
                maintenance?.statuses.runtime?.state === 'error') && (
                <div className="runtime-error" role="alert">
                  {error ||
                    store.error ||
                    maintenance?.statuses.service?.message ||
                    maintenance?.statuses.runtime?.message}
                </div>
              )}
            {panel === tab && notice && (
              <div className="runtime-notice stash-notice">
                <span role="status">{notice}</span>
                <button
                  className="icon-button"
                  aria-label="Dismiss stash message"
                  onClick={() => setNotice('')}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {panel === 'outbounds' && (
              <>
                {maintenance &&
                  Object.entries(maintenance.statuses)
                    .filter(
                      ([id, value]) =>
                        groups.some((g) => g.id === id) &&
                        (value.state !== 'idle' || selectedGroup?.id === id),
                    )
                    .slice(0, 5)
                    .map(([id, value]) => (
                      <div
                        className="subscription-maintenance-status"
                        key={id}
                        role={value.state === 'error' ? 'alert' : 'status'}
                      >
                        <span>
                          <bdi>{groups.find((g) => g.id === id)?.name}</bdi> · {value.message}
                        </span>
                        {['refreshing', 'testing'].includes(value.state) && (
                          <button
                            className="secondary-button"
                            onClick={() => maintenance.cancel(id)}
                          >
                            Cancel current run
                          </button>
                        )}
                      </div>
                    ))}
                <div className="stash-group-controls">
                  <label>
                    Group
                    <select
                      className="text-control"
                      aria-label="Stash group"
                      value={groupId}
                      disabled={busy || !!editor}
                      onChange={(event) => {
                        setGroupId(event.target.value);
                        setPage(0);
                        setRemoveId('');
                      }}
                    >
                      <option value="all">All groups</option>
                      {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name} ({group.entries.length.toLocaleString()})
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="secondary-button"
                    disabled={
                      busy ||
                      !!editor ||
                      !selectedGroup ||
                      selectedGroup.id === DEFAULT_GROUP_ID ||
                      !store.ready
                    }
                    aria-expanded={!!editor?.group}
                    aria-controls={editor?.group ? importFormId : undefined}
                    onClick={(event) => openEditor(selectedGroup!, event.currentTarget)}
                  >
                    Subscription settings…
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      busy || !!editor || !selectedGroup?.url || !protectedStorageAvailable()
                    }
                    onClick={() => void perform((signal) => download(selectedGroup!, signal))}
                  >
                    <RefreshCw size={14} /> Refresh group
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      busy ||
                      !!editor ||
                      !selectedGroup ||
                      !maintenance?.available ||
                      maintenance.foregroundBusy ||
                      !protectedStorageAvailable()
                    }
                    onClick={() => void maintenance?.run(selectedGroup!.id, 'test')}
                  >
                    Retest group
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      busy ||
                      !!editor ||
                      !selectedGroup ||
                      selectedGroup.id === DEFAULT_GROUP_ID ||
                      !store.ready
                    }
                    onClick={() => {
                      updateFile.current = selectedGroup;
                      file.current?.click();
                    }}
                  >
                    Update group from file…
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Remove selected group"
                    disabled={
                      busy || !!editor || !selectedGroup || selectedGroup.id === DEFAULT_GROUP_ID
                    }
                    onClick={() => setRemoveId(groupId)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <div className="stash-search">
                  <label>
                    Search
                    <input
                      className="text-control"
                      autoComplete="off"
                      aria-label="Search configurations"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setPage(0);
                      }}
                      placeholder="Name, server, protocol or group"
                    />
                  </label>
                  <label>
                    Show
                    <select
                      className="text-control"
                      aria-label="Configuration type"
                      value={availability}
                      onChange={(event) => {
                        setAvailability(event.target.value);
                        setPage(0);
                      }}
                    >
                      <option value="all">All entries</option>
                      <option value="available">Supported configurations</option>
                    </select>
                  </label>
                  {selectedGroup && selectedGroup.id !== DEFAULT_GROUP_ID && (
                    <span className="runtime-scope">
                      {selectedGroup.updatedAt
                        ? `Updated ${new Date(selectedGroup.updatedAt).toLocaleString()}`
                        : 'Not downloaded yet'}
                    </span>
                  )}
                </div>
                {pending && (
                  <p role="status" className="field-help">
                    Updating search… Previous rows are temporarily unavailable.
                  </p>
                )}
                <div
                  className="stash-table"
                  role="table"
                  aria-label="Stashed configurations"
                  aria-busy={pending}
                >
                  <div className="stash-row stash-header" role="row">
                    <span role="columnheader">Name / group</span>
                    <span role="columnheader">Protocol / server</span>
                    <span role="columnheader">
                      {replaceLabel ? 'Select configuration' : 'Actions'}
                    </span>
                  </div>
                  {rows.map(({ entry, group }) => (
                    <div className="stash-row" role="row" key={`${group.id}-${entry.id}`}>
                      <div role="cell">
                        <strong dir="auto" title={entry.name}>
                          {entry.name}
                        </strong>
                        <small>{group.name}</small>
                        {entry.sourceCopyOf && <small>Provider copy</small>}
                        {entry.health && (
                          <small
                            className="stash-health"
                            title={`Checked ${new Date(entry.health.checkedAt).toLocaleString()}`}
                          >
                            {entry.health.status === 'dead'
                              ? 'Last test unreachable'
                              : entry.health.status === 'unavailable'
                                ? 'Health test unavailable'
                                : `${entry.health.latencyMs ?? '—'} ms`}
                          </small>
                        )}
                        {entry.retained && <small>Retained · referenced by this setup</small>}
                      </div>
                      <div role="cell">
                        <span>
                          {entry.protocol.toUpperCase()} · {entry.address || 'No server'}
                        </span>
                        <OutboundTestSummary entry={entry} stash={store.stash} />
                        {entry.problem && <small className="stash-problem">{entry.problem}</small>}
                      </div>
                      <div className="stash-entry-actions" role="cell">
                        {(entry.profile?.kind ?? entry.draft?.kind) !== 'block-outbound' && (
                          <OutboundTestButtons
                            entries={[entry]}
                            name={entry.name}
                            disabled={busy || pending || !entryAvailable(entry)}
                          />
                        )}
                        <StashStar
                          entry={entry}
                          disabled={busy || pending || !store.ready}
                          onToggle={() => {
                            try {
                              store.update((current) =>
                                starStashEntry(current, { groupId: group.id, entryId: entry.id }),
                              );
                              setError('');
                            } catch (error) {
                              setError(error instanceof Error ? error.message : String(error));
                            }
                          }}
                        />
                        <button
                          className="icon-button"
                          disabled={busy || pending || !store.ready}
                          aria-label={`Edit ${entry.name} from ${group.name}`}
                          onClick={() =>
                            setEditingEntry({ entry, link: entryLink(store.stash, entry) })
                          }
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button"
                          disabled={busy || pending || !store.ready}
                          aria-pressed={!!entry.locked}
                          title={
                            entry.locked
                              ? 'Unlock subscription updates'
                              : 'Lock against subscription updates'
                          }
                          aria-label={`${entry.locked ? 'Unlock' : 'Lock'} ${entry.name} from ${group.name}`}
                          onClick={() => {
                            try {
                              store.update((current) =>
                                lockStashEntry(current, {
                                  groupId: group.id,
                                  entryId: entry.id,
                                }),
                              );
                              setError('');
                            } catch (e) {
                              setError(e instanceof Error ? e.message : String(e));
                            }
                          }}
                        >
                          {entry.locked ? <LockKeyhole size={15} /> : <LockKeyholeOpen size={15} />}
                        </button>
                        {!replaceLabel && (
                          <button
                            className="icon-button"
                            disabled={busy || pending || !store.ready}
                            aria-label={`Delete ${entry.name} from ${group.name}`}
                            onClick={() => {
                              try {
                                store.update((current) =>
                                  removeStashEntries(current, [
                                    { groupId: group.id, entryId: entry.id },
                                  ]),
                                );
                                setError('');
                              } catch (e) {
                                setError(e instanceof Error ? e.message : String(e));
                              }
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}

                        {replaceLabel ? (
                          <label className="stash-choice">
                            <input
                              autoComplete="off"
                              type="radio"
                              name={choiceId}
                              checked={chosen?.entryId === entry.id && chosen.groupId === group.id}
                              disabled={busy || pending || !entryAvailable(entry)}
                              aria-label={`Use ${entry.name} from ${group.name} to replace ${replaceLabel}`}
                              onChange={() => setChosen({ groupId: group.id, entryId: entry.id })}
                            />
                            Select
                          </label>
                        ) : (
                          <button
                            className="secondary-button"
                            disabled={busy || pending || !entryAvailable(entry)}
                            aria-label={`Add ${entry.name} from ${group.name} to graph`}
                            onClick={() => chooseEntry(entry, false)}
                          >
                            <Plus size={13} /> Add node
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {!filtered.length && (
                  <p className="stash-empty">
                    {total
                      ? 'No matching configurations.'
                      : 'Import configurations or add a subscription group to get started.'}
                  </p>
                )}
              </>
            )}
            {(panel === 'policyGroups' || panel === 'proxyChains') && (
              <PreparedOutboundLibrary
                key={panel}
                query={preparedQuery}
                onQueryChange={setPreparedQuery}
                kind={panel === 'policyGroups' ? 'policy-group' : 'proxy-chain'}
                stash={store.stash}
                graph={graph}
                ready={store.ready && !busy}
                replace={!!replaceLabel}
                chosen={chosen ?? undefined}
                onChoose={(entry) => setChosen(entryLink(store.stash, entry))}
                onUse={(entry) => chooseEntry(entry, false)}
                onSave={(entry, edit) =>
                  store.update((current) => putStashEntry(current, entry, edit?.link, edit?.entry))
                }
                onDelete={(entry) =>
                  store.update((current) =>
                    removeStashEntries(current, [entryLink(current, entry)]),
                  )
                }
                onStar={(entry) =>
                  store.update((current) => starStashEntry(current, entryLink(current, entry)))
                }
                onLock={(entry) =>
                  store.update((current) => lockStashEntry(current, entryLink(current, entry)))
                }
              />
            )}
            {panel === 'subscriptions' && (
              <SubscriptionGroups
                groups={groups}
                busy={busy || !store.ready}
                canDownload={protectedStorageAvailable()}
                canTest={!!maintenance?.available && !maintenance.foregroundBusy}
                statuses={maintenance?.statuses ?? {}}
                progress={batch}
                problems={groupProblems}
                onBrowse={browse}
                onEdit={openEditor}
                onRefresh={(group) => void perform((signal) => download(group, signal))}
                onRefreshAll={() => void perform(refreshAll)}
                onPause={pauseGroup}
                onExport={(group) => void exportGroup(group)}
                onFile={(group) => {
                  updateFile.current = group;
                  file.current?.click();
                }}
                onRemove={(group) => setRemoveId(group.id)}
                onTest={(group) => void maintenance?.run(group.id, 'test')}
                onCancel={(id) => maintenance?.cancel(id)}
              />
            )}
          </>
        )}
      </EditorTabPanels>
      {editor && (
        <div id={importFormId}>
          <SubscriptionSettingsForm
            key={editor.group?.id ?? 'new'}
            group={editor.group}
            groups={groups}
            busy={busy}
            error={error}
            onSubmit={(value) => void perform((signal) => saveSubscription(value, signal))}
            onCancel={closeEditor}
          />
        </div>
      )}

      {removeId && (
        <div className="runtime-note stash-remove-confirmation">
          Remove {removingGroup?.name} and its stash entries? Graph nodes keep their current
          settings; linked policy groups retain their last snapshot until relinked.{' '}
          <button
            className="secondary-button"
            disabled={busy || !store.ready}
            onClick={() =>
              void perform(() => {
                store.update((current) => ({
                  ...current,
                  groups: current.groups.filter((g) => g.id !== removeId),
                }));
                setGroupId('all');
                setPage(0);
                setRemoveId('');
              })
            }
          >
            Remove group
          </button>{' '}
          <button className="secondary-button" disabled={busy} onClick={() => setRemoveId('')}>
            Keep group
          </button>
        </div>
      )}

      {editingEntry && (
        <StashEntryEditor
          entry={editingEntry.entry}
          graph={graph}
          onSave={(next) =>
            store.update((current) =>
              putStashEntry(current, next, editingEntry.link, editingEntry.entry),
            )
          }
          onClose={() => setEditingEntry(undefined)}
        />
      )}

      {tab === 'outbounds' && (
        <ResultPager
          label="Stash"
          count={filtered.length}
          size={PAGE}
          page={currentPage}
          disabled={busy || pending}
          onPage={setPage}
        />
      )}
      {replaceLabel && (
        <div className="stash-replacement-summary">
          <strong>
            Replace {replaceLabel}
            {candidate ? ` with ${candidate.name}` : ''}
          </strong>
          <span>ID, position, routing tag and incoming connections stay attached.</span>
          {replacementConnections > 0 && (
            <span>Observation connections are retained when the replacement uses them.</span>
          )}
        </div>
      )}
      <div className="rule-editor-footer">
        <span>
          {busy
            ? 'Processing…'
            : store.saving
              ? 'Saving encrypted stash…'
              : protectedStorageAvailable()
                ? 'Service-managed · encrypted storage'
                : 'Session only · export to keep configurations'}
        </span>
        {busy && (
          <button className="secondary-button" onClick={cancelOperation}>
            Cancel operation
          </button>
        )}
        {replaceLabel && (
          <button
            className="primary-button"
            disabled={busy || pending || !candidate || !entryAvailable(candidate)}
            onClick={() => {
              if (candidate?.profile && !busy && !pending) chooseEntry(candidate, true);
            }}
          >
            <Replace size={14} /> Replace
          </button>
        )}
        <button className="secondary-button" disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
