import { makeNode, makeProxyInbound } from './catalog';
import { enableDefaults } from './defaults';
import type { GraphState } from './types';

export function createPolicyExample(strategy = 'roundRobin', mode = 'standard'): GraphState {
  const input = makeProxyInbound('socks', { x: 48, y: 176 }, 'policy-input');
  input.data.label = 'Local test inbound';
  input.data.settings.port = 2080;
  const group = makeNode('policy-group', { x: 368, y: 160 }, 'test-group');
  group.data.label = 'Test policy group';
  Object.assign(group.data.settings, {
    strategy,
    observe: true,
    fallbackEnabled: true,
    sources: JSON.stringify({
      version: 1,
      manual: [
        { type: 'node', nodeId: 'test-first' },
        { type: 'node', nodeId: 'test-second' },
      ],
      subscriptions: [],
      fallback: { type: 'node', nodeId: 'test-block' },
    }),
  });
  const first = makeNode('direct-outbound', { x: 736, y: 48 }, 'test-first'),
    second = makeNode('direct-outbound', { x: 736, y: 224 }, 'test-second');
  Object.assign(first.data.settings, { tag: 'test-a', redirect: '127.0.0.1:18881' });
  first.data.label = 'Test destination A';
  Object.assign(second.data.settings, { tag: 'test-b', redirect: '127.0.0.1:18882' });
  second.data.label = 'Test destination B';
  const block = makeNode('block-outbound', { x: 736, y: 408 }, 'test-block');
  block.data.label = 'Fallback · Block';
  const observer = makeNode('observatory', { x: 368, y: 480 }, 'test-observatory');
  Object.assign(observer.data.settings, {
    mode,
    probeURL: 'http://127.0.0.1:18880/health',
    destination: 'http://127.0.0.1:18880/health',
    probeInterval: '2s',
    interval: '10s',
    timeout: '1s',
    sampling: 1,
  });
  const wire = (source: string, port: string, target: string) => ({
    id: `${source}-${port}`,
    source,
    sourceHandle: port,
    target,
    targetHandle: 'in',
  });
  return enableDefaults({
    name: 'Policy group · local test',
    nodes: [input, group, first, second, block, observer],
    edges: [
      wire(input.id, 'data', group.id),
      wire(input.id, 'dns', block.id),
      wire(group.id, 'observation', observer.id),
    ],
  });
}
