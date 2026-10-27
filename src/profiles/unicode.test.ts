import { expect, it } from 'vitest';
import { importProfiles, serializeStash, parseStash } from './import';
import { libraryRows, searchLibrary } from './library';
import { applyStashedProfile } from './graph';
import { createTrafficExample } from '../graph/example';
import { parseGraph, serializeGraph } from '../graph/model';
const names = [
  '🇩🇪telegram➠@v2rayNG_Matsuri',
  '✨ @NamiraConfigs | ❤️ وصل شدی جوین شو | ⚡ | 🇩🇪',
  'اگه میخوای قطع نشی جوین شو : @farsiproxy',
  '𝗝𝗼𝗶𝗻➠@PlanB_net',
  '荷兰',
  '👩🏽‍💻 cafe\u0301 <test> & # %',
];
it.each(names)(
  'preserves the display name through UTF-8 import, search, stash and graph: %s',
  (name) => {
    const uri =
      'vless://00000000-0000-4000-8000-000000000001@unicode.example.net:443?encryption=none&type=raw&security=tls#' +
      encodeURIComponent(name);
    const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(uri)));
    const imported = importProfiles(base64, 'Unicode review').groups;
    const stash = parseStash(
      serializeStash({
        format: 'wayrill.stash',
        version: 3,

        groups: imported,
      }),
    );
    expect(stash.groups[0].entries[0].name).toBe(name);
    expect(searchLibrary(libraryRows(stash.groups), name)).toHaveLength(1);
    const graph = createTrafficExample(),
      previous = graph.nodes.find((n) => n.data.kind === 'vless-outbound')!;
    const next = applyStashedProfile(
      graph,
      stash.groups[0].entries[0],
      { x: 0, y: 0 },
      previous.id,
    );
    const roundTrip = parseGraph(serializeGraph(next));
    expect(roundTrip.nodes.find((n) => n.id === previous.id)!.data.label).toBe(name);
    const links = (g: typeof graph) =>
      g.edges
        .filter((e) => e.target === previous.id)
        .map((e) => [e.id, e.source, e.sourceHandle, e.target, e.targetHandle]);
    expect(links(roundTrip)).toEqual(links(next));
  },
);
it('keeps an overlong imported flag name well formed within the graph limit', () => {
  const label = 'a'.repeat(127) + '🇩🇪';
  const uri =
    'vless://00000000-0000-4000-8000-000000000002@unicode.example.net:443?encryption=none&type=raw&security=tls#' +
    encodeURIComponent(label);
  expect(importProfiles(uri).groups[0].entries[0].name).toBe('a'.repeat(127));
});

it('bounds imported graph and pool labels without changing the original Xray tags', async () => {
  const { importXrayConfig } = await import('../graph/xrayImport');
  const { nativePoolNodes } = await import('../graph/nativePool');
  const { compileXrayGraph } = await import('../graph/xrayCompiler');
  const tag = 'a'.repeat(127) + '🇩🇪';
  const graph = importXrayConfig(
    JSON.stringify({
      inbounds: [{ tag: 'in', protocol: 'socks', listen: '127.0.0.1', port: 1080, settings: {} }],
      outbounds: [{ tag, protocol: 'freedom', settings: {} }],
    }),
    tag,
  );
  expect(graph.name).toBe('a'.repeat(127));
  const output = graph.nodes.find((n) => n.data.settings.tag === tag)!;
  expect(output.data.label).toBe('a'.repeat(127));
  expect(compileXrayGraph(graph).config!.outbounds).toEqual([
    { tag, protocol: 'freedom', settings: {} },
  ]);
  graph.xray!.outboundPool = [
    { id: 'unicode-pool', config: { tag, protocol: 'freedom', settings: {} } },
  ];
  const pool = nativePoolNodes(graph)[0];
  expect(pool.data.label).toBe('a'.repeat(127));
  expect(pool.data.settings.tag).toBe(tag);
});

it('finds decorative Unicode titles with ordinary typed text without rewriting stored names', () => {
  const links = [
    ['𝗝𝗼𝗶𝗻➠@PlanB_net', 'Join➠@PlanB_net'],
    ['Ｆｒｉｅｎｄｌｙ　Ａｐｐ', 'friendly app'],
    ['cafe\u0301', 'café'],
  ];
  for (const [name, query] of links) {
    const stash = importProfiles(
      'vless://public-id@unicode.example.net:443?security=tls#' + encodeURIComponent(name),
    );
    const found = searchLibrary(libraryRows(stash.groups), query);
    expect(found).toHaveLength(1);
    expect(found[0].entry.name).toBe(name);
    expect(libraryRows(stash.groups)[0]).toBe(found[0]);
  }
});
