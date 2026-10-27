import { expect, it } from 'vitest';
import { factoryResources, selectResource } from './graph/resources';
import {
  geoExpression,
  geoExpressionAtCursor,
  geoSources,
  insertAfterCursorLine,
  parseGeoExpression,
} from './geodata';
it.each([
  ['', 0, 'geosite:google\n', 14],
  ['first\nlast', 2, 'first\ngeosite:google\nlast', 20],
  ['first\nlast', 5, 'first\ngeosite:google\nlast', 20],
  ['first\nlast', 6, 'first\nlast\ngeosite:google\n', 25],
  ['first\n', 6, 'first\ngeosite:google\n', 20],
  ['# 😀\r\nlast', 3, '# 😀\ngeosite:google\nlast', 19],
])('inserts after the cursor line in %j', (value, cursor, expected, caret) => {
  expect(insertAfterCursorLine(value, cursor, 'geosite:google')).toEqual({
    value: expected,
    cursor: caret,
  });
});
it('resolves the cursor resource and preserves external alias spellings', () => {
  const set = selectResource(factoryResources(), 'packaged-ru-geosite', true);
  set.files.push({
    id: 'office',
    name: 'Office.dat',
    kind: 'geosite',
    url: '',
    enabled: false,
    autoUpdate: false,
    intervalHours: 24,
    throughWayrill: false,
  });
  const sources = geoSources(set, 'geosite');
  const text = 'geosite:cn\next-site:Office.dat:GOOGLE@cn@ads\n# keep';
  const current = geoExpressionAtCursor(text, 25, 'geosite');
  expect(current).toBe('ext-site:Office.dat:GOOGLE@cn@ads');
  const selection = parseGeoExpression(current, sources, 'geosite').value!;
  expect(selection).toMatchObject({
    file: 'Office.dat',
    group: 'GOOGLE',
    attributes: ['cn', 'ads'],
  });
  expect(geoExpression(selection)).toBe(current);
  expect(parseGeoExpression('ext:ru-geosite.dat:cn', sources, 'geosite').value?.file).toBe(
    'ru-geosite.dat',
  );
  expect(geoExpressionAtCursor(text, text.length, 'geosite')).toBe(current);
  expect(geoExpressionAtCursor('# keep\ngeosite:cn', 0, 'geosite')).toBe('geosite:cn');
  expect(geoExpressionAtCursor('domain:example.test', 4, 'geosite')).toBe('');
});
it('normalizes requested attributes without treating ! as Boolean absence', () => {
  const result = parseGeoExpression(
    'geosite:google@CN@ads@cn@!CN',
    geoSources(factoryResources(), 'geosite'),
    'geosite',
  );
  expect(result.value?.attributes).toEqual(['cn', 'ads', '!cn']);
  expect(geoExpression(result.value!)).toBe('geosite:google@cn@ads@!cn');
});
it.each([
  ['geoip:!ru', true, 'ru', ''],
  ['!geoip:!RU', false, 'RU', ''],
  ['!!ext-ip:geoip.dat:!cn', true, 'cn', ''],
  ['!192.0.2.0/24', true, '', '192.0.2.0/24'],
  ['::/0', false, '', '::/0'],
])('parses native IP expression %s', (text, inverse, group, cidr) => {
  expect(
    parseGeoExpression(text, geoSources(factoryResources(), 'geoip'), 'geoip').value,
  ).toMatchObject({ inverse, group, cidr });
});
it.each([
  'geosite:google@',
  'geosite:google@@cn',
  '!geosite:google',
  'ext:../secret.dat:google',
  'geoip:cn',
  'geosite:google\nfull:bad',
])('rejects malformed or incompatible site expression %s', (text) => {
  expect(
    parseGeoExpression(text, geoSources(factoryResources(), 'geosite'), 'geosite').error,
  ).toBeTruthy();
});
it('keeps successive insertions ordered and preserves following comments', () => {
  const first = insertAfterCursorLine('domain:a\n# keep\nfull:z', 4, 'geoip:ru');
  const next = insertAfterCursorLine(first.value, first.cursor, 'geoip:cn');
  expect(next.value).toBe('domain:a\ngeoip:ru\ngeoip:cn\n# keep\nfull:z');
});
it('uses the current default and preserves explicit file aliases', () => {
  const set = selectResource(factoryResources(), 'packaged-ru-geosite', true);
  set.files.push({
    id: 'office',
    name: 'Office.dat',
    kind: 'geosite',
    url: '',
    enabled: false,
    autoUpdate: false,
    intervalHours: 24,
    throughWayrill: false,
  });
  expect(geoSources(set, 'geosite')[0]).toMatchObject({
    file: 'ru-geosite.dat',
    prefix: 'geosite:',
    label: 'Default · ru-geosite.dat · RunetFreedom',
  });
  expect(geoSources(set, 'geosite')).toContainEqual({
    file: 'Office.dat',
    label: 'Office.dat · Local file',
    prefix: 'ext:Office.dat:',
  });
  expect(geoSources(set, 'geosite')).toContainEqual({
    file: 'geosite.dat',
    label: 'geosite.dat · XTLS',
    prefix: 'ext:geosite.dat:',
  });
  expect(geoSources(set, 'geoip').some((s) => s.file === 'Office.dat')).toBe(false);
});

it.each([
  ['geosite', 'gfw'],
  ['geoip', 'cn'],
] as const)(
  'resolves the Chinese preset %s source independently of global defaults',
  (kind, group) => {
    const resources = selectResource(factoryResources(), 'packaged-ru-geosite', true);
    const file = `cn-${kind}.dat`;
    const sources = geoSources(resources, kind);
    expect(sources).toContainEqual({
      file,
      label: `${file} · Loyalsoldier`,
      prefix: `ext:${file}:`,
    });
    expect(parseGeoExpression(`ext:${file}:${group}`, sources, kind).value).toMatchObject({
      file,
      group,
    });
  },
);
