import { createProxyStarter } from '../graph/examples';
import { makeNode } from '../graph/catalog';
import { tableSettings } from '../graph/rules';
import { factoryDefaults } from '../graph/defaults';
import { readGraphResources } from '../graph/resources';
import type { GraphState } from '../graph/types';
import { parseStash, type Stash } from '../profiles/import';
import { defaultGroup } from '../profiles/stashModel';
import {
  capturePoolGraph,
  editablePoolGraph,
  ensurePoolCapture,
  poolInputs,
  type PoolBundle,
} from './model';

export type GraphLayer = { graph: GraphState; stash: Stash };
export type PoolGraphStarter = 'direct' | 'traffic';

export const newPoolStash = (): Stash => ({
  format: 'wayrill.stash',
  version: 3,
  groups: [defaultGroup()],
});

export function openGraphLayer(
  bundle?: PoolBundle,
  starter: PoolGraphStarter = 'direct',
): GraphLayer {
  if (!bundle) {
    const graph = createProxyStarter();
    if (starter === 'traffic') {
      const [inbound, direct] = graph.nodes;
      const filter = makeNode('routing-filter', { x: 320, y: 64 }, 'traffic-rules');
      const block = makeNode('block-outbound', { x: 650, y: 322 }, 'block');
      inbound.data.label = 'Subscriber traffic';
      direct.position = { x: 650, y: 64 };
      direct.data.poolOutbound = true;
      graph.nodes.push(filter, block);
      graph.edges[0].target = filter.id;
      graph.edges.push(
        {
          id: 'traffic-default',
          source: filter.id,
          sourceHandle: 'default',
          target: direct.id,
          targetHandle: 'in',
        },
        {
          id: 'traffic-block',
          source: filter.id,
          sourceHandle: 'preferred',
          target: block.id,
          targetHandle: 'in',
        },
      );
      Object.assign(
        filter.data.settings,
        tableSettings({
          outputs: [
            { id: 'preferred', name: 'Block' },
            { id: 'default', name: 'Default' },
          ],
          rules: [],
          defaultOutput: 'default',
        }),
      );
    }
    return openGraphLayer(
      capturePoolGraph(
        'New graph layer',
        graph,
        newPoolStash(),
        [],
        poolInputs(graph).map((node) => node.id),
      ),
    );
  }
  const { graph } = editablePoolGraph(bundle);
  return {
    graph: {
      ...(bundle.version === 3 ? graph : ensurePoolCapture(graph)),
      name: bundle.name,
      defaults: {
        ...(graph.defaults ?? factoryDefaults()),
        resources: readGraphResources({ defaults: graph.defaults, poolSettings: bundle.settings }),
      },
    },
    stash: parseStash(bundle.stash),
  };
}
