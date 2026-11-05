import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { remoteView } from './remoteModel';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { ruleIssues } from './routingEditor';
import { policyIssues } from './RemotePolicySettings';
import { nodeSettings, replaceNodeSettings } from './nodeSettings';

const core = process.env.WAYRILL_REMOTE_TEST_CORE;
describe('executable routing and policy editor configurations', () => {
  it.each(['random', 'roundrobin', 'leastping', 'leastload'])(
    'accepts %s policies, aliases and compound rule conditions',
    (strategy) => {
      const config = {
        inbounds: [
          { tag: 'local', listen: '127.0.0.1', port: 18090, protocol: 'mixed', settings: {} },
        ],
        outbounds: [
          { tag: 'direct', protocol: 'freedom' },
          { tag: 'relay-eu', protocol: 'freedom' },
          { tag: 'relay-us', protocol: 'freedom' },
        ],
        observatory: {
          subjectSelector: ['relay-'],
          probeURL: 'https://www.google.com/generate_204',
          probeInterval: '30s',
        },
        routing: {
          balancers: [
            {
              tag: 'regional',
              selector: ['relay-'],
              fallbackTag: 'direct',
              strategy: {
                type: strategy,
                ...(strategy === 'leastload'
                  ? {
                      settings: {
                        baselines: ['50ms', '100ms'],
                        expected: 1,
                        maxRTT: '2s',
                        tolerance: 0.1,
                      },
                    }
                  : {}),
              },
            },
          ],
          rules: [
            {
              domain: ['domain:example.org'],
              source: ['192.0.2.0/24'],
              port: '80,443',
              network: 'tcp,udp',
              protocol: ['http', 'tls'],
              balancerTag: 'regional',
            },
            { domains: ['domain:other.example'], sourcePort: '1024-65535', outboundTag: 'direct' },
            { network: 'tcp,udp', outboundTag: 'direct' },
          ],
        },
      };
      const destinations = [
        ...config.outbounds.map(({ tag }) => ({ tag, group: false })),
        { tag: 'regional', group: true },
      ];
      expect(ruleIssues(config.routing, destinations)).toEqual([]);
      expect(policyIssues(config.routing.balancers[0], destinations)).toEqual([]);
      const view = remoteView(JSON.stringify(config)),
        output = compileRemote(view, createUserWorkspace(config, emptyLibrary()));
      expect(output.errors).toEqual([]);
      expect(output.config).toEqual(config);
      const directory = resolve('.tools/routing-config-fixtures');
      mkdirSync(directory, { recursive: true });
      const file = join(directory, `${strategy}.json`);
      writeFileSync(file, JSON.stringify(output.config, null, 2));
      const test = spawnSync(core!, ['run', '-test', '-config', file], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      writeFileSync(join(directory, `${strategy}.log`), test.stdout + test.stderr);
      expect(test.error).toBeUndefined();
      expect(test.status, test.stdout + test.stderr).toBe(0);
    },
  );
});

it.each(['native-dns', 'native-resolver-0'])('accepts query routing after renaming %s', (id) => {
  const config = {
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    dns: { tag: 'dns-global', servers: [{ address: '8.8.8.8', tag: 'dns-server' }] },
    routing: { rules: [{ inboundTag: ['dns-global', 'dns-server'], outboundTag: 'direct' }] },
  };
  let view = remoteView(JSON.stringify(config));
  view = replaceNodeSettings(view, id, {
    ...(nodeSettings(view, id)!.value as object),
    tag: 'renamed-query',
  });
  const output = compileRemote(view, createUserWorkspace(view.original, emptyLibrary()));
  expect(output.errors).toEqual([]);
  const directory = resolve('.tools/routing-config-fixtures');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `renamed-${id}.json`);
  writeFileSync(file, JSON.stringify(output.config, null, 2));
  const result = spawnSync(core!, ['run', '-test', '-config', file], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  writeFileSync(join(directory, `renamed-${id}.log`), result.stdout + result.stderr);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
