import { it, expect } from 'vitest';
import { environmentCommands, type CaptureSettingsRow } from './systemCapture';
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
