// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createDnsExample, createRoutingExample } from '../graph/example';
import { readDnsFilter } from '../graph/dns';
import { readRuleTable } from '../graph/rules';
import PoolFilterEditor from './PoolFilterEditor';
import type { PoolLayer } from './layers';

it.each(['traffic', 'dns'] as const)(
  'keeps a %s filter draft open through a failed save',
  async (kind) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      const graph = kind === 'traffic' ? createRoutingExample() : createDnsExample();
      const node = graph.nodes.find(
        (item) => item.id === (kind === 'traffic' ? 'routes' : 'dns-routes'),
      )!;
      const layer: PoolLayer = {
        id: 'filter',
        name: 'Filter layer',
        data:
          kind === 'traffic'
            ? { kind, filter: { nodeId: node.id, table: readRuleTable(node.data.settings) } }
            : { kind, nodeId: node.id, filter: readDnsFilter(node.data.settings) },
      };
      let reject!: (error: Error) => void;
      const pending = new Promise<void>((_, fail) => {
        reject = fail;
      });
      const onSave = vi
        .fn<(layer: PoolLayer) => Promise<void>>()
        .mockReturnValueOnce(pending)
        .mockResolvedValue(undefined);
      const onClose = vi.fn();
      await act(() =>
        root.render(
          <PoolFilterEditor
            layer={layer}
            pool={{ id: 'pool', name: 'Pool', folder: '', configurations: [], members: [] }}
            onSave={onSave}
            onClose={onClose}
          />,
        ),
      );
      const name = kind === 'traffic' ? 'Rule name' : 'Preference name';
      const field =
        [...host.querySelectorAll('label')]
          .find((label) => label.textContent?.trim() === name)
          ?.querySelector('input') ??
        host.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!;
      await act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          field,
          'My edited rule',
        );
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const dialog = host.querySelector('dialog')!;
      const save = host.querySelector<HTMLButtonElement>('.rule-editor-footer .primary-button')!;
      await act(() => {
        save.click();
        save.click();
      });
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(save.textContent?.trim()).toBe('Saving…');
      expect(dialog.getAttribute('closedby')).toBe('none');

      const escape = new Event('cancel', { cancelable: true });
      await act(() => {
        dialog.dispatchEvent(escape);
        host.querySelector<HTMLButtonElement>('button[aria-label="Close editor"]')!.click();
        host.querySelector<HTMLButtonElement>('.rule-editor-footer .secondary-button')!.click();
      });
      expect(escape.defaultPrevented).toBe(true);
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => reject(new Error('Pool storage is unavailable.')));
      expect(dialog.open).toBe(true);
      expect(dialog.hasAttribute('closedby')).toBe(false);
      expect(host.textContent).toContain('Pool storage is unavailable.');
      expect(field.value).toBe('My edited rule');
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => save.click());
      const saved = onSave.mock.calls[1]![0].data;
      const rule =
        saved.kind === 'traffic'
          ? saved.filter.table.rules[0]
          : saved.kind === 'dns'
            ? saved.filter.rules[0]
            : undefined;
      expect(rule?.name).toBe('My edited rule');
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await act(() => root.unmount());
      host.remove();
      HTMLDialogElement.prototype.showModal = showModal;
    }
  },
);
