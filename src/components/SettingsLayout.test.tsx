// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProtocolEditor from './ProtocolEditor';
import { importXrayConfig } from '../graph/xrayImport';
import { compileXrayGraph } from '../graph/xrayCompiler';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === name,
  )!;

it('edits the authoritative stream method instead of an ignored network field', async () => {
  const original = {
    outbounds: [
      {
        tag: 'out',
        protocol: 'trojan',
        settings: { address: 'public.example', port: 443, password: 'fixture' },
        streamSettings: { method: 'ws', network: 'raw', wsSettings: { path: '/public' } },
      },
    ],
  };
  const graph = importXrayConfig(JSON.stringify(original)),
    node = graph.nodes.find((n) => n.data.kind === 'trojan-outbound')!;
  await act(() =>
    root.render(
      <ProtocolEditor
        node={node}
        defaults={graph.defaults}
        onApply={(_, patch) => {
          node.data = { ...node.data, ...patch };
        }}
        onClose={vi.fn()}
      />,
    ),
  );
  await act(() => button('Transport & security').click());
  const transport = host.querySelector<HTMLSelectElement>('#protocol-stream-method')!;
  expect(transport.value).toBe('ws');
  expect(host.querySelector('#protocol-stream-network')).toBeNull();
  expect(compileXrayGraph(graph).config).toEqual(original);
  await act(() => {
    transport.value = 'xhttp';
    transport.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(() => button('Apply protocol settings').click());
  expect(compileXrayGraph(graph).config).toEqual({
    outbounds: [
      {
        ...original.outbounds[0],
        streamSettings: { ...original.outbounds[0].streamSettings, method: 'xhttp' },
      },
    ],
  });
});
