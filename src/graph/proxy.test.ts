import { describe, expect, it } from 'vitest';
import { httpProxyPorts } from './proxy';
import { defaultCaptureOptions, type CapturePlan } from './capture';

describe('HTTP proxy eligibility', () => {
  const input = { protocol: 'mixed', tag: 'local', listen: '127.0.0.1', port: 2081, settings: {} };
  it('excludes the private capture relay but allows a separate public proxy listener', () => {
    const capture: CapturePlan = {
      ...defaultCaptureOptions(),
      version: 2,
      inputs: [
        {
          tag: 'local',
          selectors: [],
          ports: '443',
          networks: ['tcp'],
          predicates: [],
          masks: ['0'],
        },
      ],
    };
    expect(httpProxyPorts({ inbounds: [input] }, capture)).toEqual([]);
    expect(
      httpProxyPorts({ inbounds: [input, { ...input, tag: 'public-http', port: 2082 }] }, capture),
    ).toEqual([2082]);
    expect(httpProxyPorts({ inbounds: [input] }, null)).toEqual([2081]);
  });
  it.each(['http', 'mixed', 'socks'])('accepts plain %s HTTP-compatible inputs', (protocol) => {
    expect(httpProxyPorts({ inbounds: [{ ...input, protocol }] })).toEqual([2081]);
  });
  it.each([
    { listen: '::1' },
    { port: 0 },
    { settings: { auth: 'password' } },
    { settings: { accounts: [{ user: 'fictional', pass: 'fictional' }] } },
    { streamSettings: { security: 'tls' } },
    { streamSettings: { network: 'ws' } },
    { streamSettings: { rawSettings: { header: { type: 'http' } } } },
    { StreamSettings: { Security: 'tls' } },
    { streamSettings: { security: 'none', Security: 'tls' } },
    { streamSettings: { rawSettings: null, tcpSettings: { header: { type: 'http' } } } },
    { settings: { accounts: null, users: [{ user: 'fictional', pass: 'fictional' }] } },
  ])('rejects a listener that cannot serve ordinary Windows HTTP proxy clients: %j', (change) => {
    expect(httpProxyPorts({ inbounds: [{ ...input, ...change }] })).toEqual([]);
  });
  it('accepts low ports for the local Windows proxy too', () => {
    expect(httpProxyPorts({ inbounds: [{ ...input, port: 80 }] })).toEqual([80]);
  });
  it('honors the accounts alias precedence used by Xray', () => {
    expect(
      httpProxyPorts({
        inbounds: [
          {
            ...input,
            settings: { accounts: [], users: [{ user: 'fictional', pass: 'fictional' }] },
          },
        ],
      }),
    ).toEqual([2081]);
  });
});
