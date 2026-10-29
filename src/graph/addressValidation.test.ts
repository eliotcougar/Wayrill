import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { dnsAddressProblem } from './addressValidation';
import { fakeDnsPools } from './fakeDns';

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
