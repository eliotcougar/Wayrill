import { expect, it } from 'vitest';
import { factoryDefaults } from './defaults';
import { compileRuntimeGraph } from './runtime';
import { createTrafficExample } from './example';
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
