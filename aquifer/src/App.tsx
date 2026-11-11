import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileJson,
  FolderOpen,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  X,
  Eye,
  EyeOff,
  ChevronDown,
  Activity,
  Archive,
  PanelLeft,
  PanelRight,
  MousePointer2,
  Hand,
  CheckCheck,
} from 'lucide-react';
import { ReactFlowProvider } from '@xyflow/react';
import RemoteCanvas, { type CanvasActions } from './RemoteCanvas';
import MenuBar, { type Menu } from './components/MenuBar';
import NodeContextMenu from './components/NodeContextMenu';
import WorkspaceDialog from './WorkspaceDialog';
import RemoteNodeLibrary from './RemoteNodeLibrary';
import InlineNodeSettings from './InlineNodeSettings';
import { createRemoteNode, inlineSettings } from './remoteCreation';
import {
  remoteView,
  routingDestinations,
  redact,
  ruleConditions,
  unplacedOutbounds,
  type RemoteView,
} from './remoteModel';
import { nodeSettings, replaceNodeSettings } from './nodeSettings';
import { applyRoutingOutputs, retainRoutingOutputs, type RoutingOutput } from './routingOutputs';
import RemoteSettings from './RemoteSettings';
import RemoteStash from './RemoteStash';
import RemoteChainSettings from './RemoteChainSettings';
import { configuredOutbounds, applyChain } from './remoteStashModel';
import { withoutApiPlumbing, apiPlumbing, type ApiListener } from './apiPlumbing';
import { get } from './nativeProperties';
import { compileRemote } from './remoteExport';
import {
  emptyLayout,
  restoreRemoteDocument,
  saveRemoteDocument,
  type RemoteLayout,
} from './remoteDocument';
import {
  desktopAvailable,
  errorMessage,
  nativeClient,
  type ConfigSnapshot,
  type Discovery,
  type RemoteClient,
  type SavedSession,
  type SessionInventory,
  type ServerStatus,
} from './remoteClient';
import { demoConfig, sharedUsersExample } from './demo';
import { jsonEqual, jsonRecord, parseXrayJson } from './graph/xrayJson';
import WinScpSetup from './WinScpSetup';
import ServerStatusDialog from './ServerStatusDialog';
import ConfigDeploymentDialog from './ConfigDeploymentDialog';
import {
  addSetToWorkspace,
  connectUserSet,
  createUserWorkspace,
  emptyLibrary,
  saveUserSet,
  stable,
  inboundObjects,
  inboundUsers,
  type UserLibrary,
  type UserProtocol,
  type UserSet,
  type UserWorkspace,
} from './users/model';
import { canConnectUsers, userNodeId, withUserNodes } from './users/view';
import { exportJson, userStore, type UserStore } from './users/storage';
import UserLibraryDialog from './users/UserLibraryDialog';
import { InboundUserAssignments, UserSetDetails } from './users/UserAssignments';

const DEFAULT_CONFIG_PATH = '/usr/local/etc/xray/config.json';

export default function App({
  client = nativeClient,
  credentialStore = userStore,
}: {
  client?: RemoteClient;
  credentialStore?: UserStore;
}) {
  const [library, setLibrary] = useState<UserLibrary>(emptyLibrary);
  const [libraryReady, setLibraryReady] = useState(false),
    [libraryError, setLibraryError] = useState('');
  const [users, setUsers] = useState<UserWorkspace | null>(null),
    [usersBaseline, setUsersBaseline] = useState('');
  const [usersDialog, setUsersDialog] = useState<{
    initial: UserSet | null;
    protocol?: UserProtocol;
    inbound?: number;
    targetName?: string;
  } | null>(null);
  const [inventory, setInventory] = useState<SessionInventory | null>(null),
    [session, setSession] = useState('');
  const [setupOpen, setSetupOpen] = useState(false),
    [setupBusy, setSetupBusy] = useState(false);
  const sessions: SavedSession[] = inventory?.sessions ?? [];
  const [discovery, setDiscovery] = useState<Discovery | null>(null),
    [path, setPath] = useState(DEFAULT_CONFIG_PATH);
  const [discoveryNote, setDiscoveryNote] = useState('');
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [deploymentOpen, setDeploymentOpen] = useState(false);
  const [sourceSession, setSourceSession] = useState('');
  const [statusError, setStatusError] = useState('');
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null),
    [view, setView] = useState<RemoteView | null>(null);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [selected, setSelected] = useState('');
  const [showConfig, setShowConfig] = useState(false),
    [reveal, setReveal] = useState(false),
    [propertiesTab, setPropertiesTab] = useState<'properties' | 'json'>('properties');
  const [query, setQuery] = useState(''),
    [noticesOpen, setNoticesOpen] = useState(false);
  const [information, setInformation] = useState<'help' | 'about' | 'check' | null>(null);
  const [navigationVisible, setNavigationVisible] = useState(true),
    [propertiesVisible, setPropertiesVisible] = useState(true);
  const [mode, setMode] = useState<'select' | 'pan'>('select');
  const [nodeContext, setNodeContext] = useState<{
    id: string;
    opener: HTMLElement;
    x: number;
    y: number;
  } | null>(null);
  const canvas = useRef<CanvasActions>(null);
  const [showStash, setShowStash] = useState(false);
  const [shownNodes, setShownNodes] = useState<string[]>([]);
  const [layout, setLayout] = useState<RemoteLayout>(emptyLayout);
  const [documentBaseline, setDocumentBaseline] = useState('');
  const [documentSynced, setDocumentSynced] = useState(false);
  const [chainRoot, setChainRoot] = useState<number | null>(null);
  const [setupError, setSetupError] = useState('');
  const [settingsId, setSettingsId] = useState('');
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [inlineDirty, setInlineDirty] = useState(false);
  const [inlineRevision, setInlineRevision] = useState(0);
  const [filesOpen, setFilesOpen] = useState(true);
  const [sourceLabel, setSourceLabel] = useState(''),
    [generation, setGeneration] = useState(0);
  const requests = useRef({ sequence: 0, cancelled: false }).current,
    fileInput = useRef<HTMLInputElement>(null);
  const activeSession = sessions.find((item) => item.id === session);
  // Discovery/status belong to the selected endpoint, including automatic
  // selection changes after refreshing or reconfiguring WinSCP sessions.
  useEffect(() => {
    setDiscovery(null);
    setDiscoveryNote('');
    setStatus(null);
    setStatusOpen(false);
    setStatusError('');
    setPath(DEFAULT_CONFIG_PATH);
  }, [session]);
  const sshAvailable = !!inventory?.executable && !inventory.compatibilityError;
  useEffect(() => {
    let active = true;
    void credentialStore
      .load()
      .then((result) => {
        if (active) {
          setLibrary(result);
          setLibraryReady(true);
        }
      })
      .catch((reason) => {
        if (active) setLibraryError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [credentialStore]);
  const compilation = useMemo(() => {
    if (!view || !users) return null;
    try {
      return compileRemote(view, users);
    } catch (reason) {
      return { config: view.original, errors: [errorMessage(reason)], changed: false };
    }
  }, [view, users]);
  const displayedView = useMemo(() => {
    const base = view && users && compilation ? withUserNodes(view, users, compilation) : view;
    return base ? withoutApiPlumbing(base) : null;
  }, [view, users, compilation]);
  const documentText = useMemo(
    () => (view && users ? saveRemoteDocument(view, users, { ...layout, shown: shownNodes }) : ''),
    [view, users, layout, shownNodes],
  );
  const documentDirty = !!documentBaseline && documentText !== documentBaseline;
  const usersDirty = !!users && stable(users) !== usersBaseline;
  const mayReplaceDraft = () =>
    (!usersDirty && !settingsDirty && !documentDirty && !inlineDirty) ||
    window.confirm('Discard this local configuration draft?');
  const canvasView = useMemo(() => {
    if (!displayedView) return null;
    const shown = shownNodes;
    const hidden = new Set(unplacedOutbounds(displayedView, shown).map((node) => node.id));
    return {
      ...displayedView,
      nodes: displayedView.nodes.filter((node) => !hidden.has(node.id)),
      edges: displayedView.edges.filter(
        (edge) => !hidden.has(edge.source) && !hidden.has(edge.target),
      ),
    };
  }, [displayedView, shownNodes]);
  const visibleNodeIds = new Set(canvasView?.nodes.map((node) => node.id));
  const showGraphNode = (id: string) => {
    if (!selectNode(id)) return;
    setShownNodes((current) => (current.includes(id) ? current : [...current, id]));
    setShowStash(false);
    canvas.current?.focus(id);
  };
  const replaceLibrary = async (next: UserLibrary) => {
    await credentialStore.save(next);
    setLibrary(next);
  };
  const saveSet = async (set: UserSet) => {
    await replaceLibrary(saveUserSet(library, set));
  };
  const assignSet = (id: string, inbound: number) => {
    if (!view || !users) return;
    try {
      setUsers(connectUserSet(view.original, users, id, inbound));
      setError('');
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const disconnectSet = (id: string, inbound: number) =>
    setUsers((current) =>
      current
        ? {
            ...current,
            bindings: current.bindings.filter((b) => b.set !== id || b.inbound !== inbound),
          }
        : current,
    );

  const acceptInventory = useCallback((result: SessionInventory) => {
    setInventory(result);
    setSession((current) =>
      result.sessions.some((item) => item.id === current)
        ? current
        : (result.sessions[0]?.id ?? ''),
    );
    if (!result.executable || !result.sessions.length || result.compatibilityError)
      setSetupOpen(true);
    setError('');
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const result = await client.sessions();
      acceptInventory(result);
    } catch (reason) {
      setError(errorMessage(reason));
      setSetupOpen(true);
    }
  }, [client, acceptInventory]);
  useEffect(() => {
    if (desktopAvailable || client !== nativeClient) void loadSessions();
    return () => {
      requests.sequence++;
    };
  }, [client, loadSessions, requests]);
  const present = (result: ConfigSnapshot, label: string, origin = '') => {
    setSourceSession(origin);
    setDeploymentOpen(false);
    setSettingsDirty(false);
    setInlineDirty(false);
    setSettingsId('');
    setShownNodes([]);
    setLayout(emptyLayout());
    setDocumentBaseline('');
    setDocumentSynced(false);
    setChainRoot(null);
    setShowStash(false);
    setDiscoveryNote('');
    setSnapshot(result);
    setSourceLabel(label);
    setSelected('');
    setShowConfig(false);
    setReveal(false);
    setNoticesOpen(false);
    setFilesOpen(false);
    setGeneration((current) => current + 1);
    try {
      let nextView = remoteView(result.text);
      let workspace = createUserWorkspace(nextView.original, library);
      let nextLayout = emptyLayout();
      if (typeof result.companion?.text === 'string') {
        try {
          const restored = restoreRemoteDocument(result.text, result.companion.text);
          nextView = restored.view;
          workspace = restored.users;
          nextLayout = restored.layout;
          setDocumentSynced(true);
        } catch (reason) {
          setNoticesOpen(true);
          nextView.notices.push(
            'Wayrill file ignored: ' +
              errorMessage(reason) +
              ' Loaded the Xray configuration instead.',
          );
        }
      }
      if (result.companion?.error) {
        setNoticesOpen(true);
        nextView.notices.push('Wayrill file: ' + result.companion.error);
      }
      setLayout(nextLayout);
      setShownNodes(nextLayout.shown);
      setDocumentBaseline(saveRemoteDocument(nextView, workspace, nextLayout));
      setView(nextView);
      setUsers(workspace);
      setUsersBaseline(stable(workspace));
      setError('');
    } catch (reason) {
      setView(null);
      setUsers(null);
      setUsersBaseline('');
      setShowConfig(true);
      setError('Graph conversion: ' + errorMessage(reason));
    }
  };
  const read = async (name: string, filename: string, token: number) => {
    setBusy('Reading configuration');
    const result = await client.read(name, filename);
    if (token !== requests.sequence || requests.cancelled) return;
    present(result, sessions.find((item) => item.id === name)?.name ?? 'Remote server', name);
  };
  const connect = async () => {
    if (!mayReplaceDraft()) return;
    const token = ++requests.sequence;
    requests.cancelled = false;
    setBusy('Finding Xray configuration');
    setError('');
    setDiscoveryNote('');
    try {
      let result: Discovery | null = null;
      let discoveryIssue = 'Discovery found no readable configuration.';
      try {
        result = await client.discover(session);
      } catch (reason) {
        if (
          !reason ||
          typeof reason !== 'object' ||
          !('code' in reason) ||
          reason.code !== 'DISCOVERY'
        )
          throw reason;
        discoveryIssue = errorMessage(reason);
      }
      if (token !== requests.sequence || requests.cancelled) return;
      setDiscovery(result);
      const readable = result?.files.filter((f) => f.readable && f.size <= 16 * 1024 * 1024) ?? [];
      const file =
        readable.find((f) => f.services?.includes('xray.service')) ??
        readable.find((f) => [DEFAULT_CONFIG_PATH, '/etc/xray/config.json'].includes(f.path)) ??
        readable.find((f) => f.running) ??
        readable[0];
      if (file) {
        setPath(file.path);
        await read(session, file.path, token);
      } else {
        const filename = path.trim() || DEFAULT_CONFIG_PATH;
        setPath(filename);
        try {
          await read(session, filename, token);
        } catch (reason) {
          throw new Error(`Could not read ${filename}: ${errorMessage(reason)} ${discoveryIssue}`, {
            cause: reason,
          });
        }
        if (token === requests.sequence && !requests.cancelled)
          setDiscoveryNote(
            `${discoveryIssue} Loaded the file directly over SFTP; its running process was not verified.`,
          );
      }
    } catch (reason) {
      if (token === requests.sequence && !requests.cancelled) setError(errorMessage(reason));
    } finally {
      if (token === requests.sequence) setBusy('');
    }
  };
  const openPath = async () => {
    if (!mayReplaceDraft()) return;
    const token = ++requests.sequence;
    requests.cancelled = false;
    setError('');
    setDiscoveryNote('');
    try {
      await read(session, path.trim(), token);
    } catch (reason) {
      if (token === requests.sequence && !requests.cancelled) setError(errorMessage(reason));
    } finally {
      if (token === requests.sequence) setBusy('');
    }
  };
  const refreshStatus = async () => {
    const token = ++requests.sequence;
    requests.cancelled = false;
    setStatusError('');
    setBusy('Reading server status');
    try {
      const result = await client.serverStatus(session);
      if (token === requests.sequence && !requests.cancelled) setStatus(result);
    } catch (reason) {
      if (token === requests.sequence && !requests.cancelled) setStatusError(errorMessage(reason));
    } finally {
      if (token === requests.sequence) setBusy('');
    }
  };
  const cancelStatus = () => {
    requests.cancelled = true;
    setStatusError('Status check cancelled.');
    void client.cancel().catch(() => {});
  };
  const clear = () => {
    requests.sequence++;
    requests.cancelled = false;
    setDiscovery(null);
    setDiscoveryNote('');
    setStatus(null);
    setStatusOpen(false);
    setStatusError('');
    setPath(DEFAULT_CONFIG_PATH);
    setSnapshot(null);
    setSourceSession('');
    setDeploymentOpen(false);
    setView(null);
    setLayout(emptyLayout());
    setDocumentBaseline('');
    setDocumentSynced(false);
    setUsers(null);
    setUsersBaseline('');
    setSettingsDirty(false);
    setInlineDirty(false);
    setSettingsId('');
    setShownNodes([]);
    setChainRoot(null);
    setShowStash(false);
    setUsersDialog(null);
    setSelected('');
    setError('');
    setReveal(false);
    setShowConfig(false);
    setSourceLabel('');
    setFilesOpen(true);
    setQuery('');
  };
  const disconnect = async (nextSession?: string) => {
    const keepLocalDraft = nextSession !== undefined && !!view && !sourceSession;
    if (!keepLocalDraft && !mayReplaceDraft()) return;
    setBusy('Disconnecting');
    try {
      await client.disconnect();
      if (keepLocalDraft) {
        setDiscovery(null);
        setStatus(null);
        setStatusOpen(false);
      } else clear();
      if (nextSession !== undefined) setSession(nextSession);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy('');
    }
  };
  const configure = async (action: () => Promise<SessionInventory | null>) => {
    setSetupBusy(true);
    setSetupError('');
    try {
      const result = await action();
      if (result) {
        setDiscovery(null);
        setStatus(null);
        setStatusOpen(false);
        acceptInventory(result);
      }
    } catch (reason) {
      setSetupError(errorMessage(reason));
    } finally {
      setSetupBusy(false);
    }
  };
  const localFile = async (file: File) => {
    if (!mayReplaceDraft()) return;
    if (file.size > 16 * 1024 * 1024) {
      setError('The configuration exceeds 16 MiB.');
      return;
    }
    const token = ++requests.sequence;
    requests.cancelled = false;
    setBusy('Opening file');
    try {
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (token !== requests.sequence || requests.cancelled) return;
      setDiscovery(null);
      present({ text, path: file.name, bytes: file.size, sha256: '' }, 'Local file');
    } catch {
      setError('This file could not be read as UTF-8 JSON.');
    } finally {
      if (token === requests.sequence) setBusy('');
    }
  };
  const node = displayedView?.nodes.find((n) => n.id === selected);
  const selectedSet = users?.sets.find((s) => s.id === node?.data.userSetId);
  const editor = view && settingsId ? nodeSettings(view, settingsId) : undefined;
  const settingsNode = displayedView?.nodes.find((item) => item.id === settingsId);
  const saveNodeSettings = (
    id: string,
    value: unknown,
    listeners?: ApiListener[],
    outputs?: RoutingOutput[],
  ) => {
    if (!view) throw new Error('Open a configuration first.');
    const edited = replaceNodeSettings(view, id, value, listeners);
    const next = outputs ? applyRoutingOutputs(edited, outputs) : edited;
    if (listeners && users && id === 'native-options') {
      const enabled = jsonRecord(value) && jsonRecord(get(value, 'api'));
      const kept = new Set(enabled ? listeners.map((item) => item.index) : []);
      const removed = [...apiPlumbing(view.original).inboundIndices].filter(
        (index) => !kept.has(index),
      );
      if (removed.length)
        setUsers({
          ...users,
          bindings: users.bindings.map((binding) => ({
            ...binding,
            inbound: binding.inbound - removed.filter((index) => index < binding.inbound).length,
          })),
        });
    }
    if (next !== view) {
      setView(next);
      setSettingsDirty(true);
    }
    setSettingsId('');
    setInlineDirty(false);
    return next;
  };
  const sourceJson = useMemo(() => {
    if (!snapshot) return undefined;
    try {
      return parseXrayJson(snapshot.text);
    } catch {
      return undefined;
    }
  }, [snapshot]);
  const raw = showConfig ? sourceJson : node?.data.raw;
  const visibleJson =
    raw === undefined
      ? reveal
        ? snapshot?.text
        : 'Unable to parse this file. Reveal credentials to inspect its original text.'
      : JSON.stringify(reveal ? raw : redact(raw), null, 2);
  const notices = [
    ...(discoveryNote ? [discoveryNote] : []),
    ...(discovery?.warnings ?? []),
    ...(view?.notices ?? []),
  ];
  const blocked = !!busy || setupBusy;
  const canRead = !!session && sshAvailable && !blocked;
  const canDeploy =
    canRead &&
    sourceSession === session &&
    /^[a-f0-9]{64}$/.test(snapshot?.sha256 ?? '') &&
    !!compilation &&
    !compilation.errors.length;
  const serverDraftChanged = useMemo(() => {
    if (!snapshot || !compilation) return false;
    try {
      return !jsonEqual(compilation.config, sourceJson) || documentDirty || !documentSynced;
    } catch {
      return false;
    }
  }, [snapshot, sourceJson, compilation, documentDirty, documentSynced]);
  const deploymentConfigText =
    snapshot && compilation && jsonEqual(compilation.config, sourceJson)
      ? snapshot.text
      : JSON.stringify(compilation?.config, null, 2);
  const discardInline = () => {
    if (inlineDirty && !window.confirm('Discard unsaved node settings?')) return false;
    if (inlineDirty) setInlineRevision((current) => current + 1);
    setInlineDirty(false);
    return true;
  };
  const selectNode = (id: string) => {
    if (id !== selected && !discardInline()) return false;
    setSelected(id);
    setShowConfig(false);
    setPropertiesTab('properties');
    if (id) setPropertiesVisible(true);
    return true;
  };
  const openNode = (id: string) => {
    const set = users?.sets.find((set) => userNodeId(set.id) === id);
    if (set) setUsersDialog({ initial: set });
    else if (view && inlineSettings(id, nodeSettings(view, id)?.value)) selectNode(id);
    else if (view && nodeSettings(view, id) && discardInline()) setSettingsId(id);
    else selectNode(id);
  };
  const openSource = () => {
    if (!discardInline()) return;
    setShowConfig(true);
    setSelected('');
    setPropertiesVisible(true);
  };
  const openStatus = () => {
    setStatusOpen(true);
    if (!status) void refreshStatus();
  };
  const exportConfiguration = () => {
    if (!compilation || compilation.errors.length || blocked || !discardInline()) return;
    void exportJson('xray-config.json', JSON.stringify(compilation.config, null, 2)).catch(
      (reason) => setError(errorMessage(reason)),
    );
  };
  const resetUsers = () => {
    if (view && mayReplaceDraft()) {
      const workspace = createUserWorkspace(view.original, library);
      setUsers(workspace);
      setUsersBaseline(stable(workspace));
    }
  };
  const newConfiguration = () => {
    if (!mayReplaceDraft()) return;
    const next = remoteView('{}');
    const workspace = createUserWorkspace(next.original, library);
    if (sourceSession && snapshot) {
      setView(next);
      setUsers(workspace);
      setUsersBaseline(stable(workspace));
      setLayout(emptyLayout());
      setShownNodes([]);
      setSettingsDirty(true);
      setInlineDirty(false);
      setSettingsId('');
      setChainRoot(null);
      setShowStash(false);
      setSelected('');
      setShowConfig(false);
      setGeneration((current) => current + 1);
    } else {
      clear();
      present({ text: '{}', path: 'new-config.json', bytes: 2, sha256: '' }, 'New configuration');
    }
  };
  const addLibraryNode = (entry: string, position?: { x: number; y: number }) => {
    if (!view || !discardInline()) return;
    if (entry === 'users') {
      setUsersDialog({ initial: null });
      return;
    }
    try {
      const result = createRemoteNode(view, entry);
      setView(result.view);
      if (!view.nodes.some((node) => node.id === result.id)) {
        const point = position ?? canvas.current?.placement();
        if (point)
          setLayout((current) => ({
            ...current,
            positions: { ...current.positions, [result.id]: point },
          }));
      }
      if (result.view !== view) setSettingsDirty(true);
      if (!visibleNodeIds.has(result.id))
        setShownNodes((current) =>
          current.includes(result.id) ? current : [...current, result.id],
        );
      setSelected(result.id);
      setShowConfig(false);
      setPropertiesVisible(true);
      setPropertiesTab('properties');
      canvas.current?.focus(result.id);
      const value = nodeSettings(result.view, result.id)?.value;
      if (!inlineSettings(result.id, value)) setSettingsId(result.id);
      setError('');
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const prepareDeployment = async () => {
    if (!discardInline() || !compilation || compilation.errors.length || !canRead) return;
    if (sourceSession === session && snapshot?.sha256) {
      setDeploymentOpen(true);
      return;
    }
    if (sourceSession) return;
    const filename = path.trim();
    if (!filename.startsWith('/')) {
      setError('Enter an absolute remote configuration path.');
      return;
    }
    const token = ++requests.sequence;
    requests.cancelled = false;
    setBusy('Reading deployment target');
    try {
      const target = await client.read(session, filename);
      if (token !== requests.sequence || requests.cancelled) return;
      setSnapshot(target);
      setSourceSession(session);
      setSourceLabel(activeSession?.name ?? 'Remote server');
      setDocumentSynced(false);
      setDeploymentOpen(true);
      setError('');
    } catch (reason) {
      if (token === requests.sequence && !requests.cancelled) setError(errorMessage(reason));
    } finally {
      if (token === requests.sequence) setBusy('');
    }
  };
  const canPrepareDeployment =
    canDeploy || (canRead && !sourceSession && !!compilation && !compilation.errors.length);
  const loadExample = (config: Record<string, unknown> = demoConfig) => {
    if (!mayReplaceDraft()) return;
    clear();
    present(
      {
        text: JSON.stringify(config, null, 2),
        path: 'example-server.json',
        sha256: '',
        bytes: 0,
      },
      'Example',
    );
  };
  const findNodes = () => {
    setNavigationVisible(true);
    window.requestAnimationFrame(() => document.getElementById('node-search')?.focus());
  };
  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        {
          label: 'New configuration',
          shortcut: 'Ctrl+N',
          disabled: blocked,
          action: newConfiguration,
        },
        {
          label: 'Open Xray config…',
          shortcut: 'Ctrl+O',
          disabled: blocked,
          action: () => fileInput.current?.click(),
        },
        {
          label: 'Export Xray configuration…',
          shortcut: 'Ctrl+S',
          disabled: blocked || !compilation || !!compilation.errors.length,
          action: exportConfiguration,
        },
        {
          label: 'Configuration stash…',
          disabled: blocked || !view,
          action: () => setShowStash(true),
        },
        { label: '', separator: true },
        {
          label: 'Load Example',
          disabled: blocked,
          items: [
            { label: 'Server configuration', action: () => loadExample() },
            {
              label: 'Shared users and proxy chains',
              action: () => loadExample(sharedUsersExample),
            },
          ],
        },
        { label: '', separator: true },
        {
          label: 'Close configuration',
          disabled: blocked || !snapshot,
          action: () => void disconnect(),
        },
      ],
    },
    {
      label: 'Edit',
      items: [
        {
          label: 'Edit selected node…',
          shortcut: 'Enter',
          disabled: blocked || !node,
          action: () => openNode(selected),
        },
        {
          label: 'User sets…',
          disabled: blocked || !libraryReady,
          action: () => setUsersDialog({ initial: null }),
        },
        {
          label: 'Reset user assignments…',
          disabled: blocked || !usersDirty,
          action: resetUsers,
        },
      ],
    },
    {
      label: 'View',
      items: [
        {
          label: 'Search node library',
          shortcut: 'Ctrl+F',
          disabled: !view || blocked,
          action: findNodes,
        },
        { label: 'Fit graph', shortcut: 'F', disabled: !view, action: () => canvas.current?.fit() },
        {
          label: 'Zoom in',
          shortcut: 'Ctrl++',
          disabled: !view,
          action: () => canvas.current?.zoomIn(),
        },
        {
          label: 'Zoom out',
          shortcut: 'Ctrl+−',
          disabled: !view,
          action: () => canvas.current?.zoomOut(),
        },
        { label: '', separator: true },
        {
          label: `${navigationVisible ? 'Hide' : 'Show'} navigation`,
          action: () => setNavigationVisible(!navigationVisible),
        },
        {
          label: `${propertiesVisible ? 'Hide' : 'Show'} properties`,
          disabled: !view && !snapshot,
          action: () => {
            if (!propertiesVisible || discardInline()) setPropertiesVisible(!propertiesVisible);
          },
        },
        { label: 'Source JSON…', disabled: blocked || !snapshot, action: openSource },
      ],
    },
    {
      label: 'Graph',
      items: [
        { label: 'Check graph', disabled: blocked || !view, action: () => setInformation('check') },
        { label: 'Select tool', disabled: !view, action: () => setMode('select') },
        { label: 'Pan tool', disabled: !view, action: () => setMode('pan') },
      ],
    },
    {
      label: 'Settings',
      items: [
        {
          label: 'Core settings…',
          disabled: blocked || !view,
          action: () => {
            if (discardInline()) setSettingsId('native-options');
          },
        },
        {
          label: 'WinSCP setup…',
          disabled: blocked,
          action: () => {
            setSetupError('');
            setSetupOpen(true);
          },
        },
      ],
    },
    {
      label: 'Server',
      items: [
        {
          label: snapshot && sourceSession === session ? 'Refresh from server' : 'Read server',
          shortcut: 'Ctrl+R',
          disabled: !canRead,
          action: () => void connect(),
        },
        { label: 'Read file', disabled: !canRead || !path.trim(), action: () => void openPath() },
        { label: 'Server status…', disabled: !canRead, action: openStatus },
        {
          label: 'Validate & apply configuration…',
          disabled: !canPrepareDeployment,
          action: () => void prepareDeployment(),
        },
        {
          label: 'Refresh saved sessions',
          disabled: blocked || (!desktopAvailable && client === nativeClient),
          action: () => void loadSessions(),
        },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Keyboard & canvas', shortcut: '?', action: () => setInformation('help') },
        { label: 'About Wayrill Aquifer', action: () => setInformation('about') },
      ],
    },
  ];
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        document.querySelector('dialog[open], [role="menu"]')
      )
        return;
      const key = event.key.toLowerCase(),
        modifier = event.ctrlKey || event.metaKey;
      if (modifier && ['n', 'o', 's', 'r', 'f', '+', '=', '-'].includes(key)) {
        event.preventDefault();
        if (blocked) return;
        if (key === 'n') newConfiguration();
        else if (key === 'o') fileInput.current?.click();
        else if (key === 's') exportConfiguration();
        else if (key === 'r' && canRead) void connect();
        else if (key === 'f' && view) findNodes();
        else if (key === '+' || key === '=') canvas.current?.zoomIn();
        else if (key === '-') canvas.current?.zoomOut();
        return;
      }
      if (
        modifier ||
        (event.target instanceof Element &&
          event.target.closest('input,textarea,select,[contenteditable=true],button,a'))
      )
        return;
      if (blocked) return;
      if (key === 'f' && view) {
        event.preventDefault();
        canvas.current?.fit();
      } else if (key === 'enter' && node) {
        event.preventDefault();
        openNode(selected);
      } else if (key === '?') {
        event.preventDefault();
        setInformation('help');
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });
  return (
    <div className="remote-app">
      <MenuBar menus={menus} brand="Wayrill Aquifer" />
      <main className="workspace">
        <aside className="connection-panel" hidden={!navigationVisible}>
          <section>
            <h2>
              <Server size={17} />
              Server
            </h2>
            <label className="field-label" htmlFor="saved-session">
              WinSCP session
            </label>
            <div className="field-with-button">
              <select
                className="text-control"
                id="saved-session"
                value={session}
                disabled={!!busy || setupBusy}
                onChange={(event) => {
                  void disconnect(event.target.value);
                }}
              >
                <option value="" disabled>
                  Select a saved session
                </option>
                {sessions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button
                className="icon-button"
                aria-label="Refresh saved sessions"
                title="Refresh saved sessions"
                disabled={!!busy || setupBusy || (!desktopAvailable && client === nativeClient)}
                onClick={() => {
                  void loadSessions();
                }}
              >
                <RefreshCw size={17} />
              </button>
            </div>
            {activeSession && (
              <p className="connection-address">
                {activeSession.user}@{activeSession.host}:{activeSession.port}
              </p>
            )}
            <button
              className="primary-button connect-button"
              disabled={!session || !sshAvailable || !!busy || setupBusy}
              onClick={() => {
                void connect();
              }}
            >
              <RefreshCw size={16} />
              {snapshot && sourceSession === session ? 'Refresh from server' : 'Read server'}
            </button>
            <button
              className="secondary-button status-open"
              disabled={!session || !sshAvailable || !!busy || setupBusy}
              onClick={() => {
                openStatus();
              }}
            >
              <Activity size={16} />
              Server status
            </button>
            {libraryError && (
              <p className="setup-warning" role="alert">
                User library: {libraryError}
              </p>
            )}
            {inventory?.compatibilityError && (
              <p className="setup-warning" role="alert">
                {inventory.compatibilityError}
              </p>
            )}
            {!desktopAvailable && client === nativeClient && (
              <p className="muted">
                SSH is available in the desktop app. Open the demo or a local file to explore the
                viewer.
              </p>
            )}
          </section>
          <section>
            <button
              className="section-toggle"
              aria-expanded={filesOpen}
              onClick={() => setFilesOpen(!filesOpen)}
            >
              <FileJson size={17} />
              Configuration
              <ChevronDown size={16} />
            </button>
            {discovery && (
              <div className="server-summary">
                <strong>{discovery.hostname}</strong>
                <span>
                  {discovery.processes.length
                    ? discovery.processes.map((p) => `Xray · PID ${p.pid}`).join(', ')
                    : 'Xray process not detected'}
                </span>
              </div>
            )}
            <div hidden={!filesOpen}>
              {discovery && discovery.files.length > 0 && (
                <>
                  <label className="field-label" htmlFor="detected-files">
                    Detected files
                  </label>
                  <select
                    className="text-control"
                    id="detected-files"
                    value={discovery.files.some((f) => f.path === path) ? path : ''}
                    disabled={!!busy}
                    onChange={(event) => setPath(event.target.value)}
                  >
                    <option value="" disabled>
                      Choose a configuration
                    </option>
                    {discovery.files.map((f) => (
                      <option
                        key={f.path}
                        value={f.path}
                        disabled={!f.readable || f.size > 16 * 1024 * 1024}
                      >
                        {f.path}
                        {f.services?.length
                          ? ` · ${f.services.join(', ')}`
                          : f.running
                            ? ' · running'
                            : ''}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <label className="field-label" htmlFor="remote-path">
                Remote file path
              </label>
              <input
                className="text-control"
                id="remote-path"
                value={path}
                placeholder="/usr/local/etc/xray/config.json"
                disabled={!!busy}
                spellCheck={false}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && session && path.trim() && sshAvailable && !busy)
                    void openPath();
                }}
              />
              <button
                className="secondary-button path-read"
                disabled={!session || !sshAvailable || !path.trim() || !!busy || setupBusy}
                onClick={() => {
                  void openPath();
                }}
              >
                <FolderOpen size={16} />
                Read file
              </button>
            </div>
          </section>
          <RemoteNodeLibrary
            query={query}
            onQuery={setQuery}
            onAdd={addLibraryNode}
            disabled={!view || blocked}
          />
          <input
            className="text-control"
            ref={fileInput}
            type="file"
            accept=".json,.jsonc,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void localFile(file);
              event.target.value = '';
            }}
          />
        </aside>
        <section className="graph-workspace" aria-label="Remote configuration graph">
          <div className="graph-toolbar">
            <div className="toolbar-actions">
              <button
                className="icon-button"
                title={navigationVisible ? 'Hide navigation' : 'Show navigation'}
                aria-label={navigationVisible ? 'Hide navigation' : 'Show navigation'}
                aria-pressed={navigationVisible}
                onClick={() => setNavigationVisible(!navigationVisible)}
              >
                <PanelLeft size={17} />
              </button>
              <div className="segmented-tools" role="group" aria-label="Canvas tools">
                <button
                  className="icon-button"
                  title="Select"
                  aria-label="Select tool"
                  aria-pressed={mode === 'select'}
                  disabled={!view || blocked}
                  onClick={() => setMode('select')}
                >
                  <MousePointer2 size={17} />
                </button>
                <button
                  className="icon-button"
                  title="Pan"
                  aria-label="Pan tool"
                  aria-pressed={mode === 'pan'}
                  disabled={!view || blocked}
                  onClick={() => setMode('pan')}
                >
                  <Hand size={17} />
                </button>
              </div>
              <button
                className="secondary-button"
                disabled={!view || blocked}
                onClick={() => setInformation('check')}
              >
                <CheckCheck size={17} />
                Check
              </button>
              <button
                className="secondary-button"
                disabled={!canPrepareDeployment}
                onClick={() => void prepareDeployment()}
              >
                Apply…
              </button>
            </div>
            <div className="graph-heading">
              <strong>{snapshot ? sourceLabel : 'Remote configuration'}</strong>
              <span title={snapshot?.path}>{snapshot?.path ?? 'Choose a server to begin'}</span>
            </div>
            <div className="toolbar-actions">
              {(usersDirty || settingsDirty || documentDirty) && (
                <span className="users-draft-label">Local draft</span>
              )}
              {notices.length > 0 && (
                <button
                  className="secondary-button notice-button"
                  onClick={() => setNoticesOpen(!noticesOpen)}
                >
                  {notices.length} import {notices.length === 1 ? 'note' : 'notes'}
                </button>
              )}
              <button
                className="secondary-button"
                disabled={!view || blocked}
                onClick={() => setShowStash(true)}
              >
                <Archive size={16} />
                Stash
              </button>
              <button
                className="icon-button"
                title={propertiesVisible ? 'Hide properties' : 'Show properties'}
                aria-label={propertiesVisible ? 'Hide properties' : 'Show properties'}
                aria-pressed={propertiesVisible}
                disabled={!snapshot}
                onClick={() => {
                  if (!propertiesVisible || discardInline())
                    setPropertiesVisible(!propertiesVisible);
                }}
              >
                <PanelRight size={17} />
              </button>
            </div>
          </div>
          {error && (
            <div className="error-message" role="alert">
              {error}
              <button
                className="secondary-button"
                aria-label="Dismiss error"
                onClick={() => setError('')}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {noticesOpen && notices.length > 0 && (
            <div className="import-notices">
              {notices.map((notice) => (
                <p key={notice}>{notice}</p>
              ))}
            </div>
          )}
          {!!compilation?.errors.length && (
            <div className="user-compilation-errors" role="alert">
              {compilation.errors.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          )}
          {canvasView ? (
            <ReactFlowProvider key={generation}>
              <RemoteCanvas
                view={canvasView}
                layout={layout}
                onLayout={(change) => setLayout((current) => ({ ...current, ...change }))}
                ref={canvas}
                mode={mode}
                onEdit={openNode}
                onAdd={addLibraryNode}
                onContext={(id, opener, x, y) => {
                  if (!selectNode(id)) return;
                  setNodeContext({ id, opener, x, y });
                }}
                selected={selected}
                onSelect={selectNode}
                isValidConnection={(connection) =>
                  !!view && !!users && canConnectUsers(connection, view, users)
                }
                onConnect={(connection) => {
                  if (view && users && canConnectUsers(connection, view, users))
                    assignSet(connection.source.slice(9), Number(connection.target.slice(10)));
                }}
              />
            </ReactFlowProvider>
          ) : (
            <div className="empty-canvas">
              <Network size={54} />
              <h1>{snapshot ? 'Source available for inspection' : 'Your server, as a graph'}</h1>
              <p>
                {snapshot
                  ? 'This configuration could not be projected. Use Source JSON to inspect the complete file.'
                  : 'Create a configuration or read one from your server.'}
              </p>
              {!snapshot && (
                <div className="empty-canvas-actions">
                  <button className="primary-button" disabled={blocked} onClick={newConfiguration}>
                    New configuration
                  </button>
                  <button
                    className="secondary-button"
                    disabled={blocked}
                    onClick={() => loadExample()}
                  >
                    Explore an example
                  </button>
                </div>
              )}
            </div>
          )}
          {busy && (
            <div className="busy-overlay">
              <div>
                <RefreshCw className="spin" size={25} />
                <strong>{busy}…</strong>
                <button
                  className="secondary-button"
                  onClick={() => {
                    requests.cancelled = true;
                    void client.cancel().catch(() => {});
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
        {propertiesVisible && snapshot && (
          <aside className="inspector" aria-label="Properties" inert={!!busy || setupBusy}>
            <header>
              <div>
                <strong>
                  {showConfig ? 'Source configuration' : (node?.data.title ?? 'Properties')}
                </strong>
                <span>{showConfig ? 'Original file · JSON / JSONC' : node?.data.subtitle}</span>
              </div>
              <button
                className="icon-button"
                aria-label="Hide properties"
                onClick={() => {
                  if (discardInline()) setPropertiesVisible(false);
                }}
              >
                <X size={18} />
              </button>
            </header>
            {!showConfig && node && (
              <div className="editor-tab-list inspector-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={propertiesTab === 'properties'}
                  onClick={() => setPropertiesTab('properties')}
                >
                  Properties
                </button>
                <button
                  role="tab"
                  aria-selected={propertiesTab === 'json'}
                  onClick={() => {
                    if (discardInline()) setPropertiesTab('json');
                  }}
                >
                  JSON
                </button>
              </div>
            )}
            <div className="inspector-body">
              {!showConfig && !node && <p className="muted">Select a node to inspect.</p>}
              {!showConfig && node && view && (
                <div className="remote-node-actions">
                  {nodeSettings(view, node.id) &&
                    !inlineSettings(node.id, nodeSettings(view, node.id)?.value) && (
                      <button
                        className="secondary-button"
                        disabled={!!busy}
                        onClick={() => openNode(node.id)}
                      >
                        Edit…
                      </button>
                    )}
                </div>
              )}
              {showConfig || (node && propertiesTab === 'json') ? (
                <>
                  <button
                    className="secondary-button reveal-button"
                    onClick={() => setReveal(!reveal)}
                  >
                    {reveal ? <EyeOff size={15} /> : <Eye size={15} />}{' '}
                    {reveal ? 'Hide credentials' : 'Reveal credentials'}
                  </button>
                  <pre className="code-block json-view" tabIndex={0}>
                    {visibleJson}
                  </pre>
                </>
              ) : (
                <>
                  {node && view && inlineSettings(node.id, nodeSettings(view, node.id)?.value) ? (
                    <InlineNodeSettings
                      key={
                        node.id +
                        ':' +
                        inlineRevision +
                        ':' +
                        JSON.stringify(nodeSettings(view, node.id)?.value)
                      }
                      {...nodeSettings(view, node.id)!}
                      destinations={routingDestinations(view)}
                      onDirty={setInlineDirty}
                      onSave={(value) => saveNodeSettings(node.id, value)}
                    />
                  ) : selectedSet && users && view ? (
                    <UserSetDetails
                      set={selectedSet}
                      config={view.original}
                      workspace={users}
                      onEdit={() => setUsersDialog({ initial: selectedSet })}
                      onConnect={assignSet}
                      onDisconnect={disconnectSet}
                      onRemove={() => {
                        setUsers({
                          sets: users.sets.filter((s) => s.id !== selectedSet.id),
                          bindings: users.bindings.filter((b) => b.set !== selectedSet.id),
                        });
                        setSelected('');
                      }}
                    />
                  ) : node?.data.rules ? (
                    <>
                      <p className="rule-order">
                        First matching rule wins. Unmatched traffic uses the first outbound.
                      </p>
                      <div className="rule-list">
                        {node.data.rules.map((rule, index) => (
                          <article key={index}>
                            <header>
                              <span>{index + 1}</span>
                              <strong>
                                {typeof rule.ruleTag === 'string'
                                  ? rule.ruleTag
                                  : 'Rule ' + (index + 1)}
                              </strong>
                              <span className="rule-destination">
                                → {String(rule.balancerTag ?? rule.outboundTag)}
                              </span>
                            </header>
                            <p>
                              {ruleConditions(
                                reveal ? rule : (redact(rule) as Record<string, unknown>),
                              )}
                            </p>
                            <details>
                              <summary>JSON</summary>
                              <pre className="code-block">
                                {JSON.stringify(reveal ? rule : redact(rule), null, 2)}
                              </pre>
                            </details>
                          </article>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      {node?.data.inboundIndex !== undefined && node.data.userProtocol && users && (
                        <InboundUserAssignments
                          index={node.data.inboundIndex}
                          workspace={users}
                          onEdit={(set) => setUsersDialog({ initial: set })}
                          onDisconnect={disconnectSet}
                          onChoose={() =>
                            setUsersDialog({
                              initial: null,
                              protocol: node.data.userProtocol,
                              inbound: node.data.inboundIndex,
                              targetName: node.data.title,
                            })
                          }
                        />
                      )}
                      <dl className="detail-facts">
                        {node?.data.facts.map(([name, value]) => (
                          <div key={name}>
                            <dt>{name}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </>
                  )}
                </>
              )}
            </div>
          </aside>
        )}
      </main>
      <footer className="app-footer">
        <span>
          <ShieldCheck size={14} />
          {settingsDirty || usersDirty || documentDirty || inlineDirty
            ? 'Local draft'
            : snapshot
              ? 'Configuration snapshot'
              : 'Ready'}
        </span>
        <span>{sourceLabel || 'SSH / SFTP'}</span>
        {snapshot?.sha256 && (
          <span className="snapshot-hash" title={snapshot.sha256}>
            SHA-256 {snapshot.sha256.slice(0, 12)}
          </span>
        )}
      </footer>
      {information && (
        <WorkspaceDialog
          mode={information}
          errors={compilation?.errors ?? []}
          notices={notices}
          onValidate={
            information === 'check' && canPrepareDeployment
              ? () => {
                  setInformation(null);
                  void prepareDeployment();
                }
              : undefined
          }
          onClose={() => setInformation(null)}
        />
      )}
      {nodeContext && (
        <NodeContextMenu
          x={nodeContext.x}
          y={nodeContext.y}
          label={
            displayedView?.nodes.find((item) => item.id === nodeContext.id)?.data.title ?? 'Node'
          }
          onClose={(restore) => {
            if (restore) nodeContext.opener.focus();
            setNodeContext(null);
          }}
          items={[
            { label: 'Edit…', disabled: blocked, action: () => openNode(nodeContext.id) },
            { label: 'Properties', action: () => selectNode(nodeContext.id) },
            {
              label: 'JSON',
              action: () => {
                if (discardInline() && selectNode(nodeContext.id)) setPropertiesTab('json');
              },
            },
          ]}
        />
      )}
      {deploymentOpen && snapshot && compilation && activeSession && sourceSession === session && (
        <ConfigDeploymentDialog
          client={client}
          sessionId={session}
          server={activeSession.name}
          path={snapshot.path}
          expectedSha256={snapshot.sha256}
          configText={deploymentConfigText}
          wayrillText={documentText}
          wayrillPath={snapshot.companion?.path}
          expectedWayrillSha256={snapshot.companion?.sha256 ?? null}
          companionAvailable={!snapshot.companion?.error}
          configChanged={!jsonEqual(compilation.config, sourceJson)}
          services={
            discovery?.files.find((file) => file.path === snapshot.path)?.services ??
            status?.xray.services.map((service) => service.name) ?? ['xray.service']
          }
          changed={serverDraftChanged}
          onApplied={(sha256, wayrillSha256) => {
            const text = deploymentConfigText;
            setSnapshot({
              path: snapshot.path,
              text,
              sha256,
              bytes: new TextEncoder().encode(text).length,
              companion: {
                path:
                  snapshot.companion?.path ??
                  snapshot.path.replace(/\.[^/.]+$/, '') + '.wayrill.json',
                text: documentText,
                sha256: wayrillSha256,
              },
            });
            setDocumentBaseline(documentText);
            setDocumentSynced(true);
            setSettingsDirty(false);
            setInlineDirty(false);
            if (users) setUsersBaseline(stable(users));
          }}
          onClose={() => setDeploymentOpen(false)}
        />
      )}
      {view && showStash && (
        <RemoteStash
          view={view}
          visible={visibleNodeIds}
          onEdit={(id) => {
            if (discardInline()) setSettingsId(id);
          }}
          onEditChain={(id) => {
            if (discardInline()) setChainRoot(Number(id.slice(11)));
          }}
          onShow={showGraphNode}
          onClose={() => setShowStash(false)}
        />
      )}
      {view && chainRoot !== null && (
        <RemoteChainSettings
          root={chainRoot}
          outbounds={configuredOutbounds(view)}
          onClose={() => setChainRoot(null)}
          onSave={(outbounds) => {
            if (!jsonEqual(outbounds, configuredOutbounds(view))) {
              const next = retainRoutingOutputs(
                view,
                remoteView(JSON.stringify(applyChain(view.original, outbounds))),
              );
              setView(next);
              setSettingsDirty(true);
            }
            setChainRoot(null);
          }}
        />
      )}
      {setupOpen && (
        <WinScpSetup
          inventory={inventory}
          busy={setupBusy}
          available={desktopAvailable || client !== nativeClient}
          error={setupError}
          onClose={() => setSetupOpen(false)}
          onChoose={(kind) => {
            void configure(() => client.choose(kind));
          }}
          onConfig={(config) => {
            void configure(() => client.setConfig(config));
          }}
          onReset={() => {
            void configure(() => client.resetSetup());
          }}
        />
      )}
      {view && editor && (
        <RemoteSettings
          key={settingsId}
          title={
            settingsId === 'native-options'
              ? 'Global'
              : (view.nodes.find((item) => item.id === settingsId)?.data.title ?? 'Node')
          }
          destinations={routingDestinations(view)}
          {...editor}
          userCount={
            compilation && settingsNode?.data.inboundIndex !== undefined
              ? inboundUsers(
                  inboundObjects(compilation.config)[settingsNode.data.inboundIndex] ?? {},
                ).length
              : undefined
          }
          onManageUsers={
            settingsNode?.data.userProtocol && settingsNode.data.inboundIndex !== undefined
              ? () => {
                  setUsersDialog({
                    initial: null,
                    protocol: settingsNode.data.userProtocol,
                    inbound: settingsNode.data.inboundIndex,
                    targetName: settingsNode.data.title,
                  });
                }
              : undefined
          }
          onSave={(value, listeners, outputs) =>
            saveNodeSettings(settingsId, value, listeners, outputs)
          }
          onClose={() => setSettingsId('')}
        />
      )}
      {usersDialog && libraryReady && (
        <UserLibraryDialog
          library={library}
          workspace={users}
          initial={usersDialog.initial}
          protocol={usersDialog.protocol}
          targetName={usersDialog.targetName}
          onSave={saveSet}
          onReplace={replaceLibrary}
          onUse={(set) => {
            if (!view || !users || !discardInline()) return false;
            let next = addSetToWorkspace(users, set);
            if (usersDialog.inbound !== undefined)
              next = connectUserSet(view.original, next, set.id, usersDialog.inbound);
            setUsers(next);
            setSelected(userNodeId(set.id));
            setShowConfig(false);
            setPropertiesTab('properties');
            return true;
          }}
          onClose={() => setUsersDialog(null)}
        />
      )}
      {statusOpen && (
        <ServerStatusDialog
          status={status}
          session={activeSession?.name ?? 'Remote server'}
          sessionId={session}
          client={client}
          busy={busy === 'Reading server status'}
          error={statusError}
          onRefresh={() => {
            void refreshStatus();
          }}
          onCancel={cancelStatus}
          onClose={() => {
            if (busy === 'Reading server status') cancelStatus();
            setStatusOpen(false);
          }}
        />
      )}
    </div>
  );
}
