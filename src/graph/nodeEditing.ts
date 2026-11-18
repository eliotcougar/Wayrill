import { editFakeDnsGraph } from './fakeDns';
import { bindingFor, bindingsFor } from './defaults';
import { normalizeUserAgent } from './trafficTuning';
import { syncImportedCoreDefaults } from './nativeCore';
import { updateGraphNode } from './model';
import type { GraphState, RuleNodeData } from './types';
import { ensureNodeTags } from './tags';
import { editableTag, occupiedTags } from './nodeTags';
import { remapGraphTag } from './tagRemap';
import { forceProjectionFields } from './xrayProjection';

/** Shared editing semantics for graph and library editors. */
export function editGraphNode(
  graph: GraphState,
  id: string,
  update: Partial<RuleNodeData>,
): GraphState {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return graph;
  if (node?.data.kind === 'fakedns' && update.settings)
    return editFakeDnsGraph(graph, id, update.settings);
  if (node && update.settings && update.overrides === undefined) {
    const keys = bindingsFor(node.data.kind)
      .filter((b) => update.settings![b.nodeKey] !== node.data.settings[b.nodeKey])
      .map((b) => b.nodeKey);
    update = {
      ...update,
      overrides: [...new Set([...(node.data.overrides ?? []), ...keys])],
    };
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
  let next = ensureNodeTags(updateGraphNode(graph, id, update));
  if (update.settings) {
    const old = editableTag(node.data, id);
    const changed = next.nodes.find((item) => item.id === id)!;
    const tag = editableTag(changed.data, id);
    if (old && tag && old.namespace === tag.namespace && old.value !== tag.value && tag.value) {
      // An imported duplicate cannot identify which of its owners a reference meant.
      if (!occupiedTags(graph, old.namespace, id).has(old.value))
        next = remapGraphTag(next, tag.namespace, old.value, tag.value);
      next = {
        ...next,
        nodes: next.nodes.map((item) => {
          const native = item.data.native;
          if (item.id !== id || !native || typeof item.data.settings.tag !== 'string') return item;
          // The old tag is available for reuse after this edit.
          return {
            ...item,
            data: {
              ...item.data,
              native: {
                ...native,
                original: forceProjectionFields(native.original, { tag: tag.value }, ['/tag']),
                projection: forceProjectionFields(native.projection, { tag: tag.value }, ['/tag']),
              },
            },
          };
        }),
      };
    }
  }
  if (node?.data.kind === 'xray-options' && update.settings && graph.xray)
    try {
      return syncImportedCoreDefaults(next);
    } catch {
      /* Native diagnostics retain the invalid draft. */
    }
  return next;
}
