import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { remoteView } from './remoteModel';
import { compileRemote } from './remoteExport';
import { nodeSettings, replaceNodeSettings } from './nodeSettings';
import { applyChain, configuredOutbounds, setNextProxy } from './remoteStashModel';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { setProperty } from './nativeProperties';

const core = process.env.WAYRILL_REMOTE_TEST_CORE;
describe('executable API and Stash drafts', () => {
  it.each([true, false])(
    'accepts API enabled=%s and an edited socket proxy chain',
    (apiEnabled) => {
      const config = {
        api: { tag: 'api', services: ['StatsService'] },
        inbounds: [
          {
            tag: 'admin',
            listen: '127.0.0.1',
            port: 18085,
            protocol: 'dokodemo-door',
            settings: { address: '127.0.0.1' },
          },
          { tag: 'local', listen: '127.0.0.1', port: 18090, protocol: 'mixed', settings: {} },
        ],
        outbounds: [
          { tag: 'direct', protocol: 'freedom' },
          {
            tag: 'relay',
            protocol: 'socks',
            settings: { address: 'relay.example.org', port: 1080 },
          },
          {
            tag: 'entry',
            protocol: 'socks',
            settings: { address: 'entry.example.org', port: 1080 },
          },
        ],
        routing: {
          rules: [
            { inboundTag: ['admin'], outboundTag: 'api' },
            { inboundTag: ['local'], outboundTag: 'relay' },
          ],
        },
      };
      let view = remoteView(JSON.stringify(config));
      const editor = nodeSettings(view, 'native-options')!;
      view = replaceNodeSettings(
        view,
        'native-options',
        apiEnabled
          ? editor.value
          : setProperty(editor.value as Record<string, unknown>, 'api', undefined),
        editor.apiListeners!.map((item) => ({ ...item, value: { ...item.value, port: 18086 } })),
      );
      const outbounds = configuredOutbounds(view);
      view = remoteView(
        JSON.stringify(
          applyChain(
            view.original,
            outbounds.map((item, index) => (index === 1 ? setNextProxy(item, 'entry') : item)),
          ),
        ),
      );
      const output = compileRemote(view, createUserWorkspace(view.original, emptyLibrary()));
      expect(output.errors).toEqual([]);
      const directory = resolve('.tools/stash-config-fixtures');
      mkdirSync(directory, { recursive: true });
      const file = join(directory, `${apiEnabled}.json`);
      writeFileSync(file, JSON.stringify(output.config, null, 2));
      const result = spawnSync(core!, ['run', '-test', '-config', file], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      writeFileSync(join(directory, `${apiEnabled}.log`), result.stdout + result.stderr);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );
});
