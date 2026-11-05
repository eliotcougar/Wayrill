// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import RemoteSettings from './RemoteSettings';
import { coreIssues } from './RemoteCoreSettings';
import { remoteView } from './remoteModel';
import { nodeSettings, replaceNodeSettings } from './nodeSettings';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { settingsStructures } from './settingsFields';
import names from './graph/xrayConfigNames.json';
import type { ServerObject } from './inboundFields';

let host: HTMLDivElement, root: Root;
const destinations = [
  { tag: 'direct', group: false },
  { tag: 'relay-eu', group: false },
  { tag: 'automatic', group: true },
];
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.requestAnimationFrame = (callback) =>
    window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (item) =>
      item.getAttribute('aria-label') === name ||
      (item.getAttribute('role') === 'tab'
        ? item.childNodes[0]?.textContent?.trim()
        : item.textContent?.trim()) === name,
  )!;
const control = (name: string) =>
  host.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    `[aria-label="${name}"]`,
  )!;
const click = async (name: string) => {
  await act(async () => button(name).click());
};
async function change(name: string, value: string) {
  const input = control(name);
  expect(input, name).not.toBeNull();
  await act(async () => {
    const prototype =
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
async function toggle(name: string) {
  await act(async () => control(name).click());
}
async function render(value: unknown, schema = 'Config') {
  const save = vi.fn(),
    close = vi.fn();
  await act(async () =>
    root.render(
      <RemoteSettings
        title="Example"
        value={value}
        schema={schema}
        destinations={destinations}
        onSave={save}
        onClose={close}
      />,
    ),
  );
  return { save, close };
}

it('shows ordinary logging fields immediately and leaves an empty configuration untouched', async () => {
  const { save } = await render({});
  expect(control('Log level').value).toBe('');
  expect(control('Access log').textContent).toContain('Default (off)');
  expect(host.querySelector('[aria-label="Add field"]')).toBeNull();
  expect(host.querySelector('details')).toBeNull();
  for (const tab of ['Routing', 'Connections', 'Statistics & API', 'Resources', 'Advanced'])
    await click(tab);
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({});
});
it('distinguishes absent and empty logging blocks and does not enable access logs by changing verbosity', async () => {
  const { save } = await render({});
  await change('Log level', 'info');
  await click('Apply changes');
  expect(save).toHaveBeenLastCalledWith({ log: { access: 'none', loglevel: 'info' } });
});
it('preserves imported empty logging semantics without materializing any defaults', async () => {
  const { save } = await render({ Log: {} });
  expect(control('Access log').textContent).toContain('Default (console)');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({ Log: {} });
});
it('changing log privacy preserves the previously disabled access log', async () => {
  const { save } = await render({});
  await change('Mask IP addresses in logs', 'half');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({ log: { maskAddress: 'half', access: 'none' } });
});
it('clearly selects console, file and off destinations without losing a blank file-path draft', async () => {
  const { save } = await render({});
  await change('Access log', 'file');
  expect(control('Access log path on server').value).toBe('/var/log/xray/access.log');
  await change('Access log path on server', '');
  await click('Routing');
  await click('Apply changes');
  expect(save).not.toHaveBeenCalled();
  expect(control('Access log path on server')).not.toBeNull();
  await change('Access log path on server', '/srv/logs/access.log');
  await change('Error log', 'off');
  await click('Apply changes');
  expect(save).toHaveBeenLastCalledWith({ log: { access: '/srv/logs/access.log', error: 'none' } });
  await change('Access log', 'console');
  await click('Apply changes');
  expect(save.mock.calls.at(-1)![0].log.access).toBe('');
});
it('disabling logging retains its destinations', async () => {
  const { save } = await render({ log: { access: '/srv/access.log', error: '/srv/error.log' } });
  await change('Log level', 'none');
  expect(control('Access log').matches(':disabled')).toBe(true);
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({
    log: { access: '/srv/access.log', error: '/srv/error.log', loglevel: 'none' },
  });
});
it('edits a case-insensitive native key without replacing unrelated native options', async () => {
  const value = {
    Log: { LogLevel: 'warning', Extension: { enabled: true } },
    ExtraModule: { value: 42 },
  };
  const { save } = await render(value);
  await change('Log level', 'error');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({ ...value, Log: { ...value.Log, LogLevel: 'error' } });
});
it('creates a user policy level with visible timeouts, preserves other levels, and resets a blank value to default', async () => {
  const value = { policy: { levels: { '7': { connIdle: 99, extension: 'keep' } } } };
  const { save } = await render(value);
  await click('Connections');
  expect(control('Idle timeout (seconds)').getAttribute('placeholder')).toBe('300');
  await change('New policy level', '2');
  await click('Add level');
  await change('Idle timeout (seconds)', '600');
  await change('Handshake timeout (seconds)', '20');
  await change('Handshake timeout (seconds)', '');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({
    policy: { levels: { ...value.policy.levels, '2': { connIdle: 600 } } },
  });
  await change('Idle timeout (seconds)', '-1');
  await click('Logging');
  await click('Apply changes');
  expect(button('Connections').getAttribute('aria-selected')).toBe('true');
  expect(control('User policy level').value).toBe('2');
  expect(host.textContent).toContain('Idle timeout (seconds): enter a whole number');
});
it('rejects duplicate policy levels and provides a clear way to remove one', async () => {
  const { save } = await render({ policy: { levels: { '1': { connIdle: 5 } } } });
  await click('Connections');
  await change('New policy level', '01');
  await click('Add level');
  expect(host.textContent).toContain('already exists');
  await change('User policy level', '1');
  await click('Remove level');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({ policy: { levels: {} } });
});
it('uses explicit feature switches for stats, API and metrics, retaining settings when switched off and back on', async () => {
  const value = {
    API: {
      Tag: 'management',
      Listen: '127.0.0.1:9001',
      Services: ['StatsService', 'FutureService'],
    },
    stats: {},
  };
  const { save } = await render(value);
  await click('Statistics & API');
  await toggle('Enable management API');
  expect(control('API routing tag')).toBeNull();
  await toggle('Enable management API');
  expect(control('API routing tag').value).toBe('management');
  await toggle('Outbound download');
  await toggle('Restart logging');
  await toggle('Enable metrics endpoint');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({
    ...value,
    API: { ...value.API, Services: ['StatsService', 'FutureService', 'LoggerService'] },
    policy: { system: { statsOutboundDownlink: true } },
    metrics: { listen: '127.0.0.1:11111' },
  });
});
it('navigates validation to an invalid API field after changing tabs', async () => {
  const { save } = await render({ api: { tag: 'api', services: [] } });
  await click('Statistics & API');
  await change('API routing tag', '');
  await click('Logging');
  await click('Apply changes');
  expect(save).not.toHaveBeenCalled();
  expect(control('API routing tag')).not.toBeNull();
  expect(control('API routing tag').getAttribute('aria-invalid')).toBe('true');
});
it('configures resources with named schedules and preserves custom files when scheduling is disabled', async () => {
  const { save } = await render({});
  await click('Resources');
  await toggle('Automatically update resource files');
  expect(control('Update schedule').value).toBe('@daily');
  await change('Update schedule', 'custom');
  await change('Cron schedule', '15 2 * * *');
  await click('Add resource file');
  await change('File on server', 'geosite.dat');
  await change('HTTPS download URL', 'http://example.org/geosite.dat');
  await click('Apply changes');
  expect(save).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Enter an HTTPS resource URL');
  await change('HTTPS download URL', 'https://example.org/geosite.dat');
  await toggle('Automatically update resource files');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({
    geodata: { assets: [{ file: 'geosite.dat', url: 'https://example.org/geosite.dat' }] },
  });
});
it('edits object-shaped FakeDNS without converting it to a list, and accepts IPv6 pools', async () => {
  const value = { fakeDns: { ipPool: '198.18.0.0/15', poolSize: 32768, extension: 'keep' } };
  const { save } = await render(value);
  await click('Resources');
  await change('Address range (CIDR)', 'fd00::/64');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({ fakeDns: { ...value.fakeDns, ipPool: 'fd00::/64' } });
  expect(coreIssues(save.mock.calls[0][0])).toEqual([]);
});
it.each([
  ['NameServerConfig', { address: '1.1.1.1', extension: 7 }],
  [
    'DNSConfig',
    {
      servers: ['localhost'],
      hosts: { 'domain:example.org': '192.0.2.1' },
      queryStrategy: 'UseIP',
    },
  ],
  ['ObservatoryConfig', { subjectSelector: ['relay-'], probeURL: 'https://example.org/check' }],
  [
    'BurstObservatoryConfig',
    { subjectSelector: ['relay-'], pingConfig: { destination: 'https://example.org/check' } },
  ],
  [
    'OutboundDetourConfig',
    {
      tag: 'relay-eu',
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: 'example.org',
            port: 443,
            users: [{ id: '00000000-0000-4000-8000-000000000001', encryption: 'none' }],
          },
        ],
      },
    },
  ],
] as const)(
  'replaces the %s field builder with a normal form without rewriting imported data',
  async (schema, value) => {
    const { save } = await render(value, schema);
    expect(host.querySelector('[aria-label="Add field"]')).toBeNull();
    expect(host.querySelector('[aria-label="Available fields"]')).toBeNull();
    await click('Apply changes');
    expect(save).toHaveBeenCalledWith(value);
  },
);
it('makes DNS options available immediately for a compact string server', async () => {
  const { save } = await render('localhost', 'NameServerConfig');
  await change('DNS server port', '5353');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({ address: 'localhost', port: 5353 });
});
it('adds a DNS server from the handler without rewriting existing compact entries', async () => {
  const { save } = await render(
    { servers: ['localhost'], hosts: { 'example.org': '192.0.2.1' } },
    'DNSConfig',
  );
  await click('Servers');
  await click('Add DNS server');
  await click('Apply changes');
  expect(save).not.toHaveBeenCalled();
  const inputs = host.querySelectorAll<HTMLInputElement>('[aria-label="DNS server address"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      inputs[1],
      'https://dns.example.org/dns-query',
    );
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({
    servers: ['localhost', 'https://dns.example.org/dns-query'],
    hosts: { 'example.org': '192.0.2.1' },
  });
});
it('opens the correct section for an invalid advanced DNS field', async () => {
  const { save } = await render({}, 'DNSConfig');
  await click('Advanced');
  await change('Expired answer TTL (seconds)', '-1');
  await click('General');
  await click('Apply changes');
  expect(save).not.toHaveBeenCalled();
  expect(button('Advanced').getAttribute('aria-selected')).toBe('true');
  expect(control('Expired answer TTL (seconds)').getAttribute('aria-invalid')).toBe('true');
});
it('previews the observed outbounds while editing selectors', async () => {
  const { save } = await render({ subjectSelector: ['relay-'] }, 'ObservatoryConfig');
  await click('Candidates');
  expect(host.querySelectorAll('.policy-preview li')).toHaveLength(1);
  await change('Observed outbounds', 'all');
  expect(host.querySelectorAll('.policy-preview li')).toHaveLength(2);
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({ subjectSelector: [''] });
});
it('accepts fractional least-load tolerance using a visible named field', async () => {
  const value = {
    tag: 'group',
    selector: ['relay-'],
    strategy: { type: 'leastload', settings: { tolerance: 0.2 } },
  };
  const { save } = await render(value, 'BalancingRule');
  await change('Allowed failure rate', '0.35');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({
    ...value,
    strategy: { ...value.strategy, settings: { tolerance: 0.35 } },
  });
});
it('enables statistics in place while configuring per-user counters', async () => {
  const { save } = await render({});
  await click('Connections');
  await click('Enable traffic statistics');
  await toggle('Uploaded bytes');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({
    stats: {},
    policy: { levels: { '0': { statsUserUplink: true } } },
  });
});
it('does not show single-section tabs or irrelevant Block transport settings', async () => {
  const { save } = await render({ tag: 'blocked', protocol: 'blackhole' }, 'OutboundDetourConfig');
  expect(host.querySelector('[role="tablist"]')).toBeNull();
  expect(control('Transport')).toBeNull();
  expect(control('Response')).not.toBeNull();
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({ tag: 'blocked', protocol: 'blackhole' });
});
it.each(['active', ''])('edits the effective REALITY key when password is %s', async (password) => {
  const realitySettings = { Password: password, PublicKey: 'legacy', fingerprint: 'chrome' };
  const value = {
    tag: 'relay-eu',
    protocol: 'vless',
    settings: { address: 'example.org', port: 443, id: '00000000-0000-4000-8000-000000000001' },
    streamSettings: { security: 'reality', realitySettings },
  };
  const { save } = await render(value, 'OutboundDetourConfig');
  await click('Transport & security');
  expect(control('Server public key').value).toBe(password || 'legacy');
  await change('Server public key', 'replacement');
  await click('Apply changes');
  expect(save).toHaveBeenCalledWith({
    ...value,
    streamSettings: {
      ...value.streamSettings,
      realitySettings: { ...realitySettings, [password ? 'Password' : 'PublicKey']: 'replacement' },
    },
  });
});
it('keeps least-load tuning errors visible and navigable', async () => {
  const value = { tag: 'group', selector: ['relay-'], strategy: { type: 'leastload' } };
  const { save } = await render(value, 'BalancingRule');
  await change('Allowed failure rate', 'nope');
  await click('Apply changes');
  expect(save).not.toHaveBeenCalled();
  expect(control('Allowed failure rate').getAttribute('aria-invalid')).toBe('true');
  expect(host.textContent).toContain('enter a number from 0 to 1');
});
it.each([
  [
    'vless',
    {
      address: 'example.org',
      port: 443,
      id: '00000000-0000-4000-8000-000000000001',
      encryption: 'none',
    },
  ],
  ['vmess', { address: 'example.org', port: 443, id: '00000000-0000-4000-8000-000000000001' }],
  ['trojan', { address: 'example.org', port: 443, password: 'fictional' }],
  [
    'socks',
    {
      servers: [
        { address: '127.0.0.1', port: 1080, users: [{ user: 'alice', pass: 'fictional' }] },
      ],
    },
  ],
  ['http', { address: '127.0.0.1', port: 8080, user: 'alice', pass: 'fictional' }],
  [
    'shadowsocks',
    { address: 'example.org', port: 443, method: 'aes-128-gcm', password: 'fictional' },
  ],
  ['hysteria', { address: 'example.org', port: 443, version: 2 }],
  ['masque', { address: 'example.org', port: 443 }],
  [
    'wireguard',
    {
      secretKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      address: ['10.0.0.2/32'],
      peers: [
        { publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', endpoint: 'example.org:443' },
      ],
    },
  ],
  ['dns', { address: '1.1.1.1' }],
  ['freedom', { domainStrategy: 'UseIPv4' }],
  ['loopback', { inboundTag: 'proxy' }],
] as const)(
  'edits the %s outbound without changing credentials, legacy structure or other options',
  async (protocol, settings) => {
    const value = { protocol, tag: 'old', settings, futureSetting: { value: 1 } },
      { save } = await render(value, 'OutboundDetourConfig');
    await change('Outbound tag', 'new');
    await click('Apply changes');
    expect(save).toHaveBeenCalledWith({ ...value, tag: 'new' });
  },
);
it('retains configuration sections and graph routing when editing a global option', async () => {
  const config = {
    log: { loglevel: 'warning' },
    routing: {
      domainStrategy: 'AsIs',
      rules: [{ type: 'field', domain: ['domain:example.org'], outboundTag: 'direct' }],
      balancers: [{ tag: 'automatic', selector: ['direct'] }],
    },
    inbounds: [{ tag: 'proxy', protocol: 'socks', port: 1080, settings: { udp: true } }],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
  };
  const view = remoteView(JSON.stringify(config)),
    { save } = await render(nodeSettings(view, 'native-options')!.value);
  await change('Log level', 'error');
  await click('Apply changes');
  const output = compileRemote(
    replaceNodeSettings(view, 'native-options', save.mock.calls[0][0]),
    createUserWorkspace(config, emptyLibrary()),
  );
  expect(output.errors).toEqual([]);
  expect(output.config).toEqual({ ...config, log: { loglevel: 'error' } });
});
it('keeps known native fields aligned with the pinned schema', () => {
  const structures: Record<string, Record<string, string>> = names.structures;
  for (const [schema, fields] of Object.entries(settingsStructures))
    if (structures[schema])
      for (const field of fields)
        expect(Object.hasOwn(structures[schema], field.key), `${schema}.${field.key}`).toBe(true);
});

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
  if (process.env.AQUIFER_CORE_TESTS !== '1') return;
  const directory = resolve('.tools/settings-core-fixtures');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'globals.json');
  writeFileSync(
    file,
    JSON.stringify({ ...draft, outbounds: [{ tag: 'direct', protocol: 'freedom' }] }),
  );
  const result = spawnSync(
    process.env.WAYRILL_REMOTE_EDITOR_CORE!,
    ['run', '-test', '-config', file],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  writeFileSync(join(directory, 'globals.log'), result.stdout + result.stderr);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
