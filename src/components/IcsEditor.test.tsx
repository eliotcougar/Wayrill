// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import IcsEditor from './IcsEditor';
import { serviceCall } from '../serviceClient';
import { makeNode } from '../graph/catalog';
import { factoryDefaults } from '../graph/defaults';
import { protocolConfig } from '../graph/protocols';
import {
  configureIcsGraph,
  sharedIpv6Ready,
  type SharingInspection,
} from '../graph/internetSharing';
import type { GraphState } from '../graph/types';

vi.mock('../serviceClient', () => ({
  desktopServiceAvailable: () => true,
  serviceCall: vi.fn(),
  errorText: (error: unknown) => String(error),
}));
const sharing: SharingInspection = {
  version: 'a'.repeat(64),
  managed: false,
  recoveryPending: false,
  lastError: null,
  supported: true,
  connections: [],
  pair: {
    public: { id: '11111111-1111-1111-1111-111111111111', name: 'Internet' },
    private: { id: '22222222-2222-2222-2222-222222222222', name: 'TV LAN' },
  },
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(serviceCall).mockResolvedValue(sharing);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
const initial = (): GraphState => ({
  name: 'QA',
  defaults: factoryDefaults(),
  nodes: [makeNode('ics-tun', { x: 0, y: 0 })],
  edges: [],
});
it('repairs an old adapter address through the draft without changing Windows or the saved graph', async () => {
  const graph = initial(),
    node = graph.nodes[0],
    raw = JSON.parse(String(node.data.settings.json));
  raw.settings.gateway = ['198.18.0.1/32'];
  node.data.settings.json = JSON.stringify(raw);
  const before = structuredClone(graph),
    apply = vi.fn();
  await act(() =>
    root.render(<IcsEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  const details = [...host.querySelectorAll('summary')].find(
    (s) => s.textContent === 'Adapter addresses',
  )!;
  await act(() => details.click());
  expect(
    host.querySelector<HTMLTextAreaElement>('[aria-label="Adapter addresses (CIDR)"]')!.value,
  ).toBe('198.18.0.1/32');
  await act(() => button('Use default').click());
  await act(() => button('Save settings').click());
  expect((protocolConfig(apply.mock.calls[0][0].nodes[0].data).settings as any).gateway).toEqual([
    '10.91.0.1/32',
  ]);
  expect(graph).toEqual(before);
  expect(serviceCall).toHaveBeenCalledExactlyOnceWith('tun.sharing.get');
});
it.each([false, true])(
  'can configure saved sharing while native recovery is pending=%s without changing Windows',
  async (recoveryPending) => {
    vi.mocked(serviceCall).mockResolvedValueOnce({
      ...sharing,
      source: 'remembered',
      recoveryPending,
    });
    const graph = initial(),
      apply = vi.fn();
    await act(async () =>
      root.render(
        <IcsEditor node={graph.nodes[0]} graph={graph} onApply={apply} onClose={vi.fn()} />,
      ),
    );
    expect(host.textContent).toContain('Saved sharing: Internet → TV LAN');
    expect(button('Forget saved sharing').disabled).toBe(false);
    await act(async () => button('Use saved sharing').click());
    const next = apply.mock.calls[0][0] as GraphState;
    expect(next.nodes.find((n) => n.data.kind === 'ics-tun')?.data.settings.sharingVersion).toBe(
      sharing.version,
    );
    expect(serviceCall).toHaveBeenCalledExactlyOnceWith('tun.sharing.get');
  },
);
it('allows forgetting inactive saved sharing with a fresh version', async () => {
  vi.mocked(serviceCall).mockResolvedValue({ ...sharing, source: 'remembered' });
  const graph = initial();
  await act(async () =>
    root.render(
      <IcsEditor node={graph.nodes[0]} graph={graph} onApply={vi.fn()} onClose={vi.fn()} />,
    ),
  );
  await act(async () => button('Forget saved sharing').click());
  expect(serviceCall).toHaveBeenCalledWith('tun.sharing.keep', {
    expectedVersion: sharing.version,
  });
});
it('sets up client IPv6 and host capture as an explicit draft action without applying networking', async () => {
  const graph = initial(),
    apply = vi.fn(),
    close = vi.fn();
  await act(async () =>
    root.render(<IcsEditor node={graph.nodes[0]} graph={graph} onApply={apply} onClose={close} />),
  );
  const ipv6 = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) =>
    i.parentElement?.textContent?.includes('Share IPv6'),
  )!;
  await act(async () => ipv6.click());
  expect(apply).not.toHaveBeenCalled();
  await act(async () => button('Set up host IPv6').click());
  const next = apply.mock.calls[0][0] as GraphState;
  expect(next.nodes.find((n) => n.data.kind === 'ics-tun')?.data.settings.shareIpv6).toBe(true);
  expect(sharedIpv6Ready(next)).toBe(true);
  expect(next.nodes.filter((n) => n.data.kind === 'tun-inbound')).toHaveLength(1);
  expect(serviceCall).toHaveBeenCalledExactlyOnceWith('tun.sharing.get');
  expect(close).toHaveBeenCalledTimes(1);
});
it('confirms the fresh pair and wires upstream in one draft update without activating networking', async () => {
  const graph = initial(),
    apply = vi.fn(),
    close = vi.fn();
  await act(async () =>
    root.render(<IcsEditor node={graph.nodes[0]} graph={graph} onApply={apply} onClose={close} />),
  );
  expect(host.textContent).toContain('Internet → TV LAN');
  await act(async () => button('Use detected sharing').click());
  expect(apply).toHaveBeenCalledTimes(1);
  const next = apply.mock.calls[0][0] as GraphState;
  expect(next.nodes).toHaveLength(2);
  expect(next.edges).toHaveLength(1);
  expect(next.nodes.find((n) => n.data.kind === 'direct-outbound')?.data.settings.icsUpstream).toBe(
    true,
  );
  expect(serviceCall).toHaveBeenCalledExactlyOnceWith('tun.sharing.get');
  expect(close).toHaveBeenCalledTimes(1);
});
it('keeps inspection failures unknown and prevents setup, while Cancel preserves the draft', async () => {
  vi.mocked(serviceCall).mockRejectedValueOnce(new Error('Service unavailable'));
  const graph = initial(),
    apply = vi.fn(),
    close = vi.fn();
  await act(async () =>
    root.render(<IcsEditor node={graph.nodes[0]} graph={graph} onApply={apply} onClose={close} />),
  );
  expect(host.textContent).toContain('Windows sharing is unknown.');
  expect(host.textContent).not.toContain('No Windows Internet sharing detected.');
  expect(button('Use detected sharing').disabled).toBe(true);
  await act(async () => button('Cancel').click());
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});
it('identifies enabled custom mappings without applying or disabling them', async () => {
  vi.mocked(serviceCall).mockResolvedValueOnce({
    ...sharing,
    supported: false,
    problem: 'Enabled custom ICS port forwarding cannot be preserved.',
    connections: [
      {
        id: sharing.pair!.public.id,
        name: 'Internet',
        role: 0,
        portMappings: [
          {
            name: 'TV service',
            protocol: 6,
            externalPort: 8443,
            internalPort: 443,
            target: '192.168.137.2',
            targetName: '',
          },
        ],
      },
    ],
  });
  const graph = initial(),
    apply = vi.fn();
  await act(async () =>
    root.render(
      <IcsEditor node={graph.nodes[0]} graph={graph} onApply={apply} onClose={vi.fn()} />,
    ),
  );
  expect(host.textContent).toContain('Internet: TCP 8443');
  expect(host.textContent).toContain('192.168.137.2:443');
  expect(host.textContent).toContain('TV service');
  expect(button('Use detected sharing').disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
  expect(serviceCall).toHaveBeenCalledExactlyOnceWith('tun.sharing.get');
});
it('reconfirms an existing disabled source without replacing its intentional traffic destination', async () => {
  const graph = configureIcsGraph(initial(), sharing, { x: 0, y: 0 }, false);
  const node = graph.nodes.find((n) => n.data.kind === 'ics-tun')!;
  node.data.enabled = false;
  node.data.settings.sharingVersion = 'b'.repeat(64);
  const block = makeNode('block-outbound', { x: 800, y: 0 });
  graph.nodes.push(block);
  graph.edges[0].target = block.id;
  const apply = vi.fn();
  await act(async () =>
    root.render(<IcsEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  await act(async () => button('Use detected sharing').click());
  const next = apply.mock.calls[0][0] as GraphState;
  expect(next.nodes.find((n) => n.id === node.id)?.data.enabled).toBe(true);
  expect(next.edges[0].target).toBe(block.id);
  expect(next.nodes).toHaveLength(graph.nodes.length);
});

it('offers forgetting saved intent when Windows has a different active pair', async () => {
  vi.mocked(serviceCall).mockResolvedValue({
    ...sharing,
    source: 'native',
    hasSavedPair: true,
    windowsSharingActive: true,
  });
  const graph = initial();
  await act(async () =>
    root.render(
      <IcsEditor node={graph.nodes[0]} graph={graph} onApply={vi.fn()} onClose={vi.fn()} />,
    ),
  );
  expect(button('Forget saved sharing').disabled).toBe(false);
  expect(button('Restore sharing')).toBeUndefined();
  await act(async () => button('Forget saved sharing').click());
  expect(serviceCall).toHaveBeenCalledWith('tun.sharing.keep', {
    expectedVersion: sharing.version,
  });
});

it('uses the ICS adapter name as the node name while preserving its other settings', async () => {
  const graph = initial(),
    apply = vi.fn();
  await act(async () =>
    root.render(
      <IcsEditor node={graph.nodes[0]} graph={graph} onApply={apply} onClose={vi.fn()} />,
    ),
  );
  const input = [...host.querySelectorAll<HTMLLabelElement>('label.editor-field')]
    .find((label) => label.querySelector('span')?.textContent === 'Name')!
    .querySelector('input')!;
  expect(input.value).toBe('Wayrill-ICS');
  const before = protocolConfig(graph.nodes[0].data);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'Wayrill · ТВ 🌐',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Use detected sharing').click());
  const next = apply.mock.calls[0][0] as GraphState;
  const updated = next.nodes.find((n) => n.data.kind === 'ics-tun')!;
  expect(updated.data.label).toBe('Wayrill · ТВ 🌐');
  expect(protocolConfig(updated.data).settings).toEqual({
    ...(before.settings as object),
    name: 'Wayrill · ТВ 🌐',
  });
});

it('rejects an invalid alias without applying a graph or changing Windows', async () => {
  const graph = initial(),
    apply = vi.fn();
  graph.nodes[0].data.settings.json = JSON.stringify({
    protocol: 'tun',
    settings: { name: 'bad/name' },
  });
  await act(async () =>
    root.render(
      <IcsEditor node={graph.nodes[0]} graph={graph} onApply={apply} onClose={vi.fn()} />,
    ),
  );
  await act(async () => button('Save settings').click());
  expect(apply).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('valid adapter name');
  expect(vi.mocked(serviceCall).mock.calls.every(([method]) => method === 'tun.sharing.get')).toBe(
    true,
  );
});
