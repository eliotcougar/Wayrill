import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('standalone graph module initialization', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  it('loads FakeDNS pool validation before native DNS schemas and the catalog', async () => {
    const { automaticFakeDnsPools } = await import('./fakeDns');
    const { dnsServerFields } = await import('./nativeFields');
    const { makeNode } = await import('./catalog');
    expect(automaticFakeDnsPools(' use-ip-v4 ')).toEqual([
      { ipPool: '198.18.0.0/15', poolSize: 65535 },
    ]);
    expect(dnsServerFields.length).toBeGreaterThan(0);
    expect(makeNode('fakedns', { x: 0, y: 0 }).data.kind).toBe('fakedns');
  });

  it('loads connection roles before the catalog or global defaults', async () => {
    const { sourceConnectionKind } = await import('./connectionTypes');
    const { makeNode } = await import('./catalog');
    expect(sourceConnectionKind(makeNode('proxy-inbound', { x: 0, y: 0 }).data, 'dns')).toBe(
      'dns-traffic',
    );
  });

  it('loads protocol forms before the catalog or global defaults', async () => {
    const { specForKind } = await import('./protocols');
    const { factoryDefaults, applyDefaults } = await import('./defaults');
    const { makeNode } = await import('./catalog');
    expect(specForKind('vless-outbound')?.direction).toBe('outbound');
    expect(
      applyDefaults(
        { name: 'Initialization', nodes: [makeNode('proxy-inbound', { x: 0, y: 0 })], edges: [] },
        factoryDefaults(),
      ).nodes,
    ).toHaveLength(1);
  });
  it('loads policy sources before diagnostics, protocol forms and defaults', async () => {
    const { emptyPolicySources, readPolicySources } = await import('./policySources');
    const { makeNode } = await import('./catalog');
    const { diagnoseRuntimeGraph } = await import('./diagnostics');
    expect(readPolicySources(makeNode('policy-group', { x: 0, y: 0 }).data)).toEqual(
      emptyPolicySources(),
    );
    expect(diagnoseRuntimeGraph({ name: 'Empty', nodes: [], edges: [] })).toBeInstanceOf(Array);
  });
});
