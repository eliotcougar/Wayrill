import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import {
  parseDefaults,
  factoryDefaults,
  resolveNodeData,
  overrideSetting,
  resetNodeDefaults,
  resetCoreDefault,
} from './defaults';
import { outboundPreview } from './outbounds';
import { setSocketBuffer, socketBufferValue } from './socketBuffers';
import { parseGraph, serializeGraph } from './model';
import { importXrayConfig } from './xrayImport';

it('migrates old global UDP options, preserves foreign extras, and applies independently resettable node sizes', () => {
  const socket = setSocketBuffer(
    setSocketBuffer({ interface: 'Ethernet' }, 'udp', 'receive', 524288),
    'udp',
    'send',
    262144,
  );
  const defaults = parseDefaults({
    version: 1,
    settings: { sockoptExtra: JSON.stringify(socket) },
  });
  expect(defaults.settings).toMatchObject({ udpReceiveBufferKiB: 512, udpSendBufferKiB: 256 });
  expect(JSON.parse(String(defaults.settings.sockoptExtra))).toEqual({ interface: 'Ethernet' });
  const node = makeNode('direct-outbound', { x: 0, y: 0 });
  node.data.overrides = [];
  node.data = resolveNodeData(node.data, defaults);
  const buffers = (data: typeof node.data) =>
    (outboundPreview(data).streamSettings as { sockopt: Record<string, unknown> }).sockopt;
  expect(socketBufferValue(buffers(node.data), 'udp', 'receive').value).toBe(524288);
  node.data = { ...node.data, ...overrideSetting(node.data, 'udpReceiveBufferKiB', 1024) };
  expect(socketBufferValue(buffers(node.data), 'udp', 'receive').value).toBe(1048576);
  expect(socketBufferValue(buffers(node.data), 'udp', 'send').value).toBe(262144);
  node.data = resetNodeDefaults(node.data, defaults, 'udpReceiveBufferKiB');
  expect(socketBufferValue(buffers(node.data), 'udp', 'receive').value).toBe(524288);
  const graph = { name: 'Buffers', nodes: [node], edges: [], defaults };
  expect(serializeGraph(parseGraph(serializeGraph(graph)))).toBe(serializeGraph(graph));
  expect(factoryDefaults().settings.sockoptExtra).toBe('');
});

it('keeps imported native buffer values until a named override or reset is selected', () => {
  const imported = importXrayConfig(
    JSON.stringify({
      inbounds: [{ tag: 'local', protocol: 'socks', listen: '127.0.0.1', port: 2080 }],
      outbounds: [
        {
          tag: 'direct',
          protocol: 'freedom',
          streamSettings: {
            sockopt: {
              customSockopt: ['', 'udp4', 'udp6'].map((network) => ({
                system: 'windows',
                network,
                level: '65535',
                opt: '4098',
                type: 'int',
                value: String(network ? 786432 : 131072),
              })),
            },
          },
        },
        {
          tag: 'vmess',
          protocol: 'vmess',
          settings: {
            vnext: [
              {
                address: 'localhost',
                port: 443,
                users: [{ id: '00000000-0000-4000-8000-000000000001' }],
              },
            ],
          },
          streamSettings: { sockopt: setSocketBuffer({}, 'udp', 'receive', 786432) },
        },
      ],
    }),
  );
  const defaults = factoryDefaults();
  for (const tag of ['direct', 'vmess']) {
    const node = imported.nodes.find((item) => item.data.settings.tag === tag)!;
    const size = (network: 'udp' | 'tcp' = 'udp') => {
      const stream = outboundPreview(node.data).streamSettings as
        { sockopt?: Record<string, unknown> } | undefined;
      return socketBufferValue(stream?.sockopt ?? {}, network, 'receive').value;
    };
    node.data = resolveNodeData(node.data, defaults);
    expect(size()).toBe(786432);
    node.data = { ...node.data, ...overrideSetting(node.data, 'udpReceiveBufferKiB', 1024) };
    expect(size()).toBe(1048576);
    node.data = { ...node.data, ...overrideSetting(node.data, 'udpReceiveBufferKiB', 0) };
    expect(size()).toBeUndefined();
    expect(size('tcp')).toBe(tag === 'direct' ? 131072 : undefined);
    node.data = resetNodeDefaults(node.data, defaults, 'udpReceiveBufferKiB');
    expect(size()).toBe(262144);
    node.data = resetNodeDefaults(
      node.data,
      resetCoreDefault(defaults, 'udpReceiveBufferKiB'),
      'udpReceiveBufferKiB',
    );
    expect(size()).toBeUndefined();
  }
});
