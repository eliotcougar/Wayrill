import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { factoryDefaults } from './defaults';
import { displayNames, endpointDisplayName } from './displayNames';
it('keeps inbound and outbound namespaces separate and captures immutable revision labels', () => {
  const input = makeNode('proxy-inbound', { x: 0, y: 0 }),
    output = makeNode('direct-outbound', { x: 1, y: 0 });
  input.data.settings.tag = output.data.settings.tag = 'same';
  input.data.label = 'Applications';
  output.data.label = 'Internet';
  const graph = { name: 'Names', defaults: factoryDefaults(), nodes: [input, output], edges: [] };
  const names = displayNames(
    graph,
    {
      inbounds: [{ tag: 'same' }],
      outbounds: [{ tag: 'same' }, { tag: 'member' }, { tag: 'constructor' }],
    },
    { member: 'Subscription member' },
  );
  input.data.label = 'Draft rename';
  expect(names.inbound.same).toBe('Applications');
  expect(names.outbound.same).toBe('Internet');
  expect(names.outbound.member).toBe('Subscription member');
  expect(endpointDisplayName(names, 'outbound', 'constructor')).toBe('constructor');
});
it('supports tags resembling object properties and bounds generated labels', () => {
  const output = makeNode('direct-outbound', { x: 1, y: 0 });
  output.data.settings.tag = '__proto__';
  output.data.label = 'Actual server';
  const names = displayNames(
    { name: 'Names', defaults: factoryDefaults(), nodes: [output], edges: [] },
    { outbounds: [{ tag: '__proto__' }, { tag: 'inner' }] },
    JSON.parse('{"inner":"' + 'X'.repeat(200) + '"}'),
  );
  expect(endpointDisplayName(names, 'outbound', '__proto__')).toBe('Actual server');
  expect(names.outbound.inner).toHaveLength(160);
});
