import { useMemo } from 'react';
import DnsEditor from '../components/DnsEditor';
import RuleTableEditor from '../components/RuleTableEditor';
import { makeNode } from '../graph/catalog';
import { dnsFilterSettings, readDnsFilter } from '../graph/dns';
import { parseGraph } from '../graph/model';
import { readRuleTable, tableSettings } from '../graph/rules';
import type { GraphState, RuleNodeData } from '../graph/types';
import { layerTargets, type PoolLayer } from './layers';
import type { Publisher } from './publisher';

export default function PoolFilterEditor({
  layer,
  pool,
  onClose,
  onSave,
}: {
  layer: PoolLayer;
  pool: Publisher;
  onClose: () => void;
  onSave: (layer: PoolLayer) => Promise<void>;
}) {
  const data = layer.data;
  const scope = useMemo(() => {
    if (data.kind === 'stash') return;
    const sourceId = data.kind === 'traffic' ? data.filter.nodeId : data.nodeId;
    const candidates = pool.configurations.flatMap(({ bundle }) =>
      layerTargets(bundle, data).map((node) => ({ bundle, node })),
    );
    const context = candidates.find(({ node }) => node.id === sourceId) ?? candidates[0];
    const base: GraphState = context
      ? parseGraph(context.bundle.graph)
      : { name: layer.name, nodes: [], edges: [] };
    const source =
      context?.node ??
      makeNode(
        data.kind === 'traffic' ? 'routing-filter' : 'dns-routing-filter',
        { x: 0, y: 0 },
        sourceId,
      );
    const settings =
      data.kind === 'traffic' ? tableSettings(data.filter.table) : dnsFilterSettings(data.filter);
    const node = { ...source, data: { ...source.data, label: layer.name, settings } };
    const graph = { ...base, nodes: [...base.nodes.filter((item) => item.id !== node.id), node] };
    return { node, graph };
  }, [data, layer.name, pool.configurations]);
  if (!scope || data.kind === 'stash') return null;
  const apply = async (_id: string, update: Partial<RuleNodeData>) => {
    const settings = update.settings ?? scope.node.data.settings;
    const filter = data.kind === 'traffic' ? readRuleTable(settings) : readDnsFilter(settings);
    const original = data.kind === 'traffic' ? data.filter.table : data.filter;
    const ids = new Set(original.outputs.map((item) => item.id));
    if (filter.outputs.length !== ids.size || filter.outputs.some((item) => !ids.has(item.id)))
      throw new Error(
        'This layer uses the base graph’s outputs. Edit the outputs on the base graph, then create a filter layer from that output layout.',
      );
    await onSave({
      ...layer,
      data:
        data.kind === 'traffic'
          ? { ...data, filter: { ...data.filter, table: readRuleTable(settings) } }
          : { ...data, filter: readDnsFilter(settings) },
    });
  };
  return data.kind === 'traffic' ? (
    <RuleTableEditor {...scope} layerMode fixedOutputs onApply={apply} onClose={onClose} />
  ) : (
    <DnsEditor {...scope} layerMode fixedOutputs onApply={apply} onClose={onClose} />
  );
}
