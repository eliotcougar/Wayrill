import { expect, it } from 'vitest';
import { factoryResources, selectResource } from './graph/resources';
import {
  geoExpression,
  geoExpressionAtCursor,
  geoSources,
  insertAfterCursorLine,
  parseGeoExpression,
} from './geodata';
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
it('keeps successive insertions ordered and preserves following comments', () => {
  const first = insertAfterCursorLine('domain:a\n# keep\nfull:z', 4, 'geoip:ru');
  const next = insertAfterCursorLine(first.value, first.cursor, 'geoip:cn');
  expect(next.value).toBe('domain:a\ngeoip:ru\ngeoip:cn\n# keep\nfull:z');
});
