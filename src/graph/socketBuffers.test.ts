import { expect, it } from 'vitest';
import { setSocketBuffer, socketBufferValue } from './socketBuffers';

const option = (network: string, value: string, extra = {}) => ({
  system: 'windows',
  network,
  level: '65535',
  opt: '4098',
  value,
  type: 'int',
  ...extra,
});
it('uses native option order, wildcard and per-family scope without rewriting them', () => {
  const input = {
    customSockopt: [option('', '1000'), option('udp4', '2000'), option('udp6', '3000')],
    interface: 'Ethernet',
  };
  expect(socketBufferValue(input, 'udp', 'receive')).toEqual({
    value: undefined,
    families: [2000, 3000],
  });
  const changed = setSocketBuffer(input, 'udp', 'receive', 524288);
  expect(socketBufferValue(changed, 'udp', 'receive').value).toBe(524288);
  expect(changed.customSockopt).toEqual([...input.customSockopt, option('udp', '524288')]);
  expect(setSocketBuffer(changed, 'udp', 'receive', undefined)).toEqual(input);
});
it('edits only the requested Windows option while preserving foreign, TCP and send options', () => {
  const untouched = [
    option('udp', '4000', { system: 'linux' }),
    option('tcp', '5000'),
    option('udp', '6000', { opt: '4097' }),
    option('udp', '7000', { system: '' }),
  ];
  const input = {
    tcpFastOpen: true,
    customSockopt: [...untouched, option('udp', '8000'), option('udp', '9000')],
  };
  expect(setSocketBuffer(input, 'udp', 'receive', 12345)).toEqual({
    tcpFastOpen: true,
    customSockopt: [...untouched, option('udp', '12345')],
  });
  expect(setSocketBuffer(input, 'udp', 'receive', undefined)).toEqual({
    tcpFastOpen: true,
    customSockopt: untouched,
  });
  expect(socketBufferValue(input, 'udp', 'send').value).toBe(6000);
});
it('handles noncanonical field capitalization and clears an empty option list', () => {
  const changed = setSocketBuffer(
    {
      CustomSockopt: [
        {
          System: 'windows',
          Network: 'udp',
          Level: '65535',
          Opt: '4098',
          Value: '100',
          Type: 'int',
        },
      ],
    },
    'udp',
    'receive',
    2048,
  );
  expect(socketBufferValue(changed, 'udp', 'receive').value).toBe(2048);
  expect(setSocketBuffer(changed, 'udp', 'receive', undefined)).toEqual({});
});
it.each([0, -1, 1.2, 2147483648, NaN])('rejects an invalid buffer size %s', (value) => {
  expect(() => setSocketBuffer({}, 'tcp', 'send', value)).toThrow();
});
