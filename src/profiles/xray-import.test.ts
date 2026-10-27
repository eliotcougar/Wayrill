/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importProfiles } from './import';
import { applyStashedProfile } from './graph';
import { createTrafficExample } from '../graph/example';
import { compileRuntimeGraph } from '../graph/runtime';
const core = process.env.WAYRILL_XRAY_TEST_EXE,
  dir = process.env.WAYRILL_XRAY_FIXTURE_DIR;
const id = 'ba640cce-3c50-46f5-8406-bf36f35b5c90';
describe.skipIf(!core || !dir)(
  'Imported subscription profiles accepted by the configured Xray core',
  () => {
    const cases = [
      ['ws-tls', 'type=ws&security=tls&host=cdn.example.net&path=%2Ftest&fp=firefox'],
      ['httpupgrade-tls', 'type=httpupgrade&security=tls&path=%2Ftest'],
      ['xhttp-stream-one', 'type=xhttp&security=tls&mode=stream-one'],
      ['grpc-multi', 'type=grpc&security=tls&serviceName=service&mode=multi'],
      ['raw-tls', 'type=tcp&security=tls&sni=www.example.net'],
      [
        'reality-vision',
        `type=tcp&security=reality&pbk=${'A'.repeat(43)}&sid=ab12&sni=www.example.net&fp=chrome&flow=xtls-rprx-vision`,
      ],
      ['kcp', 'type=kcp&security=none&mtu=1350'],
    ];
    for (const [name, query] of cases)
      it(name, () => {
        const entry = importProfiles(
          `vless://${id}@${name === 'kcp' ? '127.0.0.1' : 'edge.example.net'}:443?${query}#Imported`,
        ).groups[0].entries[0];
        expect(entry.problem).toBe('');
        const graph = applyStashedProfile(
            createTrafficExample(),
            entry,
            { x: 0, y: 0 },
            'preferred',
          ),
          config = compileRuntimeGraph(graph).config;
        mkdirSync(dir!, { recursive: true });
        const path = join(dir!, `import-${name}.json`);
        writeFileSync(path, JSON.stringify(config));
        const result = spawnSync(core!, ['run', '-test', '-config', path], {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
        });
        writeFileSync(join(dir!, `import-${name}.log`), `${result.stdout}\n${result.stderr}`);
        expect(result.error).toBeUndefined();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      });
  },
);
