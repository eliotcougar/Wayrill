import { expect, it } from 'vitest';
import { applicationChoices } from './applicationChoices';
import type { WindowsCatalog } from './useWindowsCatalog';
import type { ApplicationSelector } from '../graph/applications';
const catalog: WindowsCatalog = {
  ownerSid: 'fixture',
  interfaces: [],
  processes: [
    { pid: 1, name: 'Client.exe', path: 'C:/Apps/Client.exe' },
    { pid: 2, name: 'Client.exe', path: 'C:/Other/Client.exe' },
    { pid: 3, name: 'Neighbor.exe', path: 'C:/Apps2/Neighbor.exe' },
    { pid: 4, name: 'Secure System', path: null },
    { pid: 5, name: 'Registry.exe', path: null },
    { pid: 6, name: 'Memory Compression.exe', path: null },
    { pid: 7, name: 'Client.exe', path: 'C:/Apps/Client.exe' },
  ],
  packages: [{ family: 'Fixture_123', name: 'Fixture app', publisher: 'Fixture' }],
  services: [{ name: 'FixtureSvc', displayName: 'Fixture service', pid: 100 }],
};
const processRow = (mode: ApplicationSelector['mode'], value: string): ApplicationSelector => ({
  kind: 'process',
  mode,
  value,
  enabled: false,
  children: true,
});
it.each(['name', 'path', 'folder'] as const)(
  'shows full process paths in %s mode and omits pseudo-processes',
  (mode) => {
    const choices = applicationChoices(catalog, [], 'process', mode);
    expect(choices.map((p) => p.detail)).toEqual([
      'C:/Apps/Client.exe',
      'C:/Other/Client.exe',
      'C:/Apps2/Neighbor.exe',
    ]);
    expect(choices.map((p) => p.name)).toEqual(['Client.exe', 'Client.exe', 'Neighbor.exe']);
  },
);
it.each(['name', 'path', 'folder'] as const)(
  'hides an already selected executable across %s mode regardless of children/enabled flags',
  (mode) => {
    const choices = applicationChoices(catalog, [processRow('name', 'CLIENT')], 'process', mode);
    expect(choices.map((p) => p.name)).toEqual(['Neighbor.exe']);
  },
);
it('hides exact paths and selected folders without swallowing a sibling prefix', () => {
  const paths = applicationChoices(
    catalog,
    [processRow('path', 'c:\\apps\\client.exe')],
    'process',
    'name',
  );
  expect(paths.map((p) => p.detail)).toEqual(['C:/Other/Client.exe', 'C:/Apps2/Neighbor.exe']);
  expect(
    applicationChoices(catalog, [processRow('folder', 'C:/Apps/')], 'process', 'folder'),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Neighbor.exe' })]));
  expect(
    applicationChoices(catalog, [processRow('folder', 'C:/Apps/')], 'process', 'folder'),
  ).toHaveLength(2);
});
it.each(['package', 'service'] as const)(
  'hides selected %s entries including disabled ones',
  (kind) => {
    const value = kind === 'package' ? 'fixture_123' : 'fixturesvc';
    expect(
      applicationChoices(
        catalog,
        [{ kind, mode: 'name', value, enabled: false, children: false }],
        kind,
        'name',
      ),
    ).toEqual([]);
  },
);
