import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import {
  ReactFlow,
  applyNodeChanges,
  useInternalNode,
  useNodesInitialized,
  useReactFlow,
  type OnNodesChange,
  type Connection,
  type IsValidConnection,
} from '@xyflow/react';
import { Maximize, Minus, Plus } from 'lucide-react';
import RemoteNode from './RemoteNode';
import SchematicEdge, { EdgeRoutesContext } from './components/SchematicEdge';
import useEdgeRouting from './useEdgeRouting';
import type { RemoteView, ViewNode } from './remoteModel';
import type { RemoteLayout } from './remoteDocument';

const nodeTypes = { remote: RemoteNode };
const edgeTypes = { schematic: SchematicEdge };
export interface CanvasActions {
  focus: (id: string) => void;
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  placement: () => { x: number; y: number };
}
interface CanvasProps {
  view: RemoteView;
  layout: RemoteLayout;
  onLayout: (layout: Partial<RemoteLayout>) => void;
  selected: string;
  mode: 'select' | 'pan';
  ref?: Ref<CanvasActions>;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onContext: (id: string, opener: HTMLElement, x: number, y: number) => void;
  onConnect: (connection: Connection) => void;
  isValidConnection: IsValidConnection;
  onAdd: (id: string, position: { x: number; y: number }) => void;
}
function RoutedCanvas({
  view,
  layout,
  onLayout,
  selected,
  onSelect,
  onConnect,
  isValidConnection,
  mode,
  onEdit,
  onContext,
  onAdd,
  ref,
}: CanvasProps) {
  const [nodes, setNodes] = useState(() =>
    view.nodes.map((node) => ({ ...node, position: layout.positions[node.id] ?? node.position })),
  );
  const [focusId, setFocusId] = useState('');
  const wrapper = useRef<HTMLDivElement>(null);
  const flow = useReactFlow<ViewNode>();
  const focusNode = useInternalNode<ViewNode>(focusId);
  const { paths, error, retry } = useEdgeRouting();
  const viewReady = useRef(!!layout.viewport);
  const nodesInitialized = useNodesInitialized();
  useImperativeHandle(
    ref,
    () => ({
      focus: setFocusId,
      fit: () => void flow.fitView({ padding: 0.15, maxZoom: 1, duration: 200 }),
      zoomIn: () => void flow.zoomIn({ duration: 150 }),
      zoomOut: () => void flow.zoomOut({ duration: 150 }),
      placement: () => {
        const bounds = wrapper.current?.getBoundingClientRect();
        const point = flow.screenToFlowPosition({
          x: (bounds?.left ?? 0) + (bounds?.width ?? 700) / 2,
          y: (bounds?.top ?? 0) + (bounds?.height ?? 500) / 2,
        });
        const position = { x: point.x - 160, y: point.y - 80 };
        const existing = flow.getNodes();
        // Search a simple column, keeping a gap around existing cards.
        while (
          existing.some(
            (node) =>
              position.x < node.position.x + (node.measured?.width ?? 340) + 32 &&
              position.x + 372 > node.position.x &&
              position.y < node.position.y + (node.measured?.height ?? 220) + 32 &&
              position.y + 252 > node.position.y,
          )
        )
          position.y += 280;
        return position;
      },
    }),
    [flow],
  );
  useEffect(() => {
    if (!focusId || !focusNode?.measured?.width || !focusNode.measured.height) return;
    const { x, y } = focusNode.internals.positionAbsolute;
    void flow.setCenter(x + focusNode.measured.width / 2, y + focusNode.measured.height / 2, {
      zoom: 1,
      duration: 200,
    });
    setFocusId('');
  }, [focusId, focusNode, flow]);
  useEffect(() => {
    setNodes((current) =>
      view.nodes.map((node) => {
        const previous = current.find((n) => n.id === node.id);
        return previous
          ? { ...previous, data: node.data }
          : { ...node, position: layout.positions[node.id] ?? node.position };
      }),
    );
  }, [view.nodes, layout.positions]);
  const displayed = useMemo(
    () => nodes.map((node) => ({ ...node, selected: node.id === selected })),
    [nodes, selected],
  );
  const onNodesChange: OnNodesChange<ViewNode> = useCallback(
    (changes) => {
      setNodes((current) => applyNodeChanges(changes, current));
      const positions = Object.fromEntries(
        changes.flatMap((change) =>
          change.type === 'position' && change.position && change.dragging !== true
            ? [[change.id, change.position]]
            : [],
        ),
      );
      if (Object.keys(positions).length)
        onLayout({ positions: { ...layout.positions, ...positions } });
    },
    [layout.positions, onLayout],
  );
  useEffect(() => {
    if (viewReady.current || !nodesInitialized) return;
    viewReady.current = true;
    void flow.fitView({ padding: 0.15, maxZoom: 1 });
  }, [flow, nodesInitialized]);
  return (
    <div
      className="graph-canvas"
      data-mode={mode}
      ref={wrapper}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('application/x-wayrill-node')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(event) => {
        const id = event.dataTransfer.getData('application/x-wayrill-node');
        if (!id) return;
        event.preventDefault();
        onAdd(id, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }}
    >
      <EdgeRoutesContext value={paths}>
        <ReactFlow<ViewNode>
          nodes={displayed}
          edges={view.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onMoveEnd={(_, viewport) => {
            if (viewReady.current) onLayout({ viewport });
          }}
          defaultViewport={layout.viewport}
          onNodeClick={(_, n) => onSelect(n.id)}
          onNodeDoubleClick={(_, n) => onEdit(n.id)}
          onNodeContextMenu={(event, n) => {
            event.preventDefault();
            onContext(n.id, event.currentTarget as HTMLElement, event.clientX, event.clientY);
          }}
          onPaneClick={() => onSelect('')}
          panOnDrag={mode === 'pan' ? true : [1]}
          selectionOnDrag={mode === 'select'}
          nodesDraggable={mode === 'select'}
          zoomOnDoubleClick={false}
          nodesConnectable={mode === 'select'}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          edgesReconnectable={false}
          deleteKeyCode={null}
          minZoom={0.12}
          maxZoom={1.6}
          fitView={false}
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        />
      </EdgeRoutesContext>
      <div className="canvas-zoom">
        <button
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => {
            void flow.zoomOut();
          }}
        >
          <Minus size={17} />
        </button>
        <button
          title="Fit graph"
          aria-label="Fit graph"
          onClick={() => {
            void flow.fitView({ padding: 0.15, maxZoom: 1, duration: 200 });
          }}
        >
          <Maximize size={17} />
        </button>
        <button
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => {
            void flow.zoomIn();
          }}
        >
          <Plus size={17} />
        </button>
      </div>
      {error && (
        <div className="canvas-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={retry}>
            Retry layout
          </button>
        </div>
      )}
    </div>
  );
}
export default function RemoteCanvas(props: CanvasProps) {
  return <RoutedCanvas {...props} />;
}
