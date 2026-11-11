import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fixtureDir } from '../test/coreIntegration';
import {
  expectedRoute,
  routingPackets,
  routingScenario,
  routingSeeds,
  routingBaseConfig,
} from '../test/routingScenarios';
import { compileRuntimeGraph } from './runtime';
import { parseGraph, serializeGraph } from './model';
import {
  parseGraph as parseAquiferGraph,
  serializeGraph as serializeAquiferGraph,
} from '../../aquifer/src/graph/model';
import { compileXrayGraph as compileAquiferGraph } from '../../aquifer/src/graph/xrayCompiler';
import { importXrayConfig as importAquiferConfig } from '../../aquifer/src/graph/xrayImport';

// Encode only literal IPs used by the fixtures as protobuf bytes, independently
// of Wayrill's diagnostic request conversion.
function ipBytes(ip: string) {
  if (!ip.includes(':')) return Buffer.from(ip.split('.').map(Number)).toString('base64');
  const [left, right] = ip.split('::').map((part) => (part ? part.split(':') : []));
  const words = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return Buffer.from(
    words.flatMap((word) => {
      const n = Number.parseInt(word, 16);
      return [n >> 8, n & 255];
    }),
  ).toString('base64');
}

it('agrees with Xray TestRoute for generated graph paths and imported native predicates', () => {
  const oracle = process.env.WAYRILL_ROUTING_TEST_EXE;
  if (!oracle) throw new Error('Run npm run test:core to build the routing oracle.');
  const graphs = [false, true].flatMap((native) =>
    routingSeeds.map((seed) => routingScenario(seed, native)),
  );
  const packets = routingPackets();
  // Both consumers exercise the same native graph fixtures. Shared predicates
  // must remain wired into each compiler, not merely pass isolated helper tests.
  const cases = graphs.flatMap((graph) => {
    const text = serializeGraph(graph);
    // Share the routing topology, but let Aquifer import its own listeners and
    // outbounds. The apps intentionally have different inheritance settings.
    const remote = importAquiferConfig(JSON.stringify(routingBaseConfig));
    remote.nodes = [
      ...remote.nodes.filter((node) => node.data.kind !== 'routing-filter'),
      ...graph.nodes.filter((node) => node.data.kind === 'routing-filter'),
    ];
    remote.edges = graph.edges;
    return [
      { graph, app: 'Wayrill', routing: compileRuntimeGraph(parseGraph(text)).config.routing },
      ...(graph.xray
        ? [
            {
              graph,
              app: 'Aquifer',
              routing: compileAquiferGraph(parseAquiferGraph(serializeAquiferGraph(remote))).config
                .routing,
            },
          ]
        : []),
    ];
  });
  const flows = packets.map((p) => ({
    InboundTag: p.inboundTag,
    Network: p.network.toUpperCase(),
    TargetPort: p.port,
    TargetDomain: p.domain,
    Protocol: p.protocol,
    User: p.user,
    SourcePort: p.sourcePort,
    TargetIPs: [ipBytes(p.ip!)],
    SourceIPs: [ipBytes(p.sourceIP!)],
  }));
  const input = JSON.stringify(cases.map(({ routing }) => ({ routing, flows })));
  const file = join(fixtureDir, 'routing-decisions.json');
  writeFileSync(file, input);
  const result = spawnSync(oracle, [], {
    input,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(file + '.log', `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const actual = JSON.parse(result.stdout) as string[][];
  expect(actual).toHaveLength(cases.length);
  for (const [index, { graph, app }] of cases.entries()) {
    expect(actual[index]).toHaveLength(packets.length);
    for (const [n, packet] of packets.entries())
      expect(actual[index][n], `${app}/${graph.name}: ${JSON.stringify(packet)}`).toBe(
        expectedRoute(graph, packet),
      );
  }
});
