import { describe, expect, it } from 'vitest';
import { applyDefaults, enableDefaults, factoryDefaults, resetCoreDefault } from './defaults';
import { createTrafficExample } from './example';
import { compileRuntimeGraph } from './runtime';
import { checkCoreConfig } from '../test/coreIntegration';

describe('configured core accepts inherited core defaults', () => {
  for (const transport of ['raw', 'xhttp', 'ws', 'grpc', 'kcp']) {
    it(transport, () => {
      const graph = applyDefaults(
        enableDefaults(createTrafficExample()),
        resetCoreDefault(factoryDefaults()),
      );
      graph.nodes.find((node) => node.id === 'preferred')!.data.settings.network = transport;
      const result = checkCoreConfig(
        'core-defaults-' + transport,
        compileRuntimeGraph(graph).config,
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    });
  }
});
