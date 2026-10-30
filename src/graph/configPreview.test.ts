import { expect, it } from 'vitest';
import { createDnsExample } from './example';
import { compileDnsGraph } from './dnsCompilation';
import { dnsContextPreview, policyContextPreview } from './configPreview';

it('previews only the selected DNS node and preserves the actual compiled server preferences', () => {
  const graph = createDnsExample();
  const config = compileDnsGraph(graph) as unknown as Record<string, unknown>;
  const local = graph.nodes.find((node) => node.id === 'local-dns')!;
  const servers = dnsContextPreview(config, local.data, local.id);
  expect(servers.dns.servers).toEqual([(config.dns as { servers: unknown[] }).servers[0]]);
  expect(JSON.stringify(servers)).not.toContain('cloudflare');
  const handler = graph.nodes.find((node) => node.data.kind === 'dns-handler')!;
  expect(dnsContextPreview(config, handler.data, handler.id).dns).not.toHaveProperty('servers');
  const filter = graph.nodes.find((node) => node.data.kind === 'dns-routing-filter')!;
  expect(dnsContextPreview(config, filter.data, filter.id).dns).toHaveProperty(
    'servers',
    (config.dns as { servers: unknown[] }).servers,
  );
  expect(dnsContextPreview(config, filter.data, filter.id)).not.toHaveProperty('outbounds');
});

it('excludes unrelated outbounds and balancers from policy and observatory previews', () => {
  const observation = { subjectSelector: ['candidate'], probeURL: 'https://example.test' };
  const config = {
    outbounds: [{ tag: 'unrelated-secret' }],
    routing: { rules: [], balancers: [{ tag: 'selected' }, { tag: 'other' }] },
    observatory: observation,
  };
  expect(policyContextPreview(config, 'selected')).toEqual({
    routing: { balancers: [{ tag: 'selected' }] },
    observatory: observation,
  });
  expect(policyContextPreview(config)).toEqual({ observatory: observation });
});
