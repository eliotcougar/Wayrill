import { diagnoseRuntimeGraph } from '../graph/diagnostics';
import { makeNode, makeProxyInbound } from '../graph/catalog';
import { capturePlaceholder } from '../graph/inboundPlaceholder';
import { editablePoolGraph, preparePoolWorkspace, type PoolBundle } from './model';

export function validatePublishedGraph(bundle: PoolBundle) {
  const { graph } = editablePoolGraph(bundle);
  for (const node of graph.nodes) {
    if (node.data.kind !== 'inbound-placeholder') continue;
    // Validate the published paths without borrowing any subscriber's device settings.
    const typed = capturePlaceholder(node.data);
    const input =
      typed === 'tun' || (!typed && node.data.settings.nat)
        ? makeNode('tun-inbound', node.position, node.id)
        : makeProxyInbound('mixed', node.position, node.id);
    if (input.data.kind === 'tun-inbound') {
      if (node.data.settings.nat) input.data.settings.separateNatTraffic = true;
      if (node.data.settings.encryptedDns) input.data.settings.encryptedDnsPorts = '853';
    }
    const candidate = preparePoolWorkspace(
      bundle,
      { name: bundle.name, nodes: [input], edges: [] },
      { format: 'wayrill.stash', version: 3, groups: [] },
      '00000000000000000000000000000000',
      'current',
      { [input.id]: node.id },
    );
    const issue = diagnoseRuntimeGraph(candidate.graph).find(
      ({ severity }) => severity === 'error',
    );
    if (issue) throw new Error(`“${bundle.name}” · ${issue.message}`);
  }
}
