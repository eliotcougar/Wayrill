import { expect, it } from 'vitest';
import { demoConfig } from './demo';
import { applyRoutingOutputs, readRoutingOutputs } from './routingOutputs';
import { remoteView } from './remoteModel';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { emptyLayout, restoreRemoteDocument, saveRemoteDocument } from './remoteDocument';
import { nodeSettings, replaceNodeSettings } from './nodeSettings';
import { createRemoteNode } from './remoteCreation';

it('retains named, reordered and unused routing outputs in the companion without changing Xray', () => {
  const source = JSON.stringify(demoConfig);
  const initial = remoteView(source);
  expect(applyRoutingOutputs(initial, readRoutingOutputs(initial))).toBe(initial);
  const outputs = readRoutingOutputs(initial)
    .reverse()
    .map((output) => ({ ...output, name: `Via ${output.name}` }));
  outputs.push({
    id: 'extra',
    name: 'Europe',
    tag: 'relay-eu',
    group: false,
    fallback: false,
    targetId: 'native-out-2',
  });
  const edited = applyRoutingOutputs(initial, outputs);
  const users = createUserWorkspace(initial.original, emptyLibrary());
  expect(compileRemote(edited, users)).toMatchObject({ config: demoConfig, errors: [] });
  const restored = restoreRemoteDocument(source, saveRemoteDocument(edited, users, emptyLayout()));
  expect(readRoutingOutputs(restored.view)).toEqual(outputs);
  const outbound = nodeSettings(restored.view, 'native-out-2')!.value as Record<string, unknown>;
  const renamed = replaceNodeSettings(restored.view, 'native-out-2', {
    ...outbound,
    tag: 'relay-renamed',
  });
  expect(readRoutingOutputs(renamed).find((output) => output.id === 'extra')).toMatchObject({
    name: 'Europe',
    tag: 'relay-renamed',
  });
  const added = createRemoteNode(renamed, 'outbound:trojan');
  expect(readRoutingOutputs(added.view)).toEqual(readRoutingOutputs(renamed));
  const routing = nodeSettings(initial, 'native-routing')!.value as {
    rules: Record<string, unknown>[];
  };
  const retargeted = replaceNodeSettings(initial, 'native-routing', {
    ...routing,
    rules: routing.rules.map((rule, index) =>
      index === 1 ? { ...rule, outboundTag: 'relay-eu' } : rule,
    ),
  });
  const retained = readRoutingOutputs(retargeted);
  expect(new Set(retained.map((output) => output.id)).size).toBe(retained.length);
  expect(retained.some((output) => output.tag === 'blocked')).toBe(true);
  expect(retained.some((output) => output.tag === 'relay-eu')).toBe(true);
  expect(compileRemote(retargeted, users).errors).toEqual([]);
});

it('keeps outbound and balancer namespaces separate and protects the first-outbound fallback', () => {
  const config = {
    ...demoConfig,
    outbounds: [...demoConfig.outbounds, { tag: 'regional', protocol: 'freedom', settings: {} }],
  };
  const view = remoteView(JSON.stringify(config));
  const outputs = readRoutingOutputs(view);
  const both = applyRoutingOutputs(view, [
    ...outputs,
    { id: 'same-tag', name: 'Regional direct', tag: 'regional', group: false },
  ]);
  const edges = both.graph.edges.filter((edge) => edge.source === 'native-routing');
  expect(edges.find((edge) => edge.sourceHandle === 'same-tag')?.target).toBe('native-out-3');
  expect(
    edges.find((edge) => edge.sourceHandle === outputs.find((output) => output.group)!.id)?.target,
  ).toBe('native-balancer-0');
  expect(() =>
    applyRoutingOutputs(
      view,
      outputs.filter((output) => !output.fallback),
    ),
  ).toThrow('unmatched traffic');
});

it('can name a previously pooled unused outbound without duplicating it or altering the executable config', () => {
  const config = {
    outbounds: Array.from({ length: 300 }, (_, index) => ({
      tag: `direct-${index}`,
      protocol: 'freedom',
      settings: {},
    })),
  };
  const view = remoteView(JSON.stringify(config));
  const edited = applyRoutingOutputs(view, [
    ...readRoutingOutputs(view),
    { id: 'last', name: 'Last', tag: 'direct-299', group: false },
  ]);
  expect(edited.graph.nodes.some((node) => node.id === 'native-out-299')).toBe(true);
  expect(edited.graph.xray?.outboundPool?.some((node) => node.id === 'native-out-299')).toBe(false);
  expect(compileRemote(edited, createUserWorkspace(edited.original, emptyLibrary()))).toMatchObject(
    { config, errors: [] },
  );
});
