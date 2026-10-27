import { it, expect } from 'vitest';
import {
  captureProxyInputs,
  requestIssue,
  initialCaptureRequest,
  environmentCommands,
  type CaptureSettingsRow,
} from './systemCapture';
import type { RuntimeCompilation } from './graph/runtime';
import { localDirectExample } from './serviceClient';
const compiled: RuntimeCompilation = {
  config: localDirectExample,
  summary: {
    graphName: 'QA',
    listeners: [],
    outboundCount: 2,
    trafficRuleCount: 0,
    dnsServerCount: 0,
  },
  warnings: [],
};
it('does not offer encrypted/authenticated inputs or private relays as public proxies', () => {
  const value = structuredClone(compiled);
  (value.config.inbounds as Record<string, unknown>[])[1].streamSettings = { security: 'tls' };
  const inputs = captureProxyInputs(value, []);
  expect(inputs.map((i) => i.tag)).toEqual(['local-socks']);
  expect(inputs[0].applied).toBe(false);
});
it('requires exact applied tag and port rather than matching a port alone', () => {
  const inputs = captureProxyInputs(compiled, [
    { tag: 'different-tag', label: 'Other', port: 2080, http: true, socks: true },
  ]);
  expect(inputs.every((i) => !i.applied)).toBe(true);
});
it.each([
  { listen: '127.0.0.2' },
  { listen: '::1' },
  { protocol: 'tunnel', settings: { network: 'udp', address: '127.0.0.1', port: 9001 } },
])('does not borrow another listener’s proxy eligibility on a shared port: %j', (patch) => {
  const value = structuredClone(compiled);
  const inbounds = value.config.inbounds as Record<string, unknown>[];
  inbounds[1] = { ...inbounds[1], port: 2080, ...patch };
  const inputs = captureProxyInputs(value, [
    { tag: 'local-socks', label: 'Local', port: 2080, http: true, socks: true },
  ]);
  expect(inputs.map((input) => input.tag)).toEqual(['local-socks']);
  expect(inputs[0].applied).toBe(true);
});
it('allows automatic settings without a running graph, while validating PAC credentials', () => {
  const r = initialCaptureRequest('wininet', undefined, []);
  r.mode = 'automatic';
  r.autoDetect = true;
  expect(requestIssue(r, [], false, true)).toBe('');
  r.pacUrl = 'https://secret:password@example.org/a.pac';
  expect(requestIssue(r, [], false, true)).toContain('without credentials');
});
it('PowerShell instructions quote literal values without interpolation', () => {
  const row: CaptureSettingsRow = {
    channel: 'envUser',
    supported: true,
    version: 'v',
    managed: false,
    values: { http_proxy: "http://example.org/it's$(literal)" },
  };
  expect(environmentCommands([row, { ...row, channel: 'envMachine', values: {} }])).toContain(
    "$env:http_proxy = 'http://example.org/it''s$(literal)'",
  );
  expect(environmentCommands([row, { ...row, channel: 'envMachine', values: {} }])).toContain(
    'Remove-Item Env:https_proxy -ErrorAction SilentlyContinue',
  );
});

it('PowerShell session instructions merge user overrides with machine values', () => {
  const user: CaptureSettingsRow = {
    channel: 'envUser',
    supported: true,
    version: 'u',
    managed: false,
    values: { http_proxy: 'http://пользователь.example:8080', no_proxy: null },
  };
  const machine: CaptureSettingsRow = {
    ...user,
    channel: 'envMachine',
    version: 'm',
    values: {
      http_proxy: 'http://system.example:8081',
      https_proxy: 'http://系统.example:8082',
      no_proxy: 'localhost,例子.test',
    },
  };
  const commands = environmentCommands([machine, user]);
  expect(commands).toContain("$env:http_proxy = 'http://пользователь.example:8080'");
  expect(commands).not.toContain('http://system.example:8081');
  expect(commands).toContain("$env:https_proxy = 'http://系统.example:8082'");
  expect(commands).toContain("$env:no_proxy = 'localhost,例子.test'");
  expect(commands).toContain('Remove-Item Env:all_proxy');
  expect(environmentCommands([user])).toBe('');
  expect(environmentCommands([user, { ...machine, supported: false }])).toBe('');
});

it('session instructions expand only the selected effective REG_EXPAND_SZ value', () => {
  const user: CaptureSettingsRow = {
    channel: 'envUser',
    supported: true,
    version: 'u',
    managed: false,
    values: { no_proxy: '%USERPROFILE%,literal.example' },
    expandVariables: [],
  };
  const machine: CaptureSettingsRow = {
    ...user,
    channel: 'envMachine',
    values: { http_proxy: 'http://%PROXY_HOST%:8080', no_proxy: '%WINDIR%' },
    expandVariables: ['http_proxy', 'no_proxy'],
  };
  const commands = environmentCommands([user, machine]);
  expect(commands).toContain(
    "$env:http_proxy = [Environment]::ExpandEnvironmentVariables('http://%PROXY_HOST%:8080')",
  );
  expect(commands).toContain("$env:no_proxy = '%USERPROFILE%,literal.example'");
  expect(commands).not.toContain('%WINDIR%');
});
