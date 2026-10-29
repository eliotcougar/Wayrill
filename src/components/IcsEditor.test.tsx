// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import IcsEditor from './IcsEditor';
import { serviceCall } from '../serviceClient';
import { makeNode } from '../graph/catalog';
import { factoryDefaults } from '../graph/defaults';
import { type SharingInspection } from '../graph/internetSharing';
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
