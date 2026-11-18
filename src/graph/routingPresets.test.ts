import { expect, it } from 'vitest';
import { makeNode } from './catalog';
import { readDnsFilter } from './dns';
import { readRuleTable, routingRuleVariants } from './rules';
import {
  dnsPresets,
  importDnsPreset,
  importTrafficPreset,
  newPresetOutput,
  trafficPresets,
} from './routingPresets';

it('maps preset traffic to the chosen outputs and preserves earlier rules on append', () => {
  const base = readRuleTable(makeNode('routing-filter', { x: 0, y: 0 }).data.settings);
  const preset = {
    ...trafficPresets[0],
    domainStrategy: 'IPOnDemand',
    defaultOutput: 'direct',
    rules: [
      {
        name: 'Regional exceptions',
        output: 'proxy',
        conditions: { domain: 'ext:example-geosite.dat:regional', ip: '192.0.2.0/24' },
      },
    ],
  };
  const bindings = { direct: base.defaultOutput, proxy: newPresetOutput };
  const replaced = importTrafficPreset(base, preset, bindings, 'replace');
  const [row] = replaced.rules;
  expect(replaced.outputs.some((o) => o.id === row.output && o.id !== base.defaultOutput)).toBe(
    true,
  );
  expect(routingRuleVariants(row)).toEqual([
    { domain: ['ext:example-geosite.dat:regional'] },
    { ip: ['192.0.2.0/24'] },
  ]);
  expect(replaced.defaultOutput).toBe(base.defaultOutput);
  const appended = importTrafficPreset(
    replaced,
    preset,
    { ...bindings, proxy: row.output },
    'append',
  );
  expect(appended.rules.slice(0, -1)).toEqual(replaced.rules);
  expect(appended.rules.at(-1)?.output).toBe(row.output);
  expect(appended.outputs).toEqual(replaced.outputs);
  expect(() => importTrafficPreset(base, preset, {}, 'replace')).toThrow();
  const full = { ...replaced, rules: Array.from({ length: 128 }, () => row) };
  expect(() =>
    importTrafficPreset(full, preset, { ...bindings, proxy: row.output }, 'append'),
  ).toThrow(/128/);
});

it('binds DNS preferences without replacing the existing fallback on append', () => {
  const base = readDnsFilter(makeNode('dns-routing-filter', { x: 0, y: 0 }).data.settings);
  const role = 'regional';
  const preset = {
    ...dnsPresets[0],
    fallbackFirst: true,
    roles: [
      { id: role, name: 'Regional', servers: ['192.0.2.53'] },
      { id: 'fallback', name: 'Fallback', servers: ['192.0.2.54'] },
    ],
    rules: [
      {
        name: 'Regional names',
        output: role,
        domains: 'domain:example.test',
        expectedIPs: '192.0.2.0/24',
        skipFallback: true,
      },
    ],
  };
  const replaced = importDnsPreset(base, preset, { [role]: newPresetOutput }, 'replace');
  const [row] = replaced.rules;
  expect(row).toMatchObject({
    domains: 'domain:example.test',
    expectedIPs: '192.0.2.0/24',
    skipFallback: true,
  });
  expect(replaced.outputs.find((o) => o.id === row.output)?.fallback).toBe(false);
  expect(replaced.outputs.find((o) => o.fallback)).toEqual(base.outputs.find((o) => o.fallback));
  const appended = importDnsPreset(
    replaced,
    { ...preset, fallbackFirst: false },
    { [role]: row.output },
    'append',
  );
  expect(appended.fallbackFirst).toBe(true);
  expect(appended.rules[0]).toEqual(row);
  expect(appended.rules[1].output).toBe(row.output);
  expect(appended.outputs).toEqual(replaced.outputs);
});

it('keeps regional geodata references independent of the active default files', () => {
  for (const preset of [...trafficPresets, ...dnsPresets]) {
    for (const rule of preset.rules) {
      const terms =
        'conditions' in rule ? Object.values(rule.conditions) : [rule.domains, rule.expectedIPs];
      for (const entry of terms.join('\n').split('\n')) {
        if (/^(?:geoip|geosite|ext):/i.test(entry))
          expect(entry, preset.id).toMatch(/^ext:(?!(?:geoip|geosite)\.dat:)[^:]+:.+/i);
      }
    }
  }
});
