import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import type { Connection } from '@xyflow/react';
import { getOutputPorts, hasInputPort, portLabel } from '../graph/catalog';
import {
  connectionTypes,
  sourceConnectionKind,
  targetConnectionKinds,
} from '../graph/connectionTypes';
import {
  connectionDescription,
  connectionEditProblem,
  connectionIsEditable,
  connectionSources,
  endpointDetail,
  preferredConnectionOutput,
  sameConnection,
} from '../graph/connectionEditing';
import type { GraphState } from '../graph/types';
import useModalDialog from './useModalDialog';
import { searchText } from '../text';

export interface ConnectionRequest {
  edgeId?: string;
  sourceId?: string;
  port?: string;
}

export default function ConnectionEditor({
  graph,
  request,
  onApply,
  onEditExisting,
  onClose,
}: {
  graph: GraphState;
  request: ConnectionRequest;
  onApply: (connection: Connection, edgeId?: string) => string | null;
  onEditExisting: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const old = graph.edges.find((edge) => edge.id === request.edgeId);
  const initialSource = old?.source ?? request.sourceId ?? '';
  const [sourceId, setSource] = useState(initialSource);
  const initialNode = graph.nodes.find((node) => node.id === initialSource);
  const [port, setPort] = useState(
    old?.sourceHandle ??
      request.port ??
      (initialNode ? preferredConnectionOutput(graph, initialNode) : '') ??
      '',
  );
  const [targetId, setTarget] = useState(old?.target ?? '');
  const [search, setSearch] = useState('');
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [submitProblem, setSubmitProblem] = useState<string | null>(null);
  useModalDialog(dialog);
  useEffect(() => {
    dialog.current?.querySelector<HTMLSelectElement>('#connection-source')?.focus();
  }, []);
  const source = graph.nodes.find((node) => node.id === sourceId);
  const target = graph.nodes.find((node) => node.id === targetId);
  const ports = source ? getOutputPorts(source.data.kind, source.data) : [];
  const sources = connectionSources(graph);
  const role = source && ports.includes(port) ? sourceConnectionKind(source.data, port) : undefined;
  const connection: Connection = {
    source: sourceId,
    sourceHandle: port,
    target: targetId,
    targetHandle: 'in',
  };
  const problem =
    request.edgeId && !old
      ? connectionEditProblem(graph, connection, request.edgeId)
      : !sourceId
        ? 'Choose a source node.'
        : !ports.includes(port)
          ? 'Choose an output port.'
          : !targetId
            ? 'Choose a destination.'
            : connectionEditProblem(graph, connection, request.edgeId);
  const occupied = graph.edges.find(
    (edge) => edge.id !== request.edgeId && edge.source === sourceId && edge.sourceHandle === port,
  );
  const unchanged = !!old && sameConnection(old, connection);
  const candidates = useMemo(
    () =>
      graph.nodes
        .filter((node) => hasInputPort(node.data.kind))
        .map((node) => ({
          node,
          problem:
            sourceId && port
              ? connectionEditProblem(
                  graph,
                  {
                    source: sourceId,
                    sourceHandle: port,
                    target: node.id,
                    targetHandle: 'in',
                  },
                  request.edgeId,
                )
              : 'Choose a source and output first.',
        }))
        .sort((a, b) => a.node.data.label.localeCompare(b.node.data.label)),
    [graph, sourceId, port, request.edgeId],
  );
  const compatible = candidates.filter((candidate) => !candidate.problem);
  const filtered = candidates.filter(
    ({ node, problem: reason }) =>
      (showUnavailable || !reason) &&
      searchText(`${node.data.label} ${endpointDetail(node, graph)}`).includes(searchText(search)),
  );
  const draftChanged = () => setSubmitProblem(null);
  return (
    <dialog
      ref={dialog}
      className="app-dialog connection-editor"
      aria-labelledby="connection-title"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const first = closeButton.current;
        const last = applyButton.current?.disabled ? cancelButton.current : applyButton.current;
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (problem || unchanged) return;
          const error = onApply(connection, request.edgeId);
          if (error) setSubmitProblem(error);
          else onClose();
        }}
      >
        <div className="dialog-header">
          <h2 id="connection-title">{request.edgeId ? 'Edit connection' : 'Add connection'}</h2>
          <button
            ref={closeButton}
            type="button"
            className="icon-button"
            aria-label="Cancel connection editing"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="connection-editor-body">
          <div className="connection-source-fields">
            <div>
              <label htmlFor="connection-source">Source node</label>
              <select
                className="text-control"
                id="connection-source"
                autoFocus
                value={sourceId}
                onChange={(event) => {
                  const id = event.target.value,
                    node = graph.nodes.find((n) => n.id === id);
                  setSource(id);
                  setPort(node ? preferredConnectionOutput(graph, node, request.edgeId) : '');
                  draftChanged();
                }}
              >
                <option value="">Choose a source…</option>
                {sourceId && !sources.some((node) => node.id === sourceId) && (
                  <option value={sourceId}>
                    {source?.data.label ?? 'Missing source'} (unavailable)
                  </option>
                )}
                {sources.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.data.label} · {endpointDetail(node, graph)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="connection-output">Output port</label>
              <select
                className="text-control"
                id="connection-output"
                value={port}
                disabled={!source}
                onChange={(event) => {
                  setPort(event.target.value);
                  draftChanged();
                }}
              >
                {!ports.includes(port) && (
                  <option value={port}>{port ? 'Missing output' : 'Choose an output…'}</option>
                )}
                {ports.map((id) => (
                  <option key={id} value={id}>
                    {portLabel(id, source?.data)} ·{' '}
                    {connectionTypes[sourceConnectionKind(source!.data, id)].label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {role && (
            <p className="connection-role-note">
              <span
                className="connection-role"
                style={{ color: connectionTypes[role].color }}
                title={connectionTypes[role].description}
              >
                {connectionTypes[role].label}
              </span>
              {role !== 'traffic' && ` ${connectionTypes[role].description}`}
            </p>
          )}
          {occupied && (
            <div className="connection-occupied">
              <p>
                This output is already connected to{' '}
                {graph.nodes.find((node) => node.id === occupied.target)?.data.label ??
                  'a missing node'}
                .
              </p>
              {connectionIsEditable(graph, occupied) && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onEditExisting(occupied.id)}
                >
                  Edit existing connection…
                </button>
              )}
            </div>
          )}
          <fieldset className="connection-destinations">
            <legend>Destination input</legend>
            <label htmlFor="connection-search">Find a destination</label>
            <input
              className="text-control"
              autoComplete="off"
              id="connection-search"
              type="search"
              value={search}
              placeholder="Name, node type or tag"
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="action-row action-row--spread connection-list-tools">
              <label className="connection-unavailable">
                <input
                  autoComplete="off"
                  type="checkbox"
                  checked={showUnavailable}
                  onChange={(event) => setShowUnavailable(event.target.checked)}
                />{' '}
                Show unavailable destinations and reasons
              </label>
              <p className="muted-note" role="status">
                {compatible.length} compatible · {filtered.length} shown
              </p>
            </div>
            <div className="connection-candidates">
              {filtered.map(({ node, problem: reason }) => (
                <label
                  className={`connection-candidate${targetId === node.id ? ' is-chosen' : ''}${reason ? ' is-unavailable' : ''}`}
                  key={node.id}
                >
                  <input
                    autoComplete="off"
                    type="radio"
                    name="connection-destination"
                    value={node.id}
                    checked={targetId === node.id}
                    disabled={!!reason}
                    onChange={() => {
                      setTarget(node.id);
                      draftChanged();
                    }}
                  />
                  <span>
                    <strong dir="auto" title={node.data.label}>
                      {node.data.label}
                    </strong>
                    <small>
                      {[
                        endpointDetail(node, graph),
                        `Input · ${targetConnectionKinds(node.data)
                          .map((kind) => connectionTypes[kind].label)
                          .join(', ')}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                    {reason && <small className="connection-reason">{reason}</small>}
                  </span>
                </label>
              ))}
              {!filtered.length && (
                <p className="muted-note">
                  {sourceId && port
                    ? search.trim()
                      ? 'No destinations match your search.'
                      : 'No compatible destinations. Show unavailable destinations to see why.'
                    : 'Choose a source node and output port first.'}
                </p>
              )}
            </div>
          </fieldset>
        </div>
        <div className="connection-editor-summary">
          {old && (
            <p className="connection-before">
              <strong>Current</strong> {connectionDescription(graph, old)}
            </p>
          )}
          <div className="connection-preview-caption">Proposed connection</div>
          <div className="connection-preview" aria-label="Proposed connection">
            <strong>
              {source?.data.label ?? 'Choose source'} /{' '}
              {source ? portLabel(port, source.data) : 'Output'}
            </strong>
            <ArrowRight size={16} aria-hidden="true" />
            <strong>{target?.data.label ?? 'Choose destination'} / Input</strong>
          </div>
          {(submitProblem || problem) && (
            <p className="field-message" role={submitProblem ? 'alert' : 'status'}>
              {submitProblem ?? problem}
            </p>
          )}
          {unchanged && !problem && <p className="muted-note">Endpoints unchanged.</p>}
        </div>
        <div className="dialog-footer">
          <button ref={cancelButton} type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            ref={applyButton}
            className="primary-button"
            type="submit"
            disabled={!!problem || unchanged}
          >
            {request.edgeId ? 'Apply connection' : 'Add connection'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
