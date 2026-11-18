// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TagReferencePicker, { TagGraphContext } from './TagReferencePicker';
import { makeEditorNode, makeNode } from '../graph/catalog';
import { nodeTag } from '../graph/tags';
import { graphTagChoices } from '../graph/tagReferences';
import { editGraphNode } from '../graph/nodeEditing';
import { createRoutingExample } from '../graph/example';
import { compileRuntimeGraph } from '../graph/runtime';
import type { GraphState } from '../graph/types';
import { importXrayConfig } from '../graph/xrayImport';
import { compileXrayGraph } from '../graph/xrayCompiler';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

it('bounds full Unicode names and distinguishes equal names across generated node identities', () => {
  const tags = new Set<string>();
  for (const kind of [
    'proxy-inbound',
    'tun-inbound',
    'ics-tun',
    'vless-outbound',
    'dns-handler',
    'proxy-chain',
    'policy-group',
  ] as const) {
    const data = makeNode(kind, { x: 0, y: 0 }).data;
    data.label = '🌏同じ名前 e\u0301 اسم'.repeat(10000);
    expect(nodeTag(data, 'long-name')).toMatch(/^[A-Za-z0-9_-]{25,28}$/);
    data.label = '🌏同じ名前 e\u0301 اسم';
    for (let index = 0; index < 100; index++) {
      const tag = nodeTag(data, `${kind}-${index}`);
      expect(tag).toMatch(/^[A-Za-z0-9_-]{25,28}$/);
      expect(tags.has(tag)).toBe(false);
      tags.add(tag);
    }
  }
});

it('retains native routing references and the effective core config when cards are renamed', () => {
  const graph = createRoutingExample();
  const original = compileRuntimeGraph(graph).config;
  let renamed = graph;
  for (const node of graph.nodes)
    renamed = editGraphNode(renamed, node.id, { label: '新しい名前 · ' + node.data.label });
  expect(compileRuntimeGraph(renamed).config).toEqual(original);
  expect(
    graphTagChoices(renamed, 'inbound').every((choice) => choice.name.startsWith('新しい名前')),
  ).toBe(true);
});

it('makes tagless native nodes selectable without changing an untouched native import', () => {
  const config = {
    inbounds: [
      { protocol: 'socks', listen: '127.0.0.1', port: 18080, settings: { auth: 'noauth' } },
    ],
    outbounds: [{ protocol: 'freedom' }],
  };
  const graph = importXrayConfig(JSON.stringify(config));
  const original = JSON.stringify(graph);
  const inputs = graphTagChoices(graph, 'inbound'),
    outputs = graphTagChoices(graph, 'outbound');
  expect(inputs).toHaveLength(1);
  expect(outputs).toHaveLength(1);
  expect(JSON.stringify(graph)).toBe(original);
  expect(compileXrayGraph(graph).config).toEqual(config);
  const node = graph.nodes.find((node) => node.id === graph.xray!.outboundOrder[0])!;
  const edited = editGraphNode(graph, node.id, { label: 'Internet' });
  expect(compileXrayGraph(edited).config).toMatchObject({
    inbounds: [{ ...config.inbounds[0], tag: inputs[0].tag }],
    outbounds: [{ ...config.outbounds[0], tag: outputs[0].tag }],
  });
  expect(graphTagChoices(edited, 'outbound')[0].name).toBe('Internet');
});

it.each([false, true])(
  'preserves literal commas in selected native tags and prefixes (prefixes=%s)',
  async (prefixes) => {
    const nodes = ['one', 'two'].map((name) => {
      const node = makeEditorNode(prefixes ? 'direct-outbound' : 'proxy-inbound', { x: 0, y: 0 });
      node.data.label = name;
      node.data.settings.tag = `eu,${name}`;
      return node;
    });
    const graph: GraphState = { name: 'Literal tags', nodes, edges: [] };
    let value = 'eu,one';
    const render = () =>
      root.render(
        <TagReferencePicker
          id="literal"
          graph={graph}
          kind={prefixes ? 'outbound' : 'inbound'}
          label="Destinations"
          multiple
          prefixes={prefixes}
          value={value}
          onChange={(next) => {
            value = next;
            render();
          }}
        />,
      );
    await act(render);
    await act(() => host.querySelector<HTMLButtonElement>('#literal')!.click());
    expect(host.querySelector<HTMLInputElement>('.tag-reference-choice input')!.checked).toBe(true);
    await act(() =>
      host.querySelectorAll<HTMLInputElement>('.tag-reference-choice input')[1].click(),
    );
    expect(value).toBe('eu,one\neu,two');
  },
);

it('finds and removes a selected external reference beyond the first page', async () => {
  let value = Array.from({ length: 50 }, (_, index) => `private-${index}`).join('\n');
  const render = () =>
    root.render(
      <TagReferencePicker
        id="external"
        label="Observed outbounds"
        kind="outbound"
        multiple
        prefixes
        value={value}
        onChange={(next) => {
          value = next;
          render();
        }}
      />,
    );
  await act(render);
  await act(() => host.querySelector<HTMLButtonElement>('#external')!.click());
  await act(() => {
    const input = host.querySelector<HTMLInputElement>('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'private-49',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Remove External reference: private-49"]')!
      .click(),
  );
  expect(value.split('\n')).toEqual(Array.from({ length: 49 }, (_, index) => `private-${index}`));
});

it('handles Escape within the picker and restores keyboard focus after selecting an outbound', async () => {
  const node = makeEditorNode('direct-outbound', { x: 0, y: 0 });
  const graph: GraphState = { name: 'Keyboard', nodes: [node], edges: [] };
  let value = '';
  const parentKey = vi.fn();
  const render = () =>
    root.render(
      <div onKeyDown={parentKey}>
        <TagReferencePicker
          id="keyboard"
          label="Connect through outbound"
          kind="outbound"
          graph={graph}
          value={value}
          onChange={(next) => {
            value = next;
            render();
          }}
        />
      </div>,
    );
  await act(render);
  const toggle = host.querySelector<HTMLButtonElement>('#keyboard')!;
  await act(() => toggle.click());
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(() => host.querySelector<HTMLInputElement>('input')!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(parentKey).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await act(() => toggle.click());
  await act(() => host.querySelector<HTMLInputElement>('.tag-reference-choice input')!.click());
  expect(value).toBe(node.data.settings.tag);
  expect(document.activeElement).toBe(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

it('distinguishes equal names by endpoint and excludes a dial-through reference to the edited outbound', async () => {
  const nodes = [18080, 18081].map((port) => {
    const node = makeEditorNode('socks-outbound', { x: 0, y: 0 });
    node.data.settings.address = '127.0.0.1';
    node.data.settings.port = port;
    return node;
  });
  const graph: GraphState = { name: 'Same names', nodes, edges: [] };
  const choices = graphTagChoices(graph, 'outbound');
  expect(choices[0].name).toBe(choices[1].name);
  expect(choices[0].detail).toContain('18080');
  expect(choices[1].detail).toContain('18081');
  await act(() =>
    root.render(
      <TagGraphContext.Provider value={{ graph, ownerId: nodes[0].id }}>
        <TagReferencePicker
          id="connect"
          label="Connect through outbound"
          kind="outbound"
          value=""
          onChange={() => {}}
        />
      </TagGraphContext.Provider>,
    ),
  );
  await act(() => host.querySelector<HTMLButtonElement>('#connect')!.click());
  expect(host.querySelectorAll('.tag-reference-choice')).toHaveLength(1);
  expect(host.querySelector('.tag-reference-choice')!.textContent).toContain('18081');
});

it('searches and selects by name from a large graph while retaining external references and prefix semantics', async () => {
  const graph: GraphState = { name: 'References', nodes: [], edges: [] };
  for (let i = 0; i < 1500; i++) {
    const node = makeEditorNode('direct-outbound', { x: 0, y: 0 }, `node-${i}`);
    node.data.label = `Destination ${i}`;
    graph.nodes.push(node);
  }
  graph.nodes[0].data.settings.tag = 'imported-prefix-east';
  graph.nodes[1].data.settings.tag = 'imported-prefix-west';
  const original = JSON.stringify(graph);
  let value = 'imported-prefix-\nexternal-destination';
  const render = () =>
    root.render(
      <TagReferencePicker
        graph={graph}
        id="references"
        label="Candidate outbounds"
        kind="outbound"
        multiple
        prefixes
        value={value}
        onChange={(next) => {
          value = next;
          render();
        }}
      />,
    );
  await act(render);
  expect(host.textContent).toContain('Destination 0, Destination 1');
  expect(host.textContent).toContain('External reference: external-destination');
  await act(() => host.querySelector<HTMLButtonElement>('#references')!.click());
  expect(host.querySelectorAll('.tag-reference-choice')).toHaveLength(30);
  expect(
    [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
      .slice(0, 2)
      .every((input) => input.checked && input.disabled),
  ).toBe(true);
  await act(() => {
    const input = host.querySelector<HTMLInputElement>('input:not([type=checkbox])')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'Destination 1499',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelectorAll('.tag-reference-choice')).toHaveLength(1);
  await act(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  expect(value.split('\n')).toEqual([
    'imported-prefix-',
    'external-destination',
    graph.nodes[1499].data.settings.tag,
  ]);
  expect(JSON.stringify(graph)).toBe(original);
});

it('includes native DNS query sources and metrics without modifying their tags', () => {
  const dns = makeNode('xray-dns', { x: 0, y: 0 });
  dns.data.settings.json = JSON.stringify({ tag: 'old-dns-query' });
  const servers = makeNode('xray-dns-servers', { x: 0, y: 0 });
  servers.data.settings.json = JSON.stringify({
    servers: [{ address: '8.8.8.8', tag: 'old-server-query' }],
  });
  const options = makeNode('xray-options', { x: 0, y: 0 });
  options.data.settings.json = JSON.stringify({ metrics: { tag: 'old-metrics' } });
  const graph: GraphState = { name: 'Native', nodes: [dns, servers, options], edges: [] };
  const original = JSON.stringify(graph);
  expect(graphTagChoices(graph, 'inbound').map((choice) => choice.tag)).toEqual([
    'old-dns-query',
    'old-server-query',
  ]);
  expect(graphTagChoices(graph, 'outbound').map((choice) => choice.tag)).toContain('old-metrics');
  expect(JSON.stringify(graph)).toBe(original);
});
