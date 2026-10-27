// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import BackupDialog from './BackupDialog';
import { backupRequest } from '../backup/client';
import { createContent, prepareRestore } from '../backup/model';
import { factoryDefaults } from '../graph/defaults';
import { defaultGroup } from '../profiles/stashModel';
import { makeNode } from '../graph/catalog';
import type { GraphState } from '../graph/types';
import type { Stash } from '../profiles/import';
import type { BackupRequest } from '../backup/client';
vi.mock('../backup/client', () => ({ backupRequest: vi.fn() }));
vi.mock('../exportFile', () => ({ exportFile: vi.fn(async () => true) }));
let root: Root, host: HTMLDivElement;
const graph: GraphState = {
  name: 'Current graph',
  defaults: factoryDefaults(),
  nodes: [makeNode('routing-filter', { x: 0, y: 0 }, 'filter')],
  edges: [],
};
const stash: Stash = { format: 'wayrill.stash', version: 3, groups: [defaultGroup()] };
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(backupRequest).mockReset();
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
async function selectFile() {
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [
      { size: 10, arrayBuffer: async () => new TextEncoder().encode('public fixture').buffer },
    ],
  });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}
it('reviews a backup, restores only chosen components and stages rather than activating it', async () => {
  const source = { ...graph, name: 'Saved graph' };
  const content = createContent('full', source, stash, {}, []);
  const restored = vi.fn(),
    closed = vi.fn();
  vi.mocked(backupRequest).mockImplementation(async (request: BackupRequest) =>
    request.operation === 'open'
      ? { encrypted: false, content }
      : request.operation === 'restore'
        ? prepareRestore(request.content, request.selection, request.graph, request.stash)
        : 'backup',
  );
  await act(() =>
    root.render(
      <BackupDialog
        request={{ mode: 'restore' }}
        graph={graph}
        blocked={false}
        getSnapshot={() => ({ graph, stash })}
        onRestore={restored}
        onClose={closed}
        onSaved={vi.fn()}
      />,
    ),
  );
  await selectFile();
  const label = [...host.querySelectorAll('label')].find((l) =>
    l.textContent?.startsWith('Stash ·'),
  )!;
  await act(() => label.querySelector('input')!.click());
  await act(() =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Restore to draft')!.click(),
  );
  const call = vi.mocked(backupRequest).mock.calls.at(-1)![0];
  expect(call).toMatchObject({ operation: 'restore', selection: { graph: true, stash: false } });
  expect(restored).toHaveBeenCalledWith(
    expect.objectContaining({ graph: expect.objectContaining({ name: 'Saved graph' }) }),
    { graph, stash },
  );
  expect(closed).toHaveBeenCalledOnce();
});
it('does not modify a workspace on a wrong password and allows retry', async () => {
  const restored = vi.fn();
  vi.mocked(backupRequest).mockResolvedValueOnce({ encrypted: true });
  await act(() =>
    root.render(
      <BackupDialog
        request={{ mode: 'restore' }}
        graph={graph}
        blocked={false}
        getSnapshot={() => ({ graph, stash })}
        onRestore={restored}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    ),
  );
  await selectFile();
  const password = host.querySelector<HTMLInputElement>('input[type=password]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      password,
      'wrong password',
    );
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
  vi.mocked(backupRequest).mockRejectedValueOnce(
    new Error('Incorrect password or damaged backup.'),
  );
  await act(() =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Unlock backup')!.click(),
  );
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Incorrect password');
  expect(restored).not.toHaveBeenCalled();
  expect(host.querySelector('input[type=file]')?.hasAttribute('disabled')).toBe(false);
});
it('cancels in-flight decoding and ignores completion after closing', async () => {
  let complete: (value: { encrypted: boolean }) => void = () => {};
  vi.mocked(backupRequest).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const restored = vi.fn(),
    closed = vi.fn();
  await act(() =>
    root.render(
      <BackupDialog
        request={{ mode: 'restore' }}
        graph={graph}
        blocked={false}
        getSnapshot={() => ({ graph, stash })}
        onRestore={restored}
        onClose={closed}
        onSaved={vi.fn()}
      />,
    ),
  );
  await selectFile();
  const signal = vi.mocked(backupRequest).mock.calls[0][1]!;
  await act(() =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click(),
  );
  expect(signal.aborted).toBe(true);
  await act(() => complete({ encrypted: false }));
  expect(restored).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledOnce();
});
