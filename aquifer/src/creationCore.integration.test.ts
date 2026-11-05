import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { createRemoteNode } from './remoteCreation';
import { remoteView } from './remoteModel';
import { replaceNodeSettings } from './nodeSettings';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';

it('produces a core-valid fresh server config after structured editing', () => {
  let view = remoteView('{}');
  view = createRemoteNode(view, 'outbound:freedom').view;
  view = createRemoteNode(view, 'inbound:mixed').view;
  view = createRemoteNode(view, 'inbound:vless').view;
  view = replaceNodeSettings(view, 'native-in-1', {
    tag: 'vless',
    listen: '127.0.0.1',
    port: 10809,
    protocol: 'vless',
    settings: { decryption: 'none' },
  });
  const users = createUserWorkspace(view.original, emptyLibrary());
  // The User set assignment is an independent graph edit, not a raw JSON replay.
  const { sets, bindings } = createUserWorkspace(
    {
      inbounds: [
        {},
        {
          protocol: 'vless',
          settings: { clients: [{ id: '00000000-0000-4000-8000-000000000001' }] },
        },
      ],
    },
    emptyLibrary(),
  );
  users.sets = sets;
  users.bindings = bindings;
  const compiled = compileRemote(view, users);
  expect(compiled.errors).toEqual([]);
  const directory = resolve('.tools/fresh-server-fixtures');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'fresh-server.json');
  writeFileSync(path, JSON.stringify(compiled.config));
  const result = spawnSync(
    process.env.WAYRILL_REMOTE_TEST_CORE!,
    ['run', '-test', '-config', path],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  writeFileSync(join(directory, 'fresh-server.log'), result.stdout + result.stderr);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
