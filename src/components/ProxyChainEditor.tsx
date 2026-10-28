import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import useModalDialog from './useModalDialog';
import { EditorTabs, EditorTabPanels, useEditorTabs } from './EditorTabs';
import { OrderedEntries, moveEntry } from './OrderedEntries';
import PolicyOutboundPicker from './PolicyOutboundPicker';
import { referenceSummary } from './editorSummaries';
import {
  readProxyChain,
  emptyProxyChain,
  observationSnapshot,
  outboundNeedsObservation,
} from '../graph/composites';
import { makeNode } from '../graph/catalog';
import { clearNodePosition } from '../graph/placement';
import { editPolicyGraph } from '../graph/policies';
import type { GraphState, RuleNode } from '../graph/types';
import type { Stash } from '../profiles/import';

export default function ProxyChainEditor({
  node,
  graph,
  stash,
  onApply,
  onClose,
  applyLabel = 'Apply changes',
}: {
  node: RuleNode;
  graph: GraphState;
  stash: Stash;
  onApply: (graph: GraphState) => void | Promise<void>;
  onClose: () => void;
  applyLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(dialog);
  const [name, setName] = useState(node.data.label),
    [tag, setTag] = useState(String(node.data.settings.tag));
  const [chain, setChain] = useState(() => {
    try {
      return readProxyChain(node.data);
    } catch {
      return emptyProxyChain();
    }
  });
  const [selected, setSelected] = useState<string | null>(chain.steps[0]?.id ?? null);
  const [tab, setTab] = useState<'hops' | 'observation' | 'preview'>('hops');
  const [saveError, setSaveError] = useState(''),
    [saving, setSaving] = useState(false);
  const connected = graph.edges.find(
    (e) => e.source === node.id && e.sourceHandle === 'observation',
  );
  const existing =
    graph.nodes.find((n) => n.id === connected?.target && n.data.kind === 'observatory') ??
    graph.nodes.find((n) => n.data.kind === 'observatory');
  const observer = useMemo(() => {
    const o =
      existing ??
      makeNode(
        'observatory',
        clearNodePosition(graph.nodes, { x: node.position.x + 360, y: node.position.y + 240 }),
      );
    if (!existing) {
      const s = observationSnapshot(node.data);
      if (s) o.data.settings = s;
    }
    return o;
  }, [existing, graph.nodes, node]);
  const observed = useMemo(() => {
    try {
      return outboundNeedsObservation(graph, {
        ...node,
        data: {
          ...node.data,
          settings: { ...node.data.settings, observe: false, steps: JSON.stringify(chain) },
        },
      });
    } catch {
      return false;
    }
  }, [graph, chain, node]);
  const monitored = observed || !!connected;
  const draft = useMemo(
    () => ({
      ...node,
      data: {
        ...node.data,
        settings: {
          ...node.data.settings,
          steps: JSON.stringify(chain),
          tag: tag.trim(),
          observe: observed,
          observationSettings: monitored ? JSON.stringify(observer.data.settings) : '',
        },
      },
    }),
    [node, chain, tag, observed, monitored, observer],
  );
  const draftGraph = useMemo(
    () =>
      editPolicyGraph(
        { ...graph, nodes: graph.nodes.map((n) => (n.id === node.id ? draft : n)) },
        node.id,
        draft.data.settings,
        monitored ? observer.id : undefined,
        monitored ? observer : undefined,
      ),
    [graph, node.id, draft, monitored, observer],
  );
  const [checked, setChecked] = useState<{
    draft: RuleNode;
    graph: GraphState;
    result?: { config: Record<string, unknown>; warnings: string[] };
    error?: string;
  }>();
  useEffect(() => {
    let active = true;
    let worker: Worker | undefined;
    const finish = (reply: {
      result?: { config: Record<string, unknown>; warnings: string[] };
      error?: string;
    }) => {
      if (!active) return;
      active = false;
      clearTimeout(deadline);
      worker?.terminate();
      setChecked({ draft, graph: draftGraph, ...reply });
    };
    const deadline = setTimeout(
      () => finish({ error: 'Chain validation timed out. Reopen the editor to retry.' }),
      60000,
    );
    // Collapse typing/reordering before creating a worker and copying the graph.
    const timer = setTimeout(() => {
      try {
        worker = new Worker(new URL('../profiles/preparedPreview.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (
          e: MessageEvent<{
            result?: { config: Record<string, unknown>; warnings: string[] };
            error?: string;
          }>,
        ) => finish(e.data);
        worker.onerror = () =>
          finish({ error: 'Unable to validate this chain. Reopen the editor to retry.' });
        worker.postMessage({ graph: draftGraph, node: draft });
      } catch {
        finish({ error: 'Unable to start chain validation.' });
      }
    }, 100);
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(deadline);
      worker?.terminate();
    };
  }, [draftGraph, draft]);
  const pending = checked?.draft !== draft || checked.graph !== draftGraph;
  const problem = pending ? '' : (checked?.error ?? '');
  const initialChain = useRef(chain);
  const untouchedEmpty = chain === initialChain.current && chain.steps.length < 2;
  const tabs = useEditorTabs(
    [
      { key: 'hops', label: 'Hops' },
      { key: 'observation', label: 'Observation' },
      { key: 'preview', label: 'Core preview' },
    ] as const,
    tab,
    setTab,
  );
  const editGraph = () => ({
    ...draftGraph,
    nodes: draftGraph.nodes.map((n) =>
      n.id === node.id
        ? {
            ...n,
            data: {
              ...n.data,
              label: name.trim(),
              settings: { ...n.data.settings, tag: tag.trim() },
            },
          }
        : n,
    ),
  });
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window policy-editor dialog--compact"
      aria-labelledby="chain-editor-title"
      onCancel={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onClose={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="rule-editor-titlebar">
        <h2 id="chain-editor-title">Edit proxy chain</h2>
        <button className="icon-button" aria-label="Close proxy chain editor" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <label className="editor-field policy-name-field">
        <span>Name</span>
        <input
          autoComplete="off"
          value={name}
          disabled={saving}
          maxLength={128}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <EditorTabs tabs={tabs} label="Proxy chain sections" disabled={saving} />
      <EditorTabPanels tabs={tabs} className="rule-editor-body policy-editor-body" inert={saving}>
        {tab === 'hops' && (
          <section className="policy-section">
            <label className="editor-field">
              <span>Outbound tag</span>
              <input
                autoComplete="off"
                value={tag}
                maxLength={128}
                onChange={(e) => setTag(e.target.value)}
              />
            </label>
            <p className="field-help">
              This PC → first hop → last hop → destination. Drag to reorder, or use Alt + ↑ / ↓.
            </p>
            <OrderedEntries
              label="Chain hops"
              entries={chain.steps.map((s) => {
                const r = referenceSummary(graph, s.outbound);
                return {
                  id: s.id,
                  name: r.name,
                  enabled: true,
                  summary: r.protocol,
                  destination: r.address,
                };
              })}
              selected={selected}
              onSelect={setSelected}
              onMove={(id, to) =>
                setChain({
                  ...chain,
                  steps: moveEntry(
                    chain.steps,
                    chain.steps.findIndex((s) => s.id === id),
                    to,
                  ),
                })
              }
              empty="Add at least two outbound hops."
            />
            <PolicyOutboundPicker
              graph={{ ...graph, nodes: graph.nodes.filter((n) => n.id !== node.id) }}
              stash={stash}
              label="Hop"
              onSelect={(outbound) => {
                const id = crypto.randomUUID();
                setChain({ ...chain, steps: [...chain.steps, { id, outbound }] });
                setSelected(id);
              }}
              single
              actions={
                <button
                  className="secondary-button"
                  disabled={!selected}
                  onClick={() => {
                    setChain({ ...chain, steps: chain.steps.filter((s) => s.id !== selected) });
                    setSelected(null);
                  }}
                >
                  <Trash2 size={14} />
                  Remove hop
                </button>
              }
            />
          </section>
        )}
        {tab === 'observation' && (
          <section className="policy-section">
            <h3>Observation</h3>
            <p>
              {observed
                ? 'Nested policy groups use the shared observatory.'
                : monitored
                  ? 'The connected Observatory monitors this chain.'
                  : 'Connect Observation on the canvas to monitor this chain.'}
            </p>
            {monitored && (
              <dl>
                <dt>Mode</dt>
                <dd>{String(observer.data.settings.mode)}</dd>
                <dt>Probe URL</dt>
                <dd>
                  {String(observer.data.settings.probeURL || observer.data.settings.destination)}
                </dd>
              </dl>
            )}
          </section>
        )}
        {tab === 'preview' && (
          <section className="policy-section">
            <pre className="code-block" tabIndex={0}>
              {pending
                ? 'Checking chain…'
                : problem || JSON.stringify(checked?.result?.config, null, 2)}
            </pre>
          </section>
        )}
      </EditorTabPanels>
      <div className="rule-editor-diagnostics" aria-live="polite">
        {((problem && !untouchedEmpty) || saveError) && (
          <div className="notice notice--error" role="alert">
            {problem || saveError}
          </div>
        )}
        {pending && <span role="status">Checking chain…</span>}
      </div>
      <div className="rule-editor-footer">
        {untouchedEmpty && <span>Choose at least two hops to continue</span>}
        <button className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary-button"
          disabled={
            saving || pending || !!problem || !name.trim() || !tag.trim() || chain.steps.length > 32
          }
          onClick={() =>
            void (async () => {
              setSaveError('');
              setSaving(true);
              try {
                const result = onApply(editGraph());
                if (result) await result;
                onClose();
              } catch (e) {
                setSaveError(e instanceof Error ? e.message : String(e));
              } finally {
                setSaving(false);
              }
            })()
          }
        >
          {saving ? 'Saving…' : applyLabel}
        </button>
      </div>
    </dialog>
  );
}
