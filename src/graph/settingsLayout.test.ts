import { globalFields } from './defaults';
import { basicGlobalSettings, advancedGlobalSettings } from './settingsLayout';
import { getDefinition } from './catalog';
import { nodeSettingGroups } from './settingsLayout';
import { expect, it } from 'vitest';
import { protocolSource } from './protocolSource';
import {
  advancedSettings,
  basicSettings,
  configuredFieldLabels,
  isBasicSetting,
  securityFieldsForRole,
  settingsLayoutCoverage,
} from './settingsLayout';

it('requires every generated protocol field to be reviewed on a core upgrade', () => {
  expect(settingsLayoutCoverage()).toEqual([]);
  for (const [structure, source] of Object.entries(protocolSource)) {
    const reviewed = [...basicSettings[structure], ...advancedSettings[structure]];
    expect(new Set(reviewed).size, structure).toBe(reviewed.length);
    expect(reviewed.sort(), structure).toEqual(source.fields.map((f) => f.key).sort());
  }
});
it('keeps required identities and active legacy endpoint/account layouts accessible', () => {
  for (const key of [
    'VLessOutboundConfig.id',
    'VLessOutboundConfig.encryption',
    'VLessOutboundConfig.vnext',
    'TrojanClientConfig.servers',
    'SocksUserConfig.user',
    'SocksUserConfig.pass',
    'MasqueUserConfig.email',
    'HysteriaConfig.auth',
    'VLessUserConfig.id',
    'TunConfig.gateway',
    'WireGuardPeerConfig.publicKey',
  ])
    expect(isBasicSetting(key), key).toBe(true);
  expect(isBasicSetting('FutureConfig.requiredKey')).toBe(true);
  expect(isBasicSetting('TLSConfig.futureRequiredKey')).toBe(true);
});
it('separates REALITY client/server controls and keeps client certificates under Advanced', () => {
  const fields = [
    'privateKey',
    'password',
    'serverNames',
    'serverName',
    'shortIds',
    'shortId',
    'fingerprint',
    'show',
    'allowInsecure',
  ].map((key) => ({ key }));
  expect(securityFieldsForRole(fields, 'reality', 'outbound').map((f) => f.key)).toEqual([
    'password',
    'serverName',
    'shortId',
    'fingerprint',
    'show',
  ]);
  expect(securityFieldsForRole(fields, 'reality', 'inbound').map((f) => f.key)).toEqual([
    'privateKey',
    'serverNames',
    'shortIds',
    'show',
  ]);
  expect(isBasicSetting('TLSConfig.certificates', 'inbound')).toBe(true);
  expect(isBasicSetting('TLSConfig.certificates', 'outbound')).toBe(false);
});
it('summarizes explicit zero/false/blank values and aliases without exposing secrets', () => {
  expect(
    configuredFieldLabels(
      { PASSWORD: 'secret', timeout: 0, enabled: false, notes: '', expectIPs: [] },
      [
        { key: 'password', label: 'Password' },
        { key: 'timeout', label: 'Timeout' },
        { key: 'enabled', label: 'Enabled' },
        { key: 'notes', label: 'Notes' },
        { key: 'expectedIPs', label: 'Expected IPs', aliases: ['expectIPs'] },
      ],
    ),
  ).toEqual(['Password', 'Timeout', 'Enabled', 'Notes', 'Expected IPs']);
});

it('groups named-form transport/socket tuning without hiding selected transport credentials', () => {
  for (const kind of ['vless-outbound', 'socks-outbound'] as const) {
    const definition = getDefinition(kind),
      groups = nodeSettingGroups(definition, definition.fields),
      group = (key: string) => groups.find((g) => g.fields.some((f) => f.key === key))!;
    expect(group('wsHeartbeat').advanced).toBe(true);
    expect(group('grpcIdleTimeout').advanced).toBe(true);
    expect(group('hysteriaAuth').advanced).not.toBe(true);
    expect(group('xdriveSettings').advanced).not.toBe(true);
    expect(group('echConfigList').advanced).not.toBe(true);
    expect(group('spiderX').advanced).toBe(true);
    expect(groups.flatMap((g) => g.fields.map((f) => f.key)).sort()).toEqual(
      definition.fields.map((f) => f.key).sort(),
    );
  }
  const direct = getDefinition('direct-outbound'),
    groups = nodeSettingGroups(direct, direct.fields);
  expect(groups.find((g) => g.fields.some((f) => f.key === 'domainStrategy'))!.advanced).not.toBe(
    true,
  );
  expect(groups.find((g) => g.fields.some((f) => f.key === 'tcpKeepAliveIdle'))!.advanced).toBe(
    true,
  );
});

it('requires every app global default to have a reviewed tier', () => {
  const keys = [...basicGlobalSettings, ...advancedGlobalSettings];
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys.sort()).toEqual(globalFields.map((f) => f.key).sort());
});

it('shows a single REALITY public-key credential while preserving the active native alias', () => {
  const fields = [
    { key: 'password', label: 'Password' },
    { key: 'publicKey', label: 'Public key' },
  ];
  expect(securityFieldsForRole(fields, 'reality', 'outbound')).toEqual([
    { key: 'password', label: 'Public key / password' },
  ]);
  expect(securityFieldsForRole(fields, 'reality', 'outbound', { PUBLICKEY: 'fixture' })).toEqual([
    { key: 'publicKey', label: 'Public key / password' },
  ]);
  expect(
    securityFieldsForRole(fields, 'reality', 'outbound', {
      password: 'primary',
      publicKey: 'alias',
    }),
  ).toEqual([{ key: 'password', label: 'Public key / password' }]);
});
