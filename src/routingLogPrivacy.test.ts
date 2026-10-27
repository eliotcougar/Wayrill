import { expect, it } from 'vitest';
import { maskLogDestination } from './routingLogPrivacy';

it.each([
  ['203.0.113.23:443', '', '203.0.113.23:443'],
  ['203.0.113.23:443', 'quarter', '203.*.*.*:443'],
  ['203.0.113.23:443', 'half', '203.0.*.*:443'],
  ['203.0.113.23:443', 'full', '*.*.*.*:443'],
  ['[2001:db8:12::7]:53', 'quarter', '[2001::/16]:53'],
  ['[2001:db8:12::7]:53', 'half', '[2001:db8::/32]:53'],
  ['[::ffff:192.0.2.12]:53', 'half', '[0:0::/32]:53'],
  ['[::1]:53', 'full', '[masked IPv6]:53'],
  ['xn--example.test:443', 'full', '[masked domain]:443'],
  ['私有.example:443', 'half', '[masked domain]:443'],
  ['private.example:443', '', 'private.example:443'],
  ['unrecognized:address:value', 'full', '[masked destination]'],
])('masks %s only when requested with %s', (destination, mask, expected) => {
  expect(maskLogDestination(destination, mask)).toBe(expected);
});
