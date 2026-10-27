import { editFakeDnsGraph } from './fakeDns';
import { bindingFor, bindingsFor } from './defaults';
import { normalizeUserAgent } from './trafficTuning';
import { syncImportedCoreDefaults } from './nativeCore';
import { updateGraphNode } from './model';
import type { GraphState, RuleNodeData } from './types';

/** Shared editing semantics for graph and library editors. */
export function editGraphNode(
  graph: GraphState,
  id: string,
  update: Partial<RuleNodeData>,
): GraphState {
  const node = graph.nodes.find((n) => n.id === id);
  if (node?.data.kind === 'fakedns' && update.settings)
    return editFakeDnsGraph(graph, id, update.settings);
  if (node && update.settings && update.overrides === undefined) {
    const keys = bindingsFor(node.data.kind)
      .filter((b) => update.settings![b.nodeKey] !== node.data.settings[b.nodeKey])
      .map((b) => b.nodeKey);
    update = { ...update, overrides: [...new Set([...(node.data.overrides ?? []), ...keys])] };
  }
  if (node && ['vless-outbound', 'socks-outbound'].includes(node.data.kind) && update.settings) {
    const editedHeaders = ['headers', 'rawHeader', 'xhttpExtra'].find(
      (key) =>
        update.settings![key] !== node.data.settings[key] &&
        (!bindingFor(node.data.kind, key) || update.overrides?.includes(key)),
    );
    if (editedHeaders) {
      const migrated = normalizeUserAgent(update.settings, editedHeaders);
      update = {
        ...update,
        settings: migrated.settings,
        ...(migrated.found
          ? {
              overrides: [
                ...new Set([...(update.overrides ?? node.data.overrides ?? []), 'userAgent']),
              ],
            }
          : {}),
      };
    }
  }
  const next = updateGraphNode(graph, id, update);
  if (node?.data.kind === 'xray-options' && update.settings && graph.xray)
    try {
      return syncImportedCoreDefaults(next);
    } catch {
      /* Native diagnostics retain the invalid draft. */
    }
  return next;
}
