// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import ProxyChainEditor from './ProxyChainEditor';
import { createPolicyExample } from '../graph/policyExample';
import { makeNode } from '../graph/catalog';
import { compileRuntimeGraph } from '../graph/runtime';
import type { GraphState } from '../graph/types';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('saving a chain retains its optional connection to a separate Observatory', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  class WorkerStub {
    onmessage: ((event: MessageEvent) => void) | null = null;
    postMessage({ graph }: { graph: GraphState }) {
      this.onmessage?.(
        new MessageEvent('message', {
          data: { result: { config: compileRuntimeGraph(graph).config, warnings: [] } },
        }),
      );
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', WorkerStub);
  const graph = createPolicyExample();
  const node = makeNode('proxy-chain', { x: 0, y: 0 }, 'chain');
  node.data.settings.steps = JSON.stringify({
    version: 1,
    steps: ['test-first', 'test-second'].map((nodeId, i) => ({
      id: String(i),
      outbound: { type: 'node', nodeId },
    })),
  });
  const observer = structuredClone(graph.nodes.find((n) => n.data.kind === 'observatory')!);
  observer.id = 'separate';
  graph.nodes.push(node, observer);
  const connection = {
    id: 'optional-monitor',
    source: node.id,
    sourceHandle: 'observation',
    target: observer.id,
    targetHandle: 'in',
  };
  graph.edges.push(connection);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const apply = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ProxyChainEditor
          graph={graph}
          node={node}
          stash={{ format: 'wayrill.stash', version: 3, groups: [] }}
          onApply={apply}
          onClose={() => {}}
        />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(100));
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Apply changes',
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    const saved = apply.mock.calls[0][0] as GraphState;
    expect(saved.edges.find((e) => e.id === connection.id)).toEqual(connection);
    expect(saved.nodes.find((n) => n.id === node.id)!.data.settings.observe).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
