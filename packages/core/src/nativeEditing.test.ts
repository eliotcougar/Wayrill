import { expect, it } from 'vitest';
import { createNativeFieldEditor, dnsServerFields } from './nativeFields';
import { createProtocolFields } from './protocolFields';
import { parseXrayJson } from './xrayJson';
import { getNativePath, putNativePath, setNative } from './nativeProperties';
import { dnsAddressProblem, ipProblem } from './addressValidation';

it('edits an existing native alias without losing unknown fields or changing the source', () => {
  const editor = createNativeFieldEditor((text) => parseXrayJson(text, undefined, 512));
  const original = { ExpectedIPs: [], ExpectIPs: ['geoip:private'], extension: { enabled: true } };
  const field = dnsServerFields.find((item) => item.key === 'expectedIPs')!;
  expect(editor.editNativeField(original, field, 'ext-ip:extra.dat:local')).toEqual({
    ExpectIPs: ['ext-ip:extra.dat:local'],
    extension: { enabled: true },
  });
  expect(original.ExpectedIPs).toEqual([]);
  expect(original.ExpectIPs).toEqual(['geoip:private']);
  expect(editor.editNativeField(original, field, '').ExpectIPs).toBeUndefined();
});

it('uses the owning app parser and rejects oversized or ambiguous JSON before changing a field', () => {
  const editor = createNativeFieldEditor((text) => parseXrayJson(text, undefined, 48));
  const field = {
    key: 'headers',
    label: 'Headers',
    type: 'json' as const,
    jsonShape: 'object' as const,
  };
  const original = { headers: { keep: 'me' } };
  expect(() => editor.editNativeField(original, field, '{"x":"' + 'a'.repeat(50) + '"}')).toThrow(
    'at most',
  );
  expect(() => editor.editNativeField(original, field, '{"x":1,"x":2}')).toThrow();
  expect(original).toEqual({ headers: { keep: 'me' } });
});

it('keeps independently pinned protocol schemas separate, including nested validation', () => {
  const legacy = createProtocolFields({
    Root: { fields: [{ key: 'peers', goType: '[]Peer' }] },
    Peer: { fields: [{ key: 'port', goType: 'uint16' }] },
  });
  const newer = createProtocolFields({
    Root: { fields: [{ key: 'peers', goType: '[]Peer' }] },
    Peer: { fields: [{ key: 'port', goType: 'string' }] },
  });
  const value = { peers: [{ port: '443' }], futureOption: true };
  expect(legacy.structureProblems('Root', value)).toEqual([
    'settings.peers[0].port must be an integer from 0 to 65535.',
  ]);
  expect(newer.structureProblems('Root', value)).toEqual([]);
  expect(legacy.structureProblems('Root', { peers: [{ port: 65536 }] })).toHaveLength(1);
  expect(newer.fieldsForStructure('Peer')[0].type).toBe('text');
});

it('updates native wildcard paths without flattening endpoints or changing unrelated properties', () => {
  const original = {
    Settings: {
      Servers: [{ users: [{ level: 1 }, { level: 2 }], unknown: true }, { users: [{ level: 3 }] }],
    },
  };
  const path = ['settings', 'servers', '*', 'users', '*', 'level'];
  expect(getNativePath(original, path)).toBe(1);
  const updated = putNativePath(original, path, 5, true);
  expect(getNativePath(updated, ['settings', 'servers', '1', 'users', '0', 'level'])).toBe(5);
  expect(original.Settings.Servers[0].users[0].level).toBe(1);
  expect(updated.Settings).toBeDefined();
  expect(() => setNative({ tag: 'one', Tag: 'two' }, 'tag', 'new')).toThrow('competing');
});

it('accepts Xray resource expressions while rejecting malformed literal IPs and resolver URLs', () => {
  for (const entry of ['!geoip:private', 'ext-ip:extra.dat:local', '2001:db8::/64'])
    expect(ipProblem(entry)).toBe(false);
  for (const entry of ['01.2.3.4', '1.2.3.4/33', '2001:db8::/129', '1.2.3.4/8/'])
    expect(ipProblem(entry)).toBe(true);
  expect(dnsAddressProblem('https://resolver.example/dns-query')).toBeNull();
  expect(dnsAddressProblem('tcp://resolver.example/not-a-dns-path')).toBeTruthy();
});
