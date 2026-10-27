import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { protocolConfig } from './protocols';
import { parseGraph, serializeGraph } from './model';
import { factoryDefaults } from './defaults';
import { tunAdapterNameProblem, tunCaptureScope } from './tun';

it('gives new host and shared adapters distinct readable names, preserving saved custom names', () => {
  const nodes = [makeNode('tun-inbound', { x: 0, y: 0 }), makeNode('ics-tun', { x: 300, y: 0 })];
  expect(protocolConfig(nodes[0].data).settings).toMatchObject({ name: 'Wayrill-TUN' });
  expect(protocolConfig(nodes[1].data).settings).toMatchObject({ name: 'Wayrill-ICS' });
  nodes[1].data.settings.json = JSON.stringify({
    ...JSON.parse(String(nodes[1].data.settings.json)),
    settings: { name: 'Wayrill · ТВ 🌐', gateway: ['198.18.0.1/32'], autoSystemRoutingTable: [] },
  });
  const restored = parseGraph(
    serializeGraph({ name: 'Names', nodes, edges: [], defaults: factoryDefaults() }),
  );
  expect(protocolConfig(restored.nodes[1].data).settings).toMatchObject({
    name: 'Wayrill · ТВ 🌐',
  });
  expect(tunCaptureScope({ name: 'Existing name' }, false).name).toBe('Existing name');
});

it('validates adapter aliases using Windows UTF-16 length and prohibited characters', () => {
  for (const name of [undefined, '', 'Wayrill · ТВ 🌐', '🌐'.repeat(50)])
    expect(tunAdapterNameProblem(name)).toBeUndefined();
  for (const name of ['   ', 'bad/name', 'bad\\name', 'bad:name', 'bad\nname', '🌐'.repeat(51), 42])
    expect(tunAdapterNameProblem(name)).toBeDefined();
});
