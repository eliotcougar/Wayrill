import { expect, it } from 'vitest';
import { factoryDefaults, parseDefaults } from './defaults';
import { compileRuntimeGraph } from './runtime';
import { createTrafficExample } from './example';
import { importXrayConfig } from './xrayImport';
import { coreProjection } from './xrayProjection';

it('passes independent listener buffer sizes through the existing Xray environment map', () => {
  const graph = createTrafficExample();
  graph.defaults = factoryDefaults();
  graph.defaults.settings.udpListenerReceiveKiB = 768;
  graph.defaults.settings.udpListenerSendKiB = 128;
  expect(compileRuntimeGraph(graph).config.env).toEqual({
    WAYRILL_UDP_LISTENER_RECEIVE_BYTES: '786432',
    WAYRILL_UDP_LISTENER_SEND_BYTES: '131072',
  });
  graph.defaults.settings.udpListenerSendKiB = 0;
  expect(coreProjection(graph.defaults).env).toMatchObject({
    WAYRILL_UDP_LISTENER_SEND_BYTES: '0',
  });
});

it('retains omission and round-trips native listener settings without baking factory buffers into imports', () => {
  const config = {
    inbounds: [{ tag: 'input', protocol: 'socks', listen: '127.0.0.1', port: 1080 }],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
  };
  expect(compileRuntimeGraph(importXrayConfig(JSON.stringify(config))).config).not.toHaveProperty(
    'env',
  );
  const env = {
    WAYRILL_UDP_LISTENER_RECEIVE_BYTES: '524288',
    WAYRILL_UDP_LISTENER_SEND_BYTES: '0',
  };
  const graph = importXrayConfig(JSON.stringify({ ...config, env }));
  expect(graph.defaults!.settings).toMatchObject({
    udpListenerReceiveKiB: 512,
    udpListenerSendKiB: 0,
  });
  expect(compileRuntimeGraph(graph).config.env).toEqual(env);
  graph.defaults!.settings.udpListenerReceiveKiB = 1024;
  expect(compileRuntimeGraph(graph).config.env).toMatchObject({
    WAYRILL_UDP_LISTENER_RECEIVE_BYTES: '1048576',
  });
});

it('rejects invalid sizes before saving global defaults', () => {
  for (const value of [-1, 1.5, 65537, 'bad'])
    expect(() =>
      parseDefaults({ version: 1, settings: { udpListenerReceiveKiB: value } }),
    ).toThrow();
});
