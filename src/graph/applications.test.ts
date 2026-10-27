import { expect, it } from 'vitest';
import {
  compatible,
  nativeProcessSelectors,
  processProfiles,
  processMaskPattern,
  parseApplicationSelectors,
} from './applications';
import { compileCaptureRouting, defaultCaptureOptions } from './capture';
import { makeNode } from './catalog';
import { intersectPredicates } from './routingPaths';
import type { GraphState } from './types';
const rows = (names: string[]) => nativeProcessSelectors(names);
it('keeps large disjoint process sets linear while retaining OR and every compatible mask', () => {
  const sets = Array.from({ length: 128 }, (_, i) => rows([`app${i}.exe`]));
  expect(processProfiles(sets)).toHaveLength(129);
  expect(processProfiles([rows(['a.exe', 'b.exe']), rows(['b.exe', 'c.exe'])])).toEqual([
    '0',
    '1',
    '3',
    '2',
  ]);
  expect(() =>
    processProfiles(
      Array.from({ length: 13 }, () => [{ ...rows(['launcher.exe'])[0], children: true }]),
    ),
  ).toThrow(/4,096/);
});
it('uses boundary-aware folder compatibility and case-insensitive executable normalization', () => {
  expect(compatible(rows(['C:/apps/'])[0], rows(['C:/apps-other/a.exe'])[0])).toBe(false);
  expect(compatible(rows(['C:/apps/'])[0], rows(['C:/apps/a.exe'])[0])).toBe(true);
  expect(compatible(rows(['APP.exe'])[0], rows(['C:/tools/app.exe'])[0])).toBe(true);
});
it('represents AND across chained application rows and tests arbitrary mask bits', () => {
  expect(
    intersectPredicates({ _wayrillApplications: ['a'] }, { _wayrillApplications: ['b'] }),
  ).toEqual({ _wayrillApplications: ['a', 'b'] });
  const expression = new RegExp(processMaskPattern([0, 5], 8).slice(7));
  for (let mask = 0; mask < 256; mask++)
    expect(expression.test(`wr-${mask.toString(16).padStart(2, '0')}-${'a'.repeat(48)}`)).toBe(
      (mask & 33) === 33,
    );
});
it('preserves rule order and remaining predicates on authenticated capture paths', () => {
  const capture = makeNode('windivert-inbound', { x: 0, y: 0 }, 'capture');
  const graph: GraphState = {
    name: 'Bridge',
    nodes: [capture],
    edges: [],
    captureOptions: defaultCaptureOptions(),
  };
  const config = {
    inbounds: [{ tag: 'captured-traffic' }, { tag: 'ordinary' }],
    routing: {
      rules: [
        { process: ['a.exe'], domain: ['full:blocked.example'], port: '443', outboundTag: 'block' },
        { process: ['a.exe'], outboundTag: 'direct' },
        { outboundTag: 'fallback' },
      ],
    },
  };
  const plan = compileCaptureRouting(graph, config)!;
  expect(plan.inputs[0].predicates).toHaveLength(1);
  expect(plan.inputs[0].masks).toEqual(['0', '1']);
  expect(config.routing.rules.map((r) => r.outboundTag)).toEqual([
    'block',
    'block',
    'direct',
    'direct',
    'fallback',
  ]);
  expect(config.routing.rules[1]).toMatchObject({
    domain: ['full:blocked.example'],
    port: '443',
    inboundTag: ['captured-traffic'],
    user: [processMaskPattern([0], 1)],
  });
  expect(config.routing.rules[0]).toMatchObject({ process: ['a.exe'], inboundTag: ['ordinary'] });
});
it('rejects invalid selector paths and enhanced application conditions outside capture', () => {
  expect(() =>
    parseApplicationSelectors([{ ...rows(['a.exe'])[0], mode: 'path', value: 'C:relative.exe' }]),
  ).toThrow(/absolute/);
  const graph: GraphState = { name: 'None', nodes: [], edges: [] };
  expect(() =>
    compileCaptureRouting(graph, { routing: { rules: [{ _wayrillApplications: ['[]'] }] } }),
  ).toThrow(/WinDivert/);
});

const unavailableIdentity = (kind: 'service' | 'package') => ({
  kind,
  value: kind === 'service' ? 'PrivateService' : 'PrivateApp_family',
  mode: 'name' as const,
  children: false,
  enabled: true,
});
function captureBridge(rules: Record<string, unknown>[]) {
  const graph: GraphState = {
    name: 'Capture bridge',
    nodes: [makeNode('windivert-inbound', { x: 0, y: 0 }, 'capture')],
    edges: [],
  };
  const config = {
    inbounds: [{ tag: 'captured-traffic' }, { tag: 'ordinary' }],
    routing: { rules },
  };
  const plan = compileCaptureRouting(graph, config)!;
  return { rules: config.routing.rules, plan };
}
it.each(['service', 'package'] as const)(
  'never broadens a required Windows identity (%s) on ordinary inputs',
  (kind) => {
    const result = captureBridge([
      {
        _wayrillApplications: [JSON.stringify([unavailableIdentity(kind)])],
        domain: ['full:private.example'],
        port: '443',
        outboundTag: 'direct',
      },
      { outboundTag: 'proxy' },
    ]);
    const direct = result.rules.filter((rule) => rule.outboundTag === 'direct');
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({
      inboundTag: ['captured-traffic'],
      user: [processMaskPattern([0], 1)],
      port: '443',
      domain: ['full:private.example'],
    });
    expect(result.rules.at(-1)).toEqual({ outboundTag: 'proxy' });
  },
);
it('does not erase an unsupported group from chained AND application predicates', () => {
  const result = captureBridge([
    {
      _wayrillApplications: [
        JSON.stringify(rows(['browser.exe'])),
        JSON.stringify([unavailableIdentity('service')]),
      ],
      port: '443',
      outboundTag: 'direct',
    },
  ]);
  expect(result.rules).toHaveLength(1);
  expect(result.rules[0]).toMatchObject({ inboundTag: ['captured-traffic'] });
});
it('retains representable process alternatives inside a mixed identity group', () => {
  const result = captureBridge([
    {
      _wayrillApplications: [
        JSON.stringify([...rows(['browser.exe']), unavailableIdentity('package')]),
      ],
      domain: ['full:private.example'],
      outboundTag: 'proxy',
    },
  ]);
  expect(result.rules).toHaveLength(2);
  expect(result.rules[0]).toMatchObject({
    inboundTag: ['ordinary'],
    process: ['browser.exe'],
    domain: ['full:private.example'],
  });
});
