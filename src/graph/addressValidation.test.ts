import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { dnsAddressProblem } from './addressValidation';
import { createDnsExample, createRoutingExample } from './example';
import { dnsProblems, readDnsFilter } from './dns';
import { compileDnsGraph } from './dnsCompilation';
import { fakeDnsPools } from './fakeDns';
import { diagnoseGraph, parseGraph, serializeGraph } from './model';
import { readRuleTable, tableSettings } from './rules';
import { compileRuntimeGraph } from './runtime';

it.each([
  ['ext-ip:geoip.dat:private', 'ext:geoip.dat:private'],
  ['!!geoip:private', '!!geoip:private'],
  ['!!192.0.2.0/24', '!!192.0.2.0/24'],
])(
  'preserves the core-supported IP rule %s through traffic and DNS filters',
  (expression, compiledExpression) => {
    const graph = createRoutingExample();
    const node = graph.nodes.find((n) => n.id === 'routes')!;
    const table = readRuleTable(node.data.settings);
    table.rules = [{ ...table.rules[0], conditions: { ip: expression } }];
    Object.assign(node.data.settings, tableSettings(table));
    const restored = parseGraph(serializeGraph(graph));
    expect(diagnoseGraph(restored).filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(
      readRuleTable(restored.nodes.find((n) => n.id === 'routes')!.data.settings).rules[0]
        .conditions.ip,
    ).toBe(expression);
    expect(compileRuntimeGraph(restored).config.routing).toMatchObject({
      rules: expect.arrayContaining([expect.objectContaining({ ip: [compiledExpression] })]),
    });

    const dns = createDnsExample();
    const filter = dns.nodes.find((n) => n.id === 'dns-routes')!;
    const preferences = readDnsFilter(filter.data.settings);
    preferences.rules = [{ ...preferences.rules[0], expectedIPs: expression }];
    filter.data.settings.rules = JSON.stringify(preferences.rules);
    expect(dnsProblems(filter.data).filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(compileDnsGraph(dns).dns.servers).toEqual(
      expect.arrayContaining([expect.objectContaining({ expectedIPs: [compiledExpression] })]),
    );
  },
);

it('keeps resource matchers out of DNS server addresses and FakeDNS pool CIDRs', () => {
  for (const expression of ['ext-ip:geoip.dat:private', '!!192.0.2.0/24']) {
    expect(dnsAddressProblem(expression)).not.toBeNull();
  }
  const node = makeNode('fakedns', { x: 0, y: 0 });
  node.data.settings.pools = JSON.stringify({
    ipPool: 'ext-ip:geoip.dat:private/24',
    poolSize: 2,
  });
  expect(() => fakeDnsPools(node.data)).toThrow('IPv4 or IPv6 CIDR');
});
