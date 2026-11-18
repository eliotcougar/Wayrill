// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inboundIssues, objectAt, get, type ServerObject } from './inboundFields';
import { coreIssues } from './RemoteCoreSettings';
import { compileRemote } from './remoteExport';
import { remoteView } from './remoteModel';
import { replaceNodeSettings } from './nodeSettings';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { render, change, toggle, click } from './test/settingsHarness';
import { examples, inbound } from './test/inboundExamples';
it.each(examples)(
  'edits and graph-exports %s without rewriting unrelated server options',
  async (protocol, settings, stream) => {
    const value = inbound(protocol, settings, stream),
      { save } = await render(value, 'InboundDetourConfig');
    expect(inboundIssues(value)).toEqual([]);
    await change('Tag', 'renamed-listener');
    await click('Apply changes');
    expect(save).toHaveBeenCalledWith({ ...value, tag: 'renamed-listener' });
    const config = { inbounds: [value], outbounds: [{ tag: 'direct', protocol: 'freedom' }] };
    const view = remoteView(JSON.stringify(config));
    const edited = replaceNodeSettings(view, 'native-in-0', save.mock.calls[0][0]);
    const output = compileRemote(edited, createUserWorkspace(config, emptyLibrary()));
    expect(output.errors).toEqual([]);
    expect(output.config).toEqual({ ...config, inbounds: [{ ...value, tag: 'renamed-listener' }] });
    const core = process.env.WAYRILL_REMOTE_TEST_CORE!;
    // -test builds the config only: no listener, adapter, or remote server is started.
    const testConfig = structuredClone(output.config);
    for (const item of testConfig.inbounds as ServerObject[]) {
      const tls = objectAt(objectAt(item, 'streamSettings'), 'tlsSettings');
      if (Array.isArray(tls.certificates))
        for (const certificate of tls.certificates) {
          certificate.certificateFile = process.env.WAYRILL_REMOTE_TEST_CERTIFICATE;
          certificate.keyFile = process.env.WAYRILL_REMOTE_TEST_KEY;
        }
    }
    const directory = resolve('.tools/inbound-core-fixtures');
    mkdirSync(directory, { recursive: true });
    const name =
      protocol + (get(settings, 'method')?.toString().startsWith('2022-') ? '-2022' : '');
    const file = join(directory, name + '.json');
    writeFileSync(file, JSON.stringify(testConfig));
    const result = spawnSync(core, ['run', '-test', '-config', file], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    writeFileSync(join(directory, name + '.log'), result.stdout + result.stderr);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  },
);

it('compiles the edited global settings without starting networking', async () => {
  const { save } = await render({});
  await change('Log level', 'error');
  await click('Connections');
  await change('Idle timeout (seconds)', '450');
  await click('Statistics & API');
  await toggle('Enable traffic statistics');
  await toggle('Outbound download');
  await toggle('Enable management API');
  await toggle('Traffic statistics');
  await click('Resources');
  await toggle('Automatically update resource files');
  await click('Add resource file');
  await change('File on server', 'geosite.dat');
  await change('HTTPS download URL', 'https://example.org/geosite.dat');
  await toggle('Use custom FakeDNS pools');
  await click('Apply changes');
  expect(save).toHaveBeenCalledOnce();
  const draft = save.mock.calls[0][0] as ServerObject;
  expect(coreIssues(draft)).toEqual([]);
  const directory = resolve('.tools/settings-core-fixtures');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'globals.json');
  writeFileSync(
    file,
    JSON.stringify({ ...draft, outbounds: [{ tag: 'direct', protocol: 'freedom' }] }),
  );
  const result = spawnSync(
    process.env.WAYRILL_REMOTE_TEST_CORE!,
    ['run', '-test', '-config', file],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  writeFileSync(join(directory, 'globals.log'), result.stdout + result.stderr);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
