// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CompanionRuleDialog from './CompanionRuleDialog';
import { makeNode } from '../graph/catalog';
import { tableSettings } from '../graph/rules';
import type { GraphState } from '../graph/types';

const call = vi.hoisted(() => vi.fn());
vi.mock('../serviceClient', () => ({
  serviceCall: call,
  errorText: (error: unknown) => String(error),
}));
let root: Root, host: HTMLDivElement;
const add = vi.fn(),
  close = vi.fn();
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const field = (label: string) =>
  [...host.querySelectorAll('label')]
    .find((row) => row.firstChild?.textContent === label)!
    .querySelector('input,select') as HTMLInputElement | HTMLSelectElement;
const choose = async (label: string, value: string) =>
  act(() => {
    const input = field(label);
    const prototype =
      input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }),
    );
  });
const click = async (text: string) =>
  act(() => {
    [...host.querySelectorAll('button')].find((button) => button.textContent === text)!.click();
  });

it('preselects an observed filter and supports every entry mode and exact core-backed group choices without activation', async () => {
  const filter = makeNode('routing-filter', { x: 0, y: 0 }, 'filter');
  filter.data.settings = {
    ...filter.data.settings,
    ...tableSettings({
      outputs: [{ id: 'main', name: 'Main' }],
      defaultOutput: 'main',
      rules: [
        {
          id: 'web',
          name: 'Web',
          enabled: true,
          output: 'main',
          matchAll: false,
          conditions: { domain: 'old.test' },
        },
      ],
    }),
  };
  const graph: GraphState = { name: 'Draft', nodes: [filter], edges: [] };
  await act(() =>
    root.render(
      <CompanionRuleDialog
        request={{ host: 'page.test', filterIds: ['filter'] }}
        graph={graph}
        blocked={false}
        onAdd={add}
        onClose={close}
      />,
    ),
  );
  expect(field('Traffic filter').value).toBe('filter');
  await choose('Rule', 'web');
  expect(field('Entry').value).toBe('full:page.test');
  await choose('Entry type', 'domain');
  expect(field('Entry').value).toBe('domain:page.test');
  await choose('Entry type', 'contains');
  expect(field('Entry').value).toBe('page.test');
  await choose('Entry', 'full:custom.test');
  expect(field('Entry type').value).toBe('custom');
  const file = field('Resource file').value;
  call.mockResolvedValue({
    ready: true,
    total: 1,
    rows: [{ code: 'work', count: 12, matchedBy: 'domain:test' }],
  });
  await click('Find groups');
  expect(call).toHaveBeenCalledExactlyOnceWith('resources.browse', {
    file,
    kind: 'geosite',
    domain: 'page.test',
    offset: 0,
    limit: 100,
  });
  await choose('Matching groups', 'work');
  expect(field('Entry').value).toBe('geosite:work');
  expect(host.textContent).toContain('Adds the entire group.');
  await click('Add to draft');
  expect(add).toHaveBeenCalledExactlyOnceWith({
    filterId: 'filter',
    ruleId: 'web',
    entry: 'geosite:work',
  });
  expect(close).toHaveBeenCalledOnce();
  expect(graph.nodes[0].data.settings.rules).toContain('old.test');
});

it('requires an existing output for a new rule and blocks saving during activation', async () => {
  const filter = makeNode('routing-filter', { x: 0, y: 0 }, 'filter');
  const graph: GraphState = { name: 'Draft', nodes: [filter], edges: [] };
  const request = { host: 'page.test', filterIds: [] };
  const render = (blocked: boolean) => (
    <CompanionRuleDialog
      request={request}
      graph={graph}
      blocked={blocked}
      onAdd={add}
      onClose={close}
    />
  );
  await act(() => root.render(render(false)));
  await choose('Rule', '__new_rule__');
  await click('Add to draft');
  expect(add).not.toHaveBeenCalled();
  const output = (field('Output') as HTMLSelectElement).options[1].value;
  await choose('Output', output);
  await act(() => root.render(render(true)));
  await click('Add to draft');
  expect(add).not.toHaveBeenCalled();
  await act(() => root.render(render(false)));
  await click('Add to draft');
  expect(add).toHaveBeenCalledExactlyOnceWith({
    filterId: 'filter',
    ruleId: '__new_rule__',
    entry: 'full:page.test',
    newRule: { name: 'page.test', output },
  });
});
