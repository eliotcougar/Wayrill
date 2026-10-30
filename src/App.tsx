import RuntimeProgressOverlay from './components/RuntimeProgressOverlay';
import BackupDialog, { type BackupRequestState } from './components/BackupDialog';
import { isBackupFilter } from './backup/model';
import { writePreferences } from './backup/preferences';
import { errorText } from './serviceClient';
import { runtimeProgress } from './runtimeProgress';
import useSubscriptionMaintenance, {
  SubscriptionMaintenanceContext,
} from './profiles/useSubscriptionMaintenance';
import IcsEditor from './components/IcsEditor';
import { readImportText } from './importText';
import useFileRead from './components/useFileRead';
import useInternetSharing from './useInternetSharing';
import {
  configureIcsGraph,
  sharingAction,
  canUseSharing,
  hasIcsCapture,
} from './graph/internetSharing';
import DeleteGraphSelection from './components/DeleteGraphSelection';
import { boundedText } from './text';
import useResourceSync from './useResourceSync';
import { spaceNodes } from './graph/placement';
import { exportFile } from './exportFile';
import {
  DiagnosticFocusContext,
  focusDiagnostic,
  type DiagnosticFocusRequest,
} from './components/DiagnosticNavigation';
import { hasNodeEditor } from './graph/editorNavigation';
import type { Diagnostic } from './graph/types';
import useOutboundTests, { OutboundTestsContext } from './useOutboundTests';
import {
  ObservatoryContext,
  compatibleObservedGroups,
  observedGroupSummaries,
} from './observatorySummary';
import OutboundTestSettings from './components/OutboundTestSettings';
import OutboundTestResults from './components/OutboundTestResults';
import useExecutionGraph from './useExecutionGraph';
import useWorkspaceViewport from './useWorkspaceViewport';
import useEdgeRouting from './useEdgeRouting';
import { connectionTypes, sourceConnectionKind } from './graph/connectionTypes';
import SchematicEdge, { EdgeRoutesContext } from './components/SchematicEdge';
import { appVersion } from './version';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  MarkerType,
  Panel,
  ReactFlow,
  SelectionMode,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type Viewport,
} from '@xyflow/react';
import {
  AlertCircle,
  Activity,
  Gauge,
  Timer,
  Check,
  Cable,
  CircleHelp,
  Copy,
  Download,
  Expand,
  Hand,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Plus,
  Redo2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import Dialog from './components/Dialog';
import XrayImportDialog from './components/XrayImportDialog';
import CaptureEditor from './components/CaptureEditor';
import SystemCaptureSettings from './components/SystemCaptureSettings';
import Inspector from './components/Inspector';
import MenuBar, { type Menu } from './components/MenuBar';
import NodePalette from './components/NodePalette';
import RuleNode from './components/RuleNode';
import { OutboundInterfacesContext, useOutboundInterfaces } from './outboundInterfaces';
import ProxyChainEditor from './components/ProxyChainEditor';
import PolicyEditor from './components/PolicyEditor';
import { isPolicyKind } from './graph/policies';
import RuleTableEditor from './components/RuleTableEditor';
import FakeDnsEditor from './components/FakeDnsEditor';
import DnsEditor from './components/DnsEditor';
import NativeDnsEditor from './components/NativeDnsEditor';
import CoreOptionsEditor from './components/CoreOptionsEditor';
import { isNativeConfigEditor, isNativeXrayKind } from './graph/xrayNodes';
import GlobalDefaultsEditor from './components/GlobalDefaultsEditor';
import RuntimePanel from './components/RuntimePanel';
import GraphRuntimeToolbar from './components/GraphRuntimeToolbar';
import GraphCheckDialog from './components/GraphCheckDialog';
import createGraphRuntimeActions from './createGraphRuntimeActions';
import TrafficPanel from './components/TrafficPanel';
import useTrafficHistory from './useTrafficHistory';
import { useTrafficUnits } from './trafficUnits';
import { formatRate } from './traffic';
import { automaticFakeDns } from './graph/fakeDns';
import { FakeDnsUsageContext, fakeDnsUsageSummary } from './fakeDnsUsage';
import { NodeEditorContext } from './components/NodeEditorContext';
import { availableNodes, getDefinition, portLabel, getOutputPorts } from './graph/catalog';
import { bundledExamples } from './graph/examples';
import { isRuleTableKind } from './graph/rules';
import { isDnsEditor } from './graph/dns';
import { parseGraph, toDocument, updateGraphNode } from './graph/model';
import { commitEditorDraft } from './graph/editorDraft';
import { editGraphNode } from './graph/nodeEditing';
import { jsonEqual } from './graph/xrayJson';
import { effectiveDefaults, factoryDefaults } from './graph/defaults';
import DiagnosticsDialog from './components/DiagnosticsDialog';
import { isGraphInbound, isDisabledInbound } from './graph/inboundState';
import {
  connectionEditProblem,
  connectionIsEditable,
  connectionSources,
} from './graph/connectionEditing';
import ConnectionEditor, { type ConnectionRequest } from './components/ConnectionEditor';
import useGraphAnalysis from './useGraphAnalysis';
import { runtimePresentation } from './runtimePresentation';
import useRuntime from './useRuntime';
import useClosePersistence from './useClosePersistence';
import useStash from './profiles/useStash';
import useAppliedSubscriptionGraph from './profiles/useAppliedSubscriptionGraph';
import { replaceRunningOutbound } from './profiles/serviceSubscriptions';
import { applyStashedProfile } from './profiles/graph';
import { isOutboundKind } from './graph/outbounds';
import { canDuplicateNode } from './graph/editing';
import NodeContextMenu from './components/NodeContextMenu';
import { isProtocolKind } from './graph/protocols';
import ProtocolEditor from './components/ProtocolEditor';
import ConfigurationStash from './components/ConfigurationStash';
import { GraphDiagnosticsContext } from './components/GraphDiagnosticsContext';
import type {
  GraphState,
  NodeKind,
  RuleEdge,
  RuleNode as RuleNodeType,
  RuleNodeData,
} from './graph/types';
import useGraphEditor from './useGraphEditor';
import useTheme from './useTheme';
import AppearanceSettings from './components/AppearanceSettings';
import StartupSettings from './components/StartupSettings';
import TunAdapterSettings from './components/TunAdapterSettings';
import { MainOutboundContext } from './components/MainOutboundContext';
import { setMainOutbound, starredChoices } from './quickSwitch';
import useQuickSwitch from './useQuickSwitch';
import OutboundTestButtons from './components/OutboundTestButtons';
import { findStashEntry } from './profiles/stashModel';
import type { StashEntry } from './profiles/import';
import type { StashLink } from './graph/types';

const nodeTypes = { rule: RuleNode };
const edgeTypes = { schematic: SchematicEdge };
type DialogKind = 'help' | 'about' | 'validation' | null;

export default function App() {
  const trafficUnits = useTrafficUnits();
  const theme = useTheme();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState<BackupRequestState | null>(null);
  const stash = useStash();
  const runtime = useRuntime();
  const progress = runtimeProgress(runtime);
  const [switchingOutbound, setSwitchingOutbound] = useState(false);
  const switching = useRef(false);
  const graphBlocked = !!progress || switchingOutbound;
  const editor = useGraphEditor(
    stash.ready ? stash.stash : undefined,
    stash.ready ? stash : undefined,
    graphBlocked,
  );
  const graphFileRead = useFileRead();
  // Opening a different graph supersedes any file read still in progress.
  const cancelGraphRead = graphFileRead.cancel;
  useEffect(() => {
    cancelGraphRead();
  }, [editor.loadVersion, cancelGraphRead]);
  const loadGraph = (graph: GraphState) => {
    const accepted = editor.loadGraph(graph);
    if (accepted) cancelGraphRead();
    return accepted;
  };
  const outboundInterfaces = useOutboundInterfaces();
  const outboundTests = useOutboundTests(
    editor.graph,
    stash.stash,
    JSON.stringify([
      outboundInterfaces.automatic,
      outboundInterfaces.captured,
      outboundInterfaces.adapters.map((a) => [a.name, a.active]),
    ]),
  );
  const [testSettingsOpen, setTestSettingsOpen] = useState(false);
  const subscriptionMaintenance = useSubscriptionMaintenance(
    stash,
    editor.graph,
    stash.ready && editor.storageReady && runtime.connected,
    outboundTests.busy,
    outboundTests.settings.value.testUrl,
    JSON.stringify([
      outboundInterfaces.automatic,
      outboundInterfaces.captured,
      outboundInterfaces.adapters,
    ]),
    runtime.subscriptions,
  );
  const resourceScheduleError = useResourceSync(editor.graph, runtime.connected);
  const trafficHistory = useTrafficHistory(runtime);
  const [trafficOpen, setTrafficOpen] = useState(false);
  const [stashOpen, setStashOpen] = useState(false);
  const [deletingSelection, setDeletingSelection] = useState(false);
  const [replaceNodeId, setReplaceNodeId] = useState<string | null>(null);
  const [nodeContext, setNodeContext] = useState<{
    nodeId: string;
    x: number;
    y: number;
    opener: HTMLElement;
  } | null>(null);
  const [xrayImportOpen, setXrayImportOpen] = useState(false);
  const flow = useReactFlow<RuleNodeType, RuleEdge>();
  const edgeLayout = useEdgeRouting();
  const edgeRoutes = edgeLayout.paths;
  const canvas = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const reconnectingEdge = useRef<string | null>(null);
  const connectionTrigger = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<'select' | 'pan'>('select');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [libraryVisible, setLibraryVisible] = useState(true);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [icsSetupOpen, setIcsSetupOpen] = useState(false);
  const [icsFilter, setIcsFilter] = useState(false);
  const [startupOpen, setStartupOpen] = useState(false);
  const [tunAdaptersOpen, setTunAdaptersOpen] = useState(false);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const [defaultsSection, setDefaultsSection] = useState<string | undefined>();
  const [windowsCaptureOpen, setWindowsCaptureOpen] = useState(false);
  const [connectionRequest, setConnectionRequest] = useState<ConnectionRequest | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingGraph, setEditingGraph] = useState<GraphState | null>(null);
  const [editorInitialTab, setEditorInitialTab] = useState<'log' | 'export' | undefined>();
  const [diagnosticFocus, setDiagnosticFocus] = useState<DiagnosticFocusRequest | null>(null);
  const graphCheckTrigger = useRef<HTMLButtonElement>(null);
  const runtimeTrigger = useRef<HTMLButtonElement>(null);
  const [portIssue, setPortIssue] = useState<Diagnostic | null>(null);
  useEffect(() => {
    if (!portIssue?.nodeId) return;
    let cancelled = false;
    void flow
      .fitView({
        nodes: [{ id: portIssue.nodeId }],
        padding: 0.6,
        maxZoom: 0.9,
        duration: 0,
      })
      .then(() => {
        if (!cancelled && canvas.current) focusDiagnostic(canvas.current, portIssue);
      });
    return () => {
      cancelled = true;
    };
  }, [portIssue, flow, inspectorVisible]);
  const editingNode = editingGraph?.nodes.find((node) => node.id === editingNodeId);
  const openNodeEditor = (id: string, tab?: 'log' | 'export') => {
    setEditorInitialTab(tab);
    setDiagnosticFocus(null);
    editor.selectNode(id);
    setEditingGraph(editor.getGraph());
    setSpaceHeld(false);
    setEditingNodeId(id);
  };
  const closeNodeEditor = () => {
    setEditingNodeId(null);
    setEditingGraph(null);
    setEditorInitialTab(undefined);
    setDiagnosticFocus(null);
  };
  const requireGraphSave = (accepted: boolean) => {
    if (!accepted)
      throw new Error(
        'The graph is temporarily busy. Your draft is preserved; try saving again when the operation finishes.',
      );
  };
  const saveNodeGraph = (draft: GraphState) => {
    if (!editingGraph) return;
    requireGraphSave(editor.change((current) => commitEditorDraft(editingGraph, draft, current)));
  };
  const saveNodeData = (id: string, data: Partial<RuleNodeData>) => {
    if (editingGraph) saveNodeGraph(editGraphNode(editingGraph, id, data));
  };
  const reviewIssue = (issue: Diagnostic) => {
    const returnFocus = runtimeOpen ? runtimeTrigger.current : graphCheckTrigger.current;
    setRuntimeOpen(false);
    setDialog(null);
    setSpaceHeld(false);
    if (issue.scope === 'defaults') {
      setDiagnosticFocus({ issue, surface: 'defaults', returnFocus });
      setDefaultsOpen(true);
      return;
    }
    const node = editor.graph.nodes.find((n) => n.id === issue.nodeId);
    if (!node) return;
    editor.selectNode(node.id);
    setInspectorVisible(true);
    if (issue.portId) {
      setDiagnosticFocus(null);
      setPortIssue({ ...issue });
    } else if (hasNodeEditor(node.data)) {
      setDiagnosticFocus({ issue, surface: 'editor', returnFocus });
      setEditingGraph(editor.getGraph());
      setEditingNodeId(node.id);
    } else setDiagnosticFocus({ issue, surface: 'inspector' });
  };
  const [feedback, setFeedback] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const notify = useCallback(
    (message: string, error = false) => setFeedback({ message, error }),
    [],
  );
  const closeDesktop = useClosePersistence(
    editor.serializeForClose,
    editor.storageReady,
    editor.serializeStashForClose,
    stash.ready,
    (message) => notify(message, true),
    stash.getBase,
  );
  const [view, setView] = useState<Viewport>(
    () => editor.graph.viewport ?? { x: 0, y: 0, zoom: 1 },
  );
  useWorkspaceViewport({
    loadVersion: editor.loadVersion,
    ready: !editor.loading,
    viewport: editor.graph.viewport,
    nodeIds: editor.graph.nodes.map((node) => node.id),
  });
  const paletteNodes = availableNodes.filter((item) =>
    editor.graph.xray
      ? isProtocolKind(item.kind) ||
        [
          'proxy-inbound',
          'xray-inbound',
          'xray-outbound',
          'xray-dns-servers',
          'fakedns',
          'vless-outbound',
          'socks-outbound',
          'direct-outbound',
          'block-outbound',
          'policy-group',
        ].includes(item.kind) ||
        (item.kind === 'observatory' &&
          !editor.graph.nodes.some((n) => n.data.kind === 'observatory')) ||
        (item.kind === 'xray-dns' && !editor.graph.nodes.some((n) => n.data.kind === 'xray-dns'))
      : !isNativeXrayKind(item.kind),
  );
  const selectedCount = editor.selectedNodes.length + editor.selectedEdges.length;
  const executionGraph = useExecutionGraph(editor.graph);
  const analysis = useGraphAnalysis(executionGraph);
  const issues = analysis.issues;
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const issuesByNode = useMemo(
    () =>
      Object.fromEntries(
        editor.graph.nodes.map((n) => [n.id, issues.filter((i) => i.nodeId === n.id)]),
      ),
    [editor.graph.nodes, issues],
  );
  const sharing = useInternetSharing(
    `${runtime.connected}:${editor.loadVersion}:${dialog === 'validation'}:${runtime.snapshot?.core.state}:${runtime.snapshot?.config.revision}`,
  );
  const [sharingDismissed, setSharingDismissed] = useState('');
  const [focusNodeIds, setFocusNodeIds] = useState<string[] | null>(null);
  const focusNodesReady = useStore(
    (state) =>
      focusNodeIds !== null &&
      focusNodeIds.every((id) => {
        const node = state.nodeLookup.get(id);
        return Boolean(node?.measured.width && node.measured.height);
      }),
  );
  useEffect(() => {
    if (!focusNodeIds || !focusNodesReady) return;
    void flow.fitView({
      nodes: focusNodeIds.map((id) => ({ id })),
      padding: 0.25,
      maxZoom: 1,
      duration: 180,
    });
    setFocusNodeIds(null);
  }, [flow, focusNodeIds, focusNodesReady]);
  const sharingKey = `${editor.loadVersion}:${sharing.value?.version}:${sharing.value?.recoveryPending}`;
  const configureSharing = (filtered: boolean) => {
    try {
      if (!sharing.value) return;
      const bounds = canvas.current?.getBoundingClientRect();
      const position = bounds
        ? flow.screenToFlowPosition({
            x: bounds.left + 60,
            y: bounds.top + bounds.height / 2 - 100,
          })
        : { x: 100, y: 100 };
      const next = configureIcsGraph(editor.graph, sharing.value, position, filtered);
      editor.change(() => next);
      const node = next.nodes.find((n) => n.data.kind === 'ics-tun');
      if (node) {
        setFocusNodeIds(
          next.nodes
            .filter((n) => n.id === node.id || !editor.graph.nodes.some((old) => old.id === n.id))
            .map((n) => n.id),
        );
        openNodeEditor(node.id);
      }
      sharing.refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not configure sharing.', true);
    }
  };
  const graphActions = createGraphRuntimeActions(executionGraph, analysis, runtime);
  const graphCompilation = analysis.compilation;
  useAppliedSubscriptionGraph(
    stash,
    runtime,
    editor.storageReady,
    subscriptionMaintenance.appliedRevision,
    subscriptionMaintenance.appliedSourceHash,
  );
  const compatibleObservations = useMemo(
    () =>
      compatibleObservedGroups(
        graphCompilation?.config,
        runtime.savedConfig,
        graphCompilation?.displayNames?.observed,
      ),
    [graphCompilation?.config, graphCompilation?.displayNames?.observed, runtime.savedConfig],
  );
  const observationSummaries = useMemo(
    () =>
      observedGroupSummaries(
        runtime.connected ? runtime.snapshot : null,
        compatibleObservations,
        runtime.savedRevision,
      ),
    [runtime.connected, runtime.snapshot, compatibleObservations, runtime.savedRevision],
  );
  const runtimeView = runtimePresentation(runtime, graphCompilation);
  if (analysis.pending) {
    runtimeView.draftState = 'Checking the current draft…';
    runtimeView.footer = runtimeView.footer.replace('Graph errors', 'Checking graph…');
    runtimeView.description =
      runtimeView.description.replace('Graph errors', 'Checking graph…') +
      ' Current draft checks are pending.';
  }
  const pan = mode === 'pan' || spaceHeld;

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 5500);
    return () => clearTimeout(timer);
  }, [feedback]);
  const showNodeLibrary = () => {
    setLibraryVisible(true);
    requestAnimationFrame(() => document.getElementById('node-search')?.focus());
  };
  const openStash = (nodeId?: string) => {
    setReplaceNodeId(nodeId ?? null);
    setStashOpen(true);
  };
  const favorites = useMemo(() => starredChoices(stash.stash), [stash.stash]);
  const assignStashedOutbound = (entry: StashEntry, link: StashLink, replaceId?: string) => {
    if (switching.current || graphBlocked) throw new Error('An operation is already in progress.');
    const current = editor.getGraph();
    const chosen = findStashEntry(stash.get(), link);
    if (!chosen || chosen.id !== entry.id) throw new Error('This Stash entry no longer exists.');
    const bounds = canvas.current?.getBoundingClientRect();
    const position = bounds
      ? flow.screenToFlowPosition({
          x: bounds.left + bounds.width / 2 - 105,
          y: bounds.top + bounds.height / 2 - 70,
        })
      : { x: 100, y: 100 };
    const next = applyStashedProfile(current, chosen, position, replaceId, link);
    requireGraphSave(editor.change(() => next));
    setInspectorVisible(true);
    if (!replaceId) {
      notify(`Added ${chosen.name}.`);
      return Promise.resolve();
    }
    if (
      !runtime.connected ||
      (runtime.snapshot?.core.state !== 'running' &&
        runtime.snapshot?.recovery?.desiredState !== 'running') ||
      runtime.snapshot?.recovery?.desiredState === 'stopped'
    ) {
      notify(`Replaced outbound with ${chosen.name}.`);
      return Promise.resolve();
    }
    switching.current = true;
    setSwitchingOutbound(true);
    return stash
      .flush()
      .then(() => replaceRunningOutbound(replaceId, link))
      .then((completed) => {
        notify(completed ? `Switched to ${chosen.name}.` : 'Replacement cancelled. Draft kept.');
      })
      .finally(() => {
        switching.current = false;
        setSwitchingOutbound(false);
      });
  };
  const replaceFavorite = async (nodeId: string, link: StashLink) => {
    const entry = findStashEntry(stash.get(), link);
    if (!entry?.starred) throw new Error('This item is no longer starred. Select it from Stash.');
    await assignStashedOutbound(entry, link, nodeId);
  };
  const switchFailed = (error: unknown) => {
    const message = 'Outbound replacement failed: ' + errorText(error);
    runtime.setError(message);
    notify(message, true);
  };
  useQuickSwitch({
    graph: editor.graph,
    stash: stash.stash,
    enabled:
      editor.storageReady &&
      stash.ready &&
      !graphBlocked &&
      !editingNodeId &&
      !stashOpen &&
      !connectionRequest &&
      !deletingSelection &&
      !dialog &&
      !xrayImportOpen &&
      !defaultsOpen &&
      !startupOpen &&
      !tunAdaptersOpen &&
      !windowsCaptureOpen &&
      !icsSetupOpen &&
      !backupOpen,
    onReplace: replaceFavorite,
    onBrowse: openStash,
    onError: (message) => switchFailed(message),
  });
  const contextNode = editor.graph.nodes.find((node) => node.id === nodeContext?.nodeId);
  const replacementNode = editor.graph.nodes.find((node) => node.id === replaceNodeId);
  useEffect(() => {
    if (nodeContext && !contextNode) setNodeContext(null);
  }, [nodeContext, contextNode]);
  const closeNodeContext = (restore = false) => {
    if (restore && nodeContext?.opener.isConnected)
      nodeContext.opener.focus({ preventScroll: true });
    setNodeContext(null);
  };
  const showNodeProperties = (nodeId: string, rename = false) => {
    editor.selectNode(nodeId);
    setInspectorVisible(true);
    requestAnimationFrame(() => {
      const input = document.getElementById('node-label') as HTMLInputElement | null;
      if (rename) {
        input?.focus();
        input?.select();
      } else {
        const field = document.querySelector<HTMLElement>(
          '.inspector [id^="setting-"]:is(input,select,textarea)',
        );
        (field ?? input)?.focus();
      }
    });
  };
  const openNodeContext = (nodeId: string, opener: HTMLElement, x: number, y: number) => {
    editor.selectNode(nodeId);
    setSpaceHeld(false);
    setNodeContext({ nodeId, opener, x, y });
  };
  const addNode = (kind: NodeKind, position?: { x: number; y: number }) => {
    const bounds = canvas.current?.getBoundingClientRect();
    const center = bounds
      ? flow.screenToFlowPosition({
          x: bounds.left + bounds.width / 2 - 105,
          y: bounds.top + bounds.height / 2 - 70,
        })
      : { x: 100, y: 100 };
    try {
      const added = editor.addNode(kind, position ?? center);
      if (kind === 'ics-tun') openNodeEditor(added.id);
      if (!position)
        requestAnimationFrame(() => {
          const viewport = flow.getViewport();
          const point = flow.flowToScreenPosition(added.position);
          const area = canvas.current?.getBoundingClientRect();
          if (
            area &&
            (point.x < area.left ||
              point.y < area.top ||
              point.x + 250 * viewport.zoom > area.right ||
              point.y + 230 * viewport.zoom > area.bottom)
          )
            void flow.setCenter(added.position.x + 125, added.position.y + 115, {
              zoom: viewport.zoom,
              duration: 180,
            });
        });
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not add this node.', true);
      return;
    }
    setInspectorVisible(true);
    notify(`Added ${getDefinition(kind).title.toLowerCase()}.`);
  };
  const fit = () => void flow.fitView({ padding: 0.18, duration: 250, maxZoom: 1.2 });
  const space = () => {
    try {
      editor.change((graph) => ({ ...graph, nodes: spaceNodes(graph.nodes) }));
      notify('Node spacing updated.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not space nodes.', true);
    }
  };
  const graphName = editor.graph.name;
  const serializeGraphDraft = editor.serialize;
  const exportGraph = useCallback(async () => {
    const name =
      graphName
        .replace(/[^a-zA-Z0-9 _-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase() || 'wayrill';
    try {
      if (await exportFile(`${name}.wayrill.json`, serializeGraphDraft()))
        notify('Graph exported. This file contains plaintext credentials.');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [serializeGraphDraft, graphName, notify]);
  async function exportXray() {
    try {
      if (!graphCompilation)
        throw new Error(
          analysis.pending
            ? 'The graph is still being checked.'
            : 'Correct graph issues before exporting.',
        );
      if (graphCompilation.capture?.inputs.some((input) => input.predicates.length > 0))
        throw new Error(
          'Windows application rules require the Wayrill service plan. Export the graph to preserve them.',
        );
      if (await exportFile('wayrill.xray.json', JSON.stringify(graphCompilation.config, null, 2)))
        notify('Xray configuration exported. It includes configured credentials.');
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }
  async function openFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const isCurrent = graphFileRead.begin();
    const before = editor.getGraph();
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error('Graph files must be at most 64 MiB.');
      const text = await readImportText(file);
      if (!isCurrent()) return;
      const current = editor.getGraph();
      // Preserve edits made during a slow read, without treating selection or
      // panning as document changes. Use the same document model as saved files.
      if (
        before !== current &&
        !jsonEqual(
          toDocument({ ...before, viewport: undefined }),
          toDocument({ ...current, viewport: undefined }),
        )
      )
        throw new Error(
          'The graph changed while the file was opening. Open it again to replace the current graph.',
        );
      const graph = parseGraph(text);
      if (!loadGraph(graph))
        throw new Error('Wait for the current operation to finish, then open the graph again.');
      notify(`Opened ${graph.name}.`);
    } catch (error) {
      if (isCurrent())
        notify(error instanceof Error ? error.message : 'Could not open this graph.', true);
    }
  }
  const openConnection = (request: ConnectionRequest = {}) => {
    setSpaceHeld(false);
    setDiagnosticFocus(null);
    setPortIssue(null);
    setConnectionRequest(request);
  };
  const newConnection = () => {
    const node = editor.selectedNodes[0];
    openConnection(
      node && getOutputPorts(node.data.kind, node.data).length ? { sourceId: node.id } : {},
    );
  };
  const saveConnection = (connection: Connection, edgeId?: string) => {
    const problem = editor.saveConnection(connection, edgeId);
    if (problem) {
      notify(problem, true);
      return problem;
    }
    setInspectorVisible(true);
    notify(
      edgeId
        ? 'Connection updated. Undo restores its previous endpoints.'
        : 'Connection added. Undo removes it.',
    );
    return null;
  };
  const onConnect = (connection: Connection) => {
    saveConnection(connection);
  };
  const onReconnect = (old: RuleEdge, connection: Connection) => {
    saveConnection(connection, old.id);
  };
  const isValidConnection = (connection: Connection | Edge) => {
    const ignoredId = reconnectingEdge.current ?? ('id' in connection ? connection.id : undefined);
    return !connectionEditProblem(
      editor.graph,
      {
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? null,
        targetHandle: connection.targetHandle ?? null,
      },
      ignoredId,
    );
  };
  const showConnection = (id: string) => {
    const edge = editor.graph.edges.find((e) => e.id === id);
    if (edge)
      void flow.fitView({
        nodes: [{ id: edge.source }, { id: edge.target }],
        padding: 0.4,
        maxZoom: 1,
        duration: 0,
      });
  };
  const selectConnection = (id: string) => {
    editor.selectEdge(id);
    setInspectorVisible(true);
    showConnection(id);
    requestAnimationFrame(() =>
      document.getElementById('selected-connection-heading')?.focus({ preventScroll: true }),
    );
  };
  const duplicateSelected = () => {
    try {
      editor.duplicateSelected();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not duplicate this selection.', true);
    }
  };
  const deleteSelection = () => {
    if (
      !editor.selectedNodes.length &&
      editor.selectedEdges.length &&
      !editor.selectedEdges.some((edge) => connectionIsEditable(editor.graph, edge))
    ) {
      notify(
        'This query path is generated by Xray DNS settings. Edit the DNS servers to change it.',
        true,
      );
      return;
    }
    if (selectedCount) {
      if (editor.selectedNodes.some((n) => n.data.stashLink)) {
        setDeletingSelection(true);
        return;
      }
      editor.removeSelected();
      notify('Selection deleted. Undo restores it.');
    }
  };
  const decoratedEdges = useMemo(
    () =>
      editor.graph.edges
        .map((edge) => {
          const source = editor.graph.nodes.find((node) => node.id === edge.source);
          const kind = source
            ? sourceConnectionKind(source.data, edge.sourceHandle ?? '')
            : 'traffic';
          const connectionType = connectionTypes[kind];
          const color = connectionType.color;
          return {
            ...edge,
            type: 'schematic',
            className: [
              edge.className,
              source && isDisabledInbound(source.data) ? 'is-disabled-inbound' : '',
            ]
              .filter(Boolean)
              .join(' '),
            data: { ...edge.data, connectionKind: kind },
            label: (() => {
              const source = editor.graph.nodes.find((node) => node.id === edge.source);
              return source &&
                (isRuleTableKind(source.data.kind) ||
                  source.data.kind === 'fakedns' ||
                  isDnsEditor(source.data) ||
                  isPolicyKind(source.data.kind) ||
                  isNativeConfigEditor(source.data.kind))
                ? portLabel(edge.sourceHandle ?? '', source.data)
                : edge.sourceHandle === 'match'
                  ? 'matches'
                  : edge.sourceHandle === 'otherwise'
                    ? 'otherwise'
                    : undefined;
            })(),
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 17,
              height: 17,
              color,
            },
            style: {
              stroke: color,
              strokeWidth: edge.selected ? 2.6 : 1.8,
              ...(connectionType.dash ? { strokeDasharray: connectionType.dash } : {}),
            },
            labelStyle: { fill: color, fontSize: 10, fontWeight: 500 },
            labelBgStyle: { fill: 'var(--surface-sunken)', fillOpacity: 1 },
            labelBgPadding: [7, 4] as [number, number],
            labelBgBorderRadius: 4,
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
    [editor.graph.edges, editor.graph.nodes],
  );

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // Modal dialogs own the keyboard, including dialogs added after this handler.
      if (
        event.defaultPrevented ||
        graphBlocked ||
        nodeContext ||
        document.querySelector('dialog[open]')
      )
        return;
      const target = event.target as HTMLElement;
      const typing = target.closest('input,textarea,select,[contenteditable="true"]');
      const key = event.key.toLowerCase();
      const control = event.ctrlKey || event.metaKey;
      if (control && key === 's') {
        event.preventDefault();
        void exportGraph();
        return;
      }
      if (control && key === 'o') {
        event.preventDefault();
        fileInput.current?.click();
        return;
      }
      if (typing) return;
      if (control && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) editor.redo();
        else editor.undo();
      } else if (control && key === 'y') {
        event.preventDefault();
        editor.redo();
      } else if (control && key === 'd') {
        event.preventDefault();
        duplicateSelected();
      } else if (control && key === 'a') {
        event.preventDefault();
        editor.selectAll();
      } else if (key === 'delete' || key === 'backspace') {
        event.preventDefault();
        deleteSelection();
      } else if (key === ' ' && target.tagName !== 'BUTTON') {
        event.preventDefault();
        setSpaceHeld(true);
      } else if (!control && key === 'f') {
        event.preventDefault();
        fit();
      } else if (!control && key === 'n') {
        event.preventDefault();
        showNodeLibrary();
      } else if (!control && key === 'v') setMode('select');
      else if (!control && key === 'h') setMode('pan');
      else if (key === '?') setDialog('help');
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key === ' ') setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
    };
  });

  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        {
          label: 'New graph',
          action: () => {
            loadGraph({ name: 'Untitled graph', nodes: [], edges: [] });
            notify('New graph. Undo restores your previous workspace.');
          },
        },
        {
          label: 'Open graph…',
          shortcut: 'Ctrl+O',
          action: () => fileInput.current?.click(),
        },
        {
          label: 'Export graph…',
          shortcut: 'Ctrl+S',
          action: () => void exportGraph(),
        },
        {
          label: 'Back up…',
          disabled: !stash.ready || !editor.storageReady,
          action: () => setBackupOpen({ mode: 'create' }),
        },
        {
          label: 'Restore backup…',
          disabled: !stash.ready || !editor.storageReady,
          action: () => setBackupOpen({ mode: 'restore' }),
        },
        { label: 'Configuration stash / import…', action: () => openStash() },
        {
          label: 'Import Xray config as graph…',
          action: () => setXrayImportOpen(true),
        },
        {
          label: 'Export Xray configuration…',
          action: () => void exportXray(),
        },
        { label: '', separator: true },
        {
          label: 'Load Example',
          items: bundledExamples.flatMap((example, index) => [
            ...(index > 0 && example.category !== bundledExamples[index - 1].category
              ? [{ label: '', separator: true }]
              : []),
            {
              label: example.label,
              action: () => {
                if (loadGraph(example.create())) notify(example.message);
              },
            },
          ]),
        },
        ...(closeDesktop
          ? [
              { label: '', separator: true },
              { label: 'Close Wayrill', action: closeDesktop },
            ]
          : []),
      ],
    },
    {
      label: 'Edit',
      items: [
        {
          label: 'Undo',
          shortcut: 'Ctrl+Z',
          disabled: !editor.canUndo,
          action: editor.undo,
        },
        {
          label: 'Redo',
          shortcut: 'Ctrl+Shift+Z',
          disabled: !editor.canRedo,
          action: editor.redo,
        },
        { label: '', separator: true },
        {
          label: 'Duplicate selection',
          shortcut: 'Ctrl+D',
          disabled: !editor.canDuplicate,
          action: duplicateSelected,
        },
        {
          label: 'Delete selection',
          shortcut: 'Del',
          disabled: !selectedCount,
          action: deleteSelection,
        },
        {
          label: 'Select all nodes',
          shortcut: 'Ctrl+A',
          action: editor.selectAll,
        },
      ],
    },
    {
      label: 'View',
      items: [
        {
          label: 'Traffic statistics…',
          action: () => {
            setSpaceHeld(false);
            setTrafficOpen(true);
          },
        },
        { label: '', separator: true },
        { label: 'Fit graph', shortcut: 'F', action: fit },
        { label: 'Zoom in', action: () => void flow.zoomIn({ duration: 150 }) },
        {
          label: 'Zoom out',
          action: () => void flow.zoomOut({ duration: 150 }),
        },
        { label: '', separator: true },
        {
          label: `${libraryVisible ? 'Hide' : 'Show'} node library`,
          action: () => setLibraryVisible((value) => !value),
        },
        {
          label: `${inspectorVisible ? 'Hide' : 'Show'} properties`,
          action: () => setInspectorVisible((value) => !value),
        },
      ],
    },
    {
      label: 'Graph',
      items: [
        { label: 'Space overlapping nodes', action: space },
        { label: 'Add node…', shortcut: 'N', action: showNodeLibrary },
        { label: 'Add connection…', action: newConnection },
        {
          label: 'Edit selected connection…',
          disabled:
            editor.selectedEdges.length !== 1 ||
            !!editor.selectedNodes.length ||
            !connectionIsEditable(editor.graph, editor.selectedEdges[0]),
          action: () => openConnection({ edgeId: editor.selectedEdges[0]?.id }),
        },
        { label: 'Check graph', action: () => setDialog('validation') },
      ],
    },
    {
      label: 'Settings',
      items: [
        {
          label: 'Appearance…',
          action: () => {
            setSpaceHeld(false);
            setAppearanceOpen(true);
          },
        },
        {
          label: 'Startup…',
          action: () => {
            setSpaceHeld(false);
            setStartupOpen(true);
          },
        },
        {
          label: 'TUN adapters…',
          action: () => {
            setSpaceHeld(false);
            setTunAdaptersOpen(true);
          },
        },
        {
          label: 'Outbound tests…',
          action: () => {
            setSpaceHeld(false);
            setTestSettingsOpen(true);
          },
        },
        { label: '', separator: true },
        {
          label: 'System traffic capture…',
          action: () => {
            setSpaceHeld(false);
            setWindowsCaptureOpen(true);
          },
        },
        { label: '', separator: true },
        {
          label: 'Global defaults…',
          action: () => {
            setSpaceHeld(false);
            setDefaultsOpen(true);
          },
        },
        {
          label: 'Resource files…',
          action: () => {
            setSpaceHeld(false);
            setDefaultsSection('resources');
            setDefaultsOpen(true);
          },
        },
      ],
    },
    {
      label: 'Service',
      items: [{ label: 'Run graph…', action: () => setRuntimeOpen(true) }],
    },
    {
      label: 'Help',
      items: [
        {
          label: 'Keyboard & canvas',
          shortcut: '?',
          action: () => setDialog('help'),
        },
        { label: 'Application logs…', action: () => setLogsOpen(true) },
        { label: 'About Wayrill', action: () => setDialog('about') },
      ],
    },
  ].map((menu) =>
    ['File', 'Edit', 'Graph'].includes(menu.label) && graphBlocked
      ? {
          ...menu,
          items: menu.items.map((item) =>
            item.label === 'Close Wayrill' ? item : { ...item, disabled: true },
          ),
        }
      : menu.label === 'Settings' && graphBlocked
        ? {
            ...menu,
            items: menu.items.map((item) =>
              ['Global defaults…', 'Resource files…', 'System traffic capture…'].includes(
                item.label,
              )
                ? { ...item, disabled: true }
                : item,
            ),
          }
        : menu,
  );

  if (editor.loading)
    return (
      <div className="workspace-loading" role="status">
        <span className="brand-mark" aria-hidden="true" />
        <p>Opening protected workspace…</p>
      </div>
    );

  return (
    <OutboundInterfacesContext.Provider value={outboundInterfaces}>
      <SubscriptionMaintenanceContext.Provider value={subscriptionMaintenance}>
        <OutboundTestsContext.Provider value={outboundTests}>
          <ObservatoryContext.Provider value={observationSummaries}>
            <MainOutboundContext.Provider value={editor.graph.mainOutboundId}>
              <GraphDiagnosticsContext.Provider value={issuesByNode}>
                <NodeEditorContext.Provider value={openNodeEditor}>
                  <DiagnosticFocusContext.Provider value={diagnosticFocus}>
                    <div className="app-shell">
                      <MenuBar menus={menus} />
                      {testSettingsOpen && (
                        <OutboundTestSettings
                          settings={outboundTests.settings}
                          onClose={() => setTestSettingsOpen(false)}
                        />
                      )}
                      {outboundTests.open && <OutboundTestResults tests={outboundTests} />}
                      {tunAdaptersOpen && (
                        <TunAdapterSettings
                          runtime={runtime}
                          onClose={() => setTunAdaptersOpen(false)}
                        />
                      )}
                      {startupOpen && (
                        <StartupSettings runtime={runtime} onClose={() => setStartupOpen(false)} />
                      )}
                      {appearanceOpen && (
                        <AppearanceSettings
                          theme={theme}
                          onClose={() => setAppearanceOpen(false)}
                        />
                      )}
                      {backupOpen && (
                        <BackupDialog
                          request={backupOpen}
                          graph={editor.graph}
                          blocked={graphBlocked}
                          getSnapshot={() => ({ graph: editor.getGraph(), stash: stash.get() })}
                          onRestore={(restored, expected) => {
                            if (
                              (restored.graph || restored.stash) &&
                              (editor.getGraph() !== expected.graph ||
                                stash.get() !== expected.stash)
                            )
                              throw new Error(
                                'The Graph or Stash changed while preparing restoration. Review and try again.',
                              );
                            const preferences = restored.preferences
                              ? writePreferences(restored.preferences)
                              : undefined;
                            try {
                              if (restored.graph || restored.stash)
                                editor.restoreWorkspace(
                                  restored.graph ?? expected.graph,
                                  restored.stash ?? expected.stash,
                                  restored.resetViewport,
                                );
                            } catch (error) {
                              preferences?.rollback();
                              throw error;
                            }
                            preferences?.commit();
                            if (restored.graph && !restored.resetViewport) {
                              const originalIds = new Set(expected.graph.nodes.map((n) => n.id));
                              const added = restored.graph.nodes.filter(
                                (n) => !originalIds.has(n.id),
                              );
                              if (added.length) setFocusNodeIds(added.map((node) => node.id));
                            }
                          }}
                          onSaved={notify}
                          onClose={() => setBackupOpen(null)}
                        />
                      )}
                      {xrayImportOpen && (
                        <XrayImportDialog
                          applied={runtime.savedConfig}
                          onImport={(graph) => {
                            requireGraphSave(loadGraph(graph));
                            notify(
                              'Imported complete Xray configuration. Undo restores your previous workspace.',
                            );
                          }}
                          onClose={() => setXrayImportOpen(false)}
                        />
                      )}
                      {editor.storageError && (
                        <div className="storage-alert" role="alert">
                          Workspace storage is unavailable. {editor.storageError} Export this draft
                          before closing.
                        </div>
                      )}
                      <header className="toolbar" aria-label="Graph tools">
                        <button
                          className={`icon-button library-toggle${libraryVisible ? ' active-subtle' : ''}`}
                          onClick={() => setLibraryVisible((value) => !value)}
                          title={`${libraryVisible ? 'Hide' : 'Show'} node library · add nodes (N)`}
                          aria-label={`${libraryVisible ? 'Hide' : 'Show'} node library`}
                          aria-pressed={libraryVisible}
                        >
                          <PanelLeft size={18} aria-hidden="true" />
                          <Plus size={11} className="library-add-mark" aria-hidden="true" />
                        </button>

                        <div className="workspace-name">
                          <label htmlFor="graph-name">WORKSPACE</label>
                          <input
                            id="graph-name"
                            disabled={graphBlocked}
                            aria-label="Graph name"
                            value={editor.graph.name}
                            onChange={(event) =>
                              editor.change((graph) => ({
                                ...graph,
                                name: boundedText(event.target.value, 128),
                              }))
                            }
                          />
                        </div>
                        <div className="toolbar-divider" />
                        <div className="tool-group">
                          <button
                            className="icon-button"
                            onClick={editor.undo}
                            disabled={graphBlocked || !editor.canUndo}
                            title="Undo (Ctrl+Z)"
                            aria-label="Undo"
                          >
                            <Undo2 size={18} />
                          </button>
                          <button
                            className="icon-button"
                            onClick={editor.redo}
                            disabled={graphBlocked || !editor.canRedo}
                            title="Redo (Ctrl+Shift+Z)"
                            aria-label="Redo"
                          >
                            <Redo2 size={18} />
                          </button>
                        </div>
                        <div className="toolbar-divider" />
                        <div className="segmented-tools" inert={graphBlocked}>
                          <button
                            className={`icon-button${!pan ? ' active' : ''}`}
                            onClick={() => setMode('select')}
                            title="Select and move nodes (V)"
                            aria-label="Select tool"
                            aria-pressed={!pan}
                          >
                            <MousePointer2 size={17} />
                          </button>
                          <button
                            className={`icon-button${pan ? ' active' : ''}`}
                            onClick={() => setMode('pan')}
                            title="Pan canvas (H or hold Space)"
                            aria-label="Pan tool"
                            aria-pressed={pan}
                          >
                            <Hand size={17} />
                          </button>
                          <button
                            className="icon-button"
                            onClick={newConnection}
                            ref={connectionTrigger}
                            title="Add connection"
                            aria-label="Add connection"
                          >
                            <Cable size={17} />
                          </button>
                        </div>
                        <div className="toolbar-divider" />
                        <button
                          className="secondary-button"
                          disabled={graphBlocked}
                          onClick={() => openStash()}
                        >
                          Stash
                        </button>
                        <div className="toolbar-spacer" />
                        <button
                          className={`runtime-indicator${runtimeView.running ? ' running' : ''}`}
                          title={runtimeView.description}
                          onClick={() => setRuntimeOpen(true)}
                          aria-label={`Open Run graph. ${runtimeView.description}`}
                        >
                          <span aria-hidden="true" className="runtime-dot" />
                          {runtimeView.running
                            ? 'Running'
                            : runtimeView.current
                              ? runtimeView.core.value.charAt(0).toUpperCase() +
                                runtimeView.core.value.slice(1)
                              : runtime.desktop
                                ? 'Offline'
                                : 'Preview'}
                        </button>
                        <button
                          className="icon-button"
                          title="Traffic statistics"
                          aria-label="Open live traffic statistics"
                          onClick={() => setTrafficOpen(true)}
                        >
                          <Activity size={18} />
                        </button>
                        <div className="toolbar-traffic" aria-label="Live traffic rates">
                          <span>
                            ↑{' '}
                            {formatRate(
                              runtime.connected ? runtime.snapshot?.traffic?.uploadPerSecond : null,
                              trafficUnits.rate,
                            )}
                          </span>
                          <span>
                            ↓{' '}
                            {formatRate(
                              runtime.connected
                                ? runtime.snapshot?.traffic?.downloadPerSecond
                                : null,
                              trafficUnits.rate,
                            )}
                          </span>
                        </div>
                        <OutboundTestButtons
                          all
                          disabled={
                            !runtime.connected ||
                            !runtime.capabilities.includes('outbounds.testing')
                          }
                        />
                        <GraphRuntimeToolbar
                          actions={graphActions}
                          onCheck={() => setDialog('validation')}
                          onResult={notify}
                          onError={() => setRuntimeOpen(true)}
                        />
                        <div className="tool-group view-tools">
                          <button
                            className={`icon-button${inspectorVisible ? ' active-subtle' : ''}`}
                            onClick={() => setInspectorVisible((value) => !value)}
                            title="Toggle properties"
                            aria-label="Toggle properties"
                            aria-pressed={inspectorVisible}
                          >
                            <PanelRight size={17} />
                          </button>
                        </div>
                      </header>
                      <RuntimeProgressOverlay progress={progress}>
                        {libraryVisible && (
                          <NodePalette
                            items={paletteNodes}
                            onAdd={addNode}
                            onDrop={(kind, point) => {
                              const bounds = canvas.current?.getBoundingClientRect();
                              if (
                                !bounds ||
                                point.x < bounds.left ||
                                point.x > bounds.right ||
                                point.y < bounds.top ||
                                point.y > bounds.bottom
                              )
                                return;
                              addNode(kind, flow.screenToFlowPosition(point));
                            }}
                          />
                        )}
                        <main
                          className={`canvas-area${pan ? ' pan-mode' : ''}`}
                          aria-label="Routing graph canvas"
                          onContextMenu={(event) => event.preventDefault()}
                          onKeyDown={(event) => {
                            if (
                              event.key !== 'ContextMenu' &&
                              !(event.shiftKey && event.key === 'F10')
                            )
                              return;
                            const target = event.target as HTMLElement;
                            if (
                              target.closest(
                                'input,textarea,select,button,[contenteditable="true"]',
                              )
                            )
                              return;
                            const node = target.closest<HTMLElement>('.react-flow__node');
                            const id = node?.dataset.id;
                            if (!node || !id) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const bounds = node.getBoundingClientRect();
                            openNodeContext(id, node, bounds.left + 24, bounds.top + 32);
                          }}
                        >
                          {graphActions.setupOutbounds.length > 0 && (
                            <div className="example-setup" role="status">
                              <span>This example needs a working outbound.</span>
                              <button
                                className="primary-button"
                                onClick={() => openStash(graphActions.setupOutbounds[0].id)}
                              >
                                Import or replace outbound
                              </button>
                            </div>
                          )}
                          <EdgeRoutesContext.Provider value={edgeRoutes}>
                            {!hasIcsCapture(editor.graph) &&
                              sharingDismissed !== sharingKey &&
                              (sharing.value?.pair || sharing.value?.recoveryPending) && (
                                <div className="ics-notice" role="status">
                                  <span>
                                    {sharing.error
                                      ? `Windows sharing: ${sharing.error}`
                                      : sharing.value?.pair && !sharing.value.recoveryPending
                                        ? `Windows Internet sharing: ${sharing.value.pair.public.name} → ${sharing.value.pair.private.name}`
                                        : 'Windows sharing needs recovery'}
                                  </span>
                                  <button
                                    className="secondary-button"
                                    disabled={sharing.busy}
                                    onClick={() => {
                                      const existing = editor.graph.nodes.find(
                                        (n) => n.data.kind === 'ics-tun',
                                      );
                                      if (existing) openNodeEditor(existing.id);
                                      else setIcsSetupOpen(true);
                                    }}
                                  >
                                    {sharing.value?.recoveryPending
                                      ? 'Review sharing'
                                      : sharingAction(editor.graph)}
                                  </button>
                                  <button
                                    className="icon-button"
                                    aria-label="Dismiss sharing notice"
                                    onClick={() => setSharingDismissed(sharingKey)}
                                  >
                                    ×
                                  </button>
                                </div>
                              )}
                            <FakeDnsUsageContext.Provider
                              value={fakeDnsUsageSummary(
                                runtime.connected,
                                runtime.snapshot,
                                graphCompilation?.config,
                                runtime.savedConfig,
                                runtime.savedRevision,
                              )}
                            >
                              <div className="canvas-flow" ref={canvas}>
                                <ReactFlow<RuleNodeType, RuleEdge>
                                  nodes={editor.graph.nodes}
                                  edges={decoratedEdges}
                                  nodeTypes={nodeTypes}
                                  edgeTypes={edgeTypes}
                                  onNodesChange={editor.onNodesChange}
                                  onEdgesChange={editor.onEdgesChange}
                                  onConnect={onConnect}
                                  onReconnect={onReconnect}
                                  isValidConnection={isValidConnection}
                                  onReconnectStart={(_, edge) => {
                                    reconnectingEdge.current = edge.id;
                                  }}
                                  onReconnectEnd={() => {
                                    reconnectingEdge.current = null;
                                  }}
                                  onNodeDragStart={editor.beginDrag}
                                  onNodeDragStop={editor.endDrag}
                                  onSelectionDragStart={editor.beginDrag}
                                  onSelectionDragStop={editor.endDrag}
                                  onEdgeClick={() => setInspectorVisible(true)}
                                  onEdgeDoubleClick={(_, edge) => {
                                    editor.selectEdge(edge.id);
                                    openConnection({ edgeId: edge.id });
                                  }}
                                  onNodeContextMenu={(event, node) => {
                                    event.preventDefault();
                                    const opener = (
                                      event.target as HTMLElement
                                    ).closest<HTMLElement>('.react-flow__node');
                                    if (opener)
                                      openNodeContext(
                                        node.id,
                                        opener,
                                        event.clientX,
                                        event.clientY,
                                      );
                                  }}
                                  onMoveStart={() => closeNodeContext()}
                                  onNodeClick={() => setInspectorVisible(true)}
                                  onNodeDoubleClick={(_, node) => {
                                    if (hasNodeEditor(node.data)) openNodeEditor(node.id);
                                  }}
                                  onMoveEnd={(_, viewport) => {
                                    setView(viewport);
                                    editor.setViewport(viewport);
                                  }}
                                  minZoom={0.25}
                                  maxZoom={2}
                                  deleteKeyCode={null}
                                  nodesDraggable={!pan}
                                  panOnDrag={pan ? true : [1, 2]}
                                  selectionOnDrag={!pan}
                                  selectionMode={SelectionMode.Partial}
                                  snapToGrid
                                  snapGrid={[16, 16]}
                                  colorMode={theme.resolved}
                                  elevateEdgesOnSelect={false}
                                  connectionLineStyle={{
                                    stroke: 'var(--node-output)',
                                    strokeWidth: 2,
                                  }}
                                  proOptions={{ hideAttribution: true }}
                                  ariaLabelConfig={{
                                    'node.a11yDescription.default':
                                      'Press Enter to select a node. Use arrow keys to move it; Shift+F10 opens node actions; Delete removes the selection.',
                                  }}
                                >
                                  <Panel position="bottom-right" className="canvas-controls">
                                    <button
                                      className="icon-button"
                                      aria-label="Zoom out"
                                      onClick={() => void flow.zoomOut({ duration: 150 })}
                                    >
                                      <ZoomOut size={16} />
                                    </button>
                                    <span>{Math.round(view.zoom * 100)}%</span>
                                    <button
                                      className="icon-button"
                                      aria-label="Zoom in"
                                      onClick={() => void flow.zoomIn({ duration: 150 })}
                                    >
                                      <ZoomIn size={16} />
                                    </button>
                                    <button
                                      className="icon-button fit-button"
                                      onClick={fit}
                                      title="Fit graph (F)"
                                      aria-label="Fit graph"
                                    >
                                      <Expand size={16} />
                                    </button>
                                  </Panel>
                                </ReactFlow>
                                {!editor.graph.nodes.length && (
                                  <div className="empty-canvas">
                                    <div className="empty-canvas-symbol">
                                      <span className="brand-mark" aria-hidden="true" />
                                    </div>
                                    <h1>A route starts here.</h1>
                                    <p>
                                      Add an input, connect a condition,
                                      <br />
                                      and choose where the path leads.
                                    </p>
                                    <button className="primary-button" onClick={showNodeLibrary}>
                                      <Plus size={16} /> Add your first node
                                    </button>
                                  </div>
                                )}
                                {feedback && (
                                  <div
                                    className={`canvas-feedback${feedback.error ? ' is-error' : ''}`}
                                    role={feedback.error ? 'alert' : 'status'}
                                  >
                                    {feedback.error ? (
                                      <AlertCircle size={14} />
                                    ) : (
                                      <Check size={14} />
                                    )}
                                    {feedback.message}
                                  </div>
                                )}
                              </div>
                            </FakeDnsUsageContext.Provider>
                          </EdgeRoutesContext.Provider>
                        </main>
                        {inspectorVisible && (
                          <Inspector
                            graph={editor.graph}
                            diagnostics={issues}
                            node={editor.selectedNodes[0]}
                            edge={editor.selectedEdges[0]}
                            selectedCount={selectedCount}
                            onUpdate={(id, update) => {
                              try {
                                editor.updateNode(id, update);
                              } catch (e) {
                                notify(
                                  e instanceof Error
                                    ? e.message
                                    : 'Could not save the Stash entry.',
                                  true,
                                );
                              }
                            }}
                            onBeginFieldEdit={editor.beginFieldEdit}
                            onEndFieldEdit={editor.endFieldEdit}
                            onSelect={editor.selectNode}
                            onConnect={(sourceId, port) => openConnection({ sourceId, port })}
                            onSelectConnection={selectConnection}
                            onEditConnection={(edgeId) => openConnection({ edgeId })}
                            onShowConnection={showConnection}
                            onEdit={openNodeEditor}
                            onDelete={deleteSelection}
                            onClose={() => setInspectorVisible(false)}
                          />
                        )}
                      </RuntimeProgressOverlay>
                      <footer className="status-bar" aria-label="Status bar">
                        {resourceScheduleError && (
                          <span role="alert" className="field-message error">
                            {resourceScheduleError}
                          </span>
                        )}
                        <button
                          ref={runtimeTrigger}
                          className={`status-runtime${runtimeView.running ? ' online' : ''}`}
                          title={runtimeView.description}
                          aria-label={`Open Run graph. ${runtimeView.description}`}
                          onClick={() => setRuntimeOpen(true)}
                        >
                          {runtimeView.footer}
                        </button>
                        {runtime.connected &&
                          runtime.snapshot?.capture?.availability &&
                          runtime.snapshot.capture.availability.state !== 'available' && (
                            <button
                              className="graph-status has-errors"
                              onClick={() => setRuntimeOpen(true)}
                              title={
                                runtime.snapshot.capture.availability.message ??
                                'Capture remains off.'
                              }
                              aria-label={`Open capture warning. ${runtime.snapshot.capture.availability.message ?? 'Capture remains off.'}`}
                            >
                              {runtime.snapshot.capture.availability.state === 'blocked'
                                ? 'WinDivert in use'
                                : 'Capture check failed'}
                            </button>
                          )}
                        {edgeLayout.error && (
                          <button
                            className="graph-status has-errors"
                            onClick={edgeLayout.retry}
                            title={edgeLayout.error}
                          >
                            Retry connection layout
                          </button>
                        )}
                        {[...edgeRoutes.values()].some((route) => route.blocked) && (
                          <span
                            className="graph-status has-errors"
                            role="status"
                            title="A connection cannot be routed clearly in this layout. Move overlapping nodes or increase the space between them."
                          >
                            Connections need more space
                          </span>
                        )}
                        <span className="status-help">
                          {pan
                            ? 'Drag to pan the canvas'
                            : selectedCount
                              ? `${selectedCount} selected · Delete to remove`
                              : 'Space + drag to pan · Scroll to zoom'}
                        </span>

                        <button
                          ref={graphCheckTrigger}
                          aria-busy={analysis.pending}
                          className={`graph-status${errors ? ' has-errors' : issues.length ? ' has-warnings' : ''}`}
                          title="Check the graph, then validate it with Xray."
                          onClick={() => setDialog('validation')}
                        >
                          {issues.length ? <AlertCircle size={13} /> : <Check size={13} />}
                          {analysis.pending
                            ? 'Checking graph…'
                            : errors
                              ? `${errors} ${errors === 1 ? 'issue' : 'issues'}`
                              : issues.length
                                ? `${issues.length} ${issues.length === 1 ? 'hint' : 'hints'}`
                                : 'Graph checks passed'}
                        </button>
                        <span className="status-divider" />
                        <span
                          className="save-status"
                          title={
                            editor.storageError ||
                            (runtime.desktop
                              ? 'The graph draft is saved automatically in protected Windows storage. Saving does not apply it.'
                              : 'This draft exists in this browser tab only. Export graph to keep a file copy.')
                          }
                        >
                          {editor.saveStatus === 'saved' ? (
                            <Check size={12} />
                          ) : editor.saveStatus === 'saving' ? (
                            <span className="saving-dot" />
                          ) : (
                            <AlertCircle size={12} />
                          )}
                          {editor.saveStatus === 'saved'
                            ? 'Draft saved'
                            : editor.saveStatus === 'saving'
                              ? 'Saving…'
                              : editor.saveStatus === 'session'
                                ? 'Draft unsaved'
                                : 'Save failed'}
                        </span>
                      </footer>
                      <input
                        className="file-input"
                        ref={fileInput}
                        type="file"
                        accept=".json,.wayrill.json,application/json"
                        aria-label="Open graph file"
                        onChange={(event) => void openFile(event)}
                      />
                      {nodeContext && contextNode && (
                        <NodeContextMenu
                          x={nodeContext.x}
                          y={nodeContext.y}
                          label={contextNode.data.label}
                          onClose={closeNodeContext}
                          items={[
                            {
                              label: 'Edit…',
                              action: () =>
                                hasNodeEditor(contextNode.data)
                                  ? openNodeEditor(contextNode.id)
                                  : showNodeProperties(contextNode.id),
                            },
                            {
                              label: 'Rename…',
                              action: () => showNodeProperties(contextNode.id, true),
                            },
                            ...(contextNode.data.kind === 'routing-filter'
                              ? [
                                  {
                                    label: 'Export rules…',
                                    action: () => openNodeEditor(contextNode.id, 'export'),
                                  },
                                ]
                              : []),
                            ...(isBackupFilter(contextNode.data.kind)
                              ? [
                                  {
                                    label: 'Back up filter…',
                                    action: () =>
                                      setBackupOpen({ mode: 'create', targetId: contextNode.id }),
                                  },
                                  {
                                    label: 'Restore filter…',
                                    action: () =>
                                      setBackupOpen({ mode: 'restore', targetId: contextNode.id }),
                                  },
                                ]
                              : []),
                            ...(isGraphInbound(contextNode.data.kind)
                              ? [
                                  {
                                    label: isDisabledInbound(contextNode.data)
                                      ? 'Enable'
                                      : 'Disable',
                                    action: () =>
                                      editor.updateNode(contextNode.id, {
                                        enabled: isDisabledInbound(contextNode.data),
                                      }),
                                  },
                                ]
                              : []),
                            ...(isOutboundKind(contextNode.data.kind)
                              ? [
                                  {
                                    label:
                                      contextNode.id === editor.graph.mainOutboundId
                                        ? 'Remove Main designation'
                                        : 'Set as Main',
                                    action: () =>
                                      editor.change((graph) =>
                                        setMainOutbound(
                                          graph,
                                          graph.mainOutboundId === contextNode.id
                                            ? undefined
                                            : contextNode.id,
                                        ),
                                      ),
                                  },
                                  {
                                    label: 'Replace',
                                    disabled: graphBlocked || !stash.ready,
                                    items: [
                                      ...favorites.map((choice) => ({
                                        label: choice.label,
                                        disabled: !choice.available,
                                        action: () =>
                                          void replaceFavorite(contextNode.id, choice).catch(
                                            switchFailed,
                                          ),
                                      })),
                                      ...(favorites.length ? [{ label: '', separator: true }] : []),
                                      {
                                        label: 'Select from Stash…',
                                        action: () => openStash(contextNode.id),
                                      },
                                    ],
                                  },
                                ]
                              : []),
                            ...(isOutboundKind(contextNode.data.kind) &&
                            contextNode.data.kind !== 'block-outbound'
                              ? [
                                  {
                                    label: 'Test outbound',
                                    icon: <Timer size={15} />,
                                    disabled:
                                      !outboundTests.desktop ||
                                      outboundTests.busy ||
                                      !runtime.capabilities.includes('outbounds.testing'),
                                    action: () =>
                                      void outboundTests.start(undefined, [contextNode.id]),
                                  },
                                  {
                                    label: 'Speed test',
                                    icon: <Gauge size={15} />,
                                    disabled:
                                      !outboundTests.desktop ||
                                      outboundTests.busy ||
                                      !runtime.capabilities.includes('outbounds.testing'),
                                    action: () =>
                                      void outboundTests.start(
                                        undefined,
                                        [contextNode.id],
                                        'speed',
                                      ),
                                  },
                                ]
                              : []),
                            ...(connectionSources(editor.graph).some(
                              (node) => node.id === contextNode.id,
                            )
                              ? [
                                  {
                                    label: 'Add connection…',
                                    action: () =>
                                      openConnection({
                                        sourceId: contextNode.id,
                                      }),
                                  },
                                ]
                              : []),
                            { label: '', separator: true },
                            {
                              label: 'Duplicate',
                              shortcut: 'Ctrl+D',
                              disabled: !canDuplicateNode(contextNode, editor.graph),
                              action: duplicateSelected,
                            },
                            {
                              label: 'Delete',
                              shortcut: 'Del',
                              destructive: true,
                              action: deleteSelection,
                            },
                          ]}
                        />
                      )}
                      {connectionRequest && (
                        <ConnectionEditor
                          key={
                            connectionRequest.edgeId ??
                            `${connectionRequest.sourceId ?? ''}:${connectionRequest.port ?? ''}`
                          }
                          graph={editor.graph}
                          request={connectionRequest}
                          onApply={saveConnection}
                          onEditExisting={(edgeId) => openConnection({ edgeId })}
                          onClose={() => {
                            setConnectionRequest(null);
                            requestAnimationFrame(() => {
                              // An Inspector action can disappear after committing the new selection.
                              if (document.activeElement === document.body)
                                connectionTrigger.current?.focus({
                                  preventScroll: true,
                                });
                            });
                          }}
                        />
                      )}
                      {icsSetupOpen && (
                        <Dialog
                          title="Route Windows Internet sharing"
                          onClose={() => setIcsSetupOpen(false)}
                          footer={
                            <>
                              <button
                                className="primary-button"
                                disabled={!canUseSharing(sharing.value) || sharing.busy}
                                onClick={() => {
                                  configureSharing(icsFilter);
                                  setIcsSetupOpen(false);
                                }}
                              >
                                Add to graph
                              </button>
                              <button
                                className="secondary-button"
                                onClick={() => setIcsSetupOpen(false)}
                              >
                                Cancel
                              </button>
                            </>
                          }
                        >
                          <p>
                            {sharing.value?.pair?.public.name} → {sharing.value?.pair?.private.name}
                          </p>
                          {sharing.value?.problem && (
                            <p className="notice notice--error">{sharing.value.problem}</p>
                          )}
                          <label className="check-control">
                            <input
                              type="checkbox"
                              checked={icsFilter}
                              onChange={(e) => setIcsFilter(e.target.checked)}
                            />
                            Add traffic filter
                          </label>
                          <p>
                            Unmatched traffic uses the original upstream. Stop restores Windows
                            sharing.
                          </p>
                        </Dialog>
                      )}
                      {defaultsOpen && (
                        <GlobalDefaultsEditor
                          initialSection={defaultsSection}
                          graph={editor.graph}
                          onApply={(defaults) => {
                            requireGraphSave(editor.updateDefaults(defaults));
                          }}
                          onClose={() => {
                            setDefaultsOpen(false);
                            setDefaultsSection(undefined);
                            setDiagnosticFocus(null);
                          }}
                        />
                      )}
                      {logsOpen && (
                        <DiagnosticsDialog
                          onClose={() => setLogsOpen(false)}
                          maskAddress={String(
                            effectiveDefaults(editor.graph.defaults ?? factoryDefaults())
                              .maskAddress ?? '',
                          )}
                        />
                      )}
                      {runtimeOpen && (
                        <RuntimePanel
                          analysis={analysis}
                          actions={graphActions}
                          graph={editor.graph}
                          runtime={runtime}
                          onIssue={reviewIssue}
                          onClose={() => setRuntimeOpen(false)}
                          onResources={() => {
                            setRuntimeOpen(false);
                            setDefaultsSection('resources');
                            setDefaultsOpen(true);
                          }}
                          onSystemCapture={() => {
                            setRuntimeOpen(false);
                            setWindowsCaptureOpen(true);
                          }}
                        />
                      )}
                      {trafficOpen && (
                        <TrafficPanel
                          runtime={runtime}
                          history={trafficHistory}
                          onClose={() => setTrafficOpen(false)}
                        />
                      )}
                      {deletingSelection && (
                        <DeleteGraphSelection
                          count={editor.selectedNodes.length}
                          stashCount={
                            new Set(
                              editor.selectedNodes
                                .filter((n) => n.data.stashLink)
                                .map((n) => JSON.stringify(n.data.stashLink)),
                            ).size
                          }
                          onClose={() => setDeletingSelection(false)}
                          onDelete={(remove) => {
                            try {
                              editor.removeSelected(remove);
                              setDeletingSelection(false);
                              notify('Selection deleted. Undo restores it.');
                            } catch (e) {
                              notify(
                                e instanceof Error ? e.message : 'Could not delete selection.',
                                true,
                              );
                            }
                          }}
                        />
                      )}
                      {stashOpen && (
                        <ConfigurationStash
                          graph={editor.graph}
                          store={stash}
                          replaceLabel={
                            replaceNodeId ? replacementNode?.data.label || 'Outbound' : undefined
                          }
                          replacementConnections={
                            replaceNodeId
                              ? editor.graph.edges.filter((edge) => edge.source === replaceNodeId)
                                  .length
                              : 0
                          }
                          onUse={(entry, replace, link) => {
                            if (replace && (!replaceNodeId || !replacementNode))
                              throw new Error('The replacement target no longer exists.');
                            void assignStashedOutbound(
                              entry,
                              link,
                              replace ? replaceNodeId! : undefined,
                            ).catch(switchFailed);
                          }}
                          onClose={() => {
                            setStashOpen(false);
                            setReplaceNodeId(null);
                          }}
                        />
                      )}
                      {dialog === 'validation' && (
                        <GraphCheckDialog
                          actions={graphActions}
                          onClose={() => setDialog(null)}
                          onIssue={reviewIssue}
                        />
                      )}
                      {dialog && dialog !== 'validation' && (
                        <Dialog
                          title={dialog === 'help' ? 'Keyboard & canvas' : 'About Wayrill'}
                          onClose={() => setDialog(null)}
                        >
                          {dialog === 'help' ? (
                            <>
                              <p className="dialog-note">
                                Drag a node to move it. Drag between compatible ports, or use Add
                                connection in the toolbar to choose endpoints with clicks or the
                                keyboard. Select a connection to inspect its endpoints; use Edit
                                connection… or double-click the line to change it. Cancel discards
                                the edit; Undo restores previous endpoints.
                              </p>
                              <div className="shortcut-list">
                                {[
                                  ['Pan canvas', 'Space + drag / middle mouse'],
                                  ['Zoom', 'Mouse wheel'],
                                  ['Select / pan tool', 'V / H'],
                                  ['Add a node', 'N'],
                                  ['Fit the graph', 'F'],
                                  ['Undo / redo', 'Ctrl+Z / Ctrl+Shift+Z'],
                                  ['Duplicate selection', 'Ctrl+D'],
                                  ['Select all nodes', 'Ctrl+A'],
                                  ['Delete selection', 'Delete'],
                                  ['Export / open graph', 'Ctrl+S / Ctrl+O'],
                                ].map(([label, shortcut]) => (
                                  <div key={label}>
                                    <span>{label}</span>
                                    <kbd>{shortcut}</kbd>
                                  </div>
                                ))}
                              </div>
                              <p>
                                Menus: Enter, Space or Down opens the first command; Up opens the
                                last. Use Up/Down, Home/End or type a command name to move. Escape
                                returns to the menu button; Tab leaves the menu.
                              </p>
                              <p>
                                Editor tabs: Left/Right or Home/End moves focus; Enter or Space
                                opens the section. Tab moves into its contents. Switching sections
                                keeps unfinished fields. In node editors, Cancel or Escape discards
                                the edit; closing returns focus to its opener.
                              </p>
                            </>
                          ) : (
                            <div className="about-content">
                              <img src="/brand/wayrill-icon.png" alt="Wayrill app icon" />
                              <h3>Wayrill</h3>
                              <p>A visual workspace for finding a way through.</p>
                              <span>Wayrill · {appVersion}</span>
                              <p className="scope-note">
                                Schematic routing uses libavoid-js 0.4.5 / libavoid.{' '}
                                <a
                                  href="/licenses/libavoid-LGPL-2.1.txt"
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  LGPL 2.1 or later
                                </a>
                              </p>
                              <p className="scope-note">
                                Configure all protocol families registered by the pinned Xray core,
                                ordered traffic rules, DNS policies, policy groups and shared
                                observatories. Account, peer, transport and security editors
                                preserve native configurations. TUN capture is managed by the
                                Windows service. Compile supported graphs into a complete Xray
                                configuration and run them with the Windows service.
                              </p>
                              <div className="about-features">
                                <span>
                                  <Copy size={14} /> Local graph files
                                </span>
                                <span>
                                  <Download size={14} /> Xray service controls
                                </span>
                                <span>
                                  <CircleHelp size={14} /> Windows 10 / 11 target
                                </span>
                              </div>
                            </div>
                          )}
                        </Dialog>
                      )}
                      {windowsCaptureOpen && (
                        <SystemCaptureSettings
                          graph={editor.graph}
                          compiled={graphCompilation}
                          onRuntimeRefresh={runtime.refresh}
                          onApply={(next) =>
                            requireGraphSave(
                              editor.change((current) => ({
                                ...current,
                                captureOptions: next.captureOptions,
                              })),
                            )
                          }
                          onClose={() => setWindowsCaptureOpen(false)}
                        />
                      )}
                      {editingNode &&
                        (editingNode.data.kind === 'ics-tun' ? (
                          <IcsEditor
                            key={editingNode.id}
                            node={editingNode}
                            graph={editor.graph}
                            onApply={saveNodeGraph}
                            onClose={closeNodeEditor}
                          />
                        ) : editingNode.data.kind === 'windivert-inbound' ? (
                          <CaptureEditor
                            key={editingNode.id}
                            node={editingNode}
                            graph={editor.graph}
                            defaults={editor.graph.defaults}
                            onApply={saveNodeGraph}
                            onClose={closeNodeEditor}
                          />
                        ) : isProtocolKind(editingNode.data.kind) ||
                          ['xray-inbound', 'xray-outbound'].includes(editingNode.data.kind) ? (
                          <ProtocolEditor
                            key={editingNode.id}
                            node={editingNode}
                            automaticFakeDnsRecovery={automaticFakeDns(editor.graph)}
                            defaults={editor.graph.defaults}
                            onApply={saveNodeData}
                            onClose={closeNodeEditor}
                          />
                        ) : isNativeConfigEditor(editingNode.data.kind) ? (
                          editingNode.data.kind === 'xray-options' ? (
                            <CoreOptionsEditor
                              key={editingNode.id}
                              node={editingNode}
                              onApply={saveNodeData}
                              onClose={closeNodeEditor}
                            />
                          ) : (
                            <NativeDnsEditor
                              key={editingNode.id}
                              node={editingNode}
                              graph={editor.graph}
                              onApply={saveNodeData}
                              onClose={closeNodeEditor}
                            />
                          )
                        ) : editingNode.data.kind === 'proxy-chain' ? (
                          <ProxyChainEditor
                            key={editingNode.id}
                            node={editingNode}
                            graph={editor.graph}
                            stash={stash.stash}
                            onApply={saveNodeGraph}
                            onClose={closeNodeEditor}
                          />
                        ) : isPolicyKind(editingNode.data.kind) ? (
                          <PolicyEditor
                            stash={stash.stash}
                            key={editingNode.id}
                            node={editingNode}
                            graph={editor.graph}
                            onApply={saveNodeGraph}
                            onClose={closeNodeEditor}
                          />
                        ) : editingNode.data.kind === 'fakedns' ? (
                          <FakeDnsEditor
                            key={editingNode.id}
                            node={editingNode}
                            graph={editor.graph}
                            onApply={saveNodeData}
                            onClose={closeNodeEditor}
                          />
                        ) : isDnsEditor(editingNode.data) ? (
                          <DnsEditor
                            resourceWarnings={
                              runtime.connected ? runtime.snapshot?.resources : undefined
                            }
                            key={editingNode.id}
                            node={editingNode}
                            graph={editor.graph}
                            onApply={saveNodeData}
                            onClose={closeNodeEditor}
                          />
                        ) : (
                          <RuleTableEditor
                            resourceWarnings={
                              runtime.connected ? runtime.snapshot?.resources : undefined
                            }
                            initialTab={editorInitialTab}
                            key={editingNode.id}
                            node={editingNode}
                            graph={editor.graph}
                            onApply={(id, data, domainStrategy) => {
                              if (!editingGraph) return;
                              const next = updateGraphNode(editingGraph, id, data);
                              if (!domainStrategy) return saveNodeGraph(next);
                              const defaults = editingGraph.defaults ?? factoryDefaults();
                              saveNodeGraph({
                                ...next,
                                defaults: {
                                  ...defaults,
                                  settings: {
                                    ...defaults.settings,
                                    routingDomainStrategy: domainStrategy,
                                  },
                                },
                              });
                            }}
                            onClose={closeNodeEditor}
                          />
                        ))}
                    </div>
                  </DiagnosticFocusContext.Provider>
                </NodeEditorContext.Provider>
              </GraphDiagnosticsContext.Provider>
            </MainOutboundContext.Provider>
          </ObservatoryContext.Provider>
        </OutboundTestsContext.Provider>
      </SubscriptionMaintenanceContext.Provider>
    </OutboundInterfacesContext.Provider>
  );
}
