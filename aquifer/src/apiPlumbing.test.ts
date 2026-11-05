import { expect, it } from 'vitest';
import { demoConfig } from './demo';
import { remoteView } from './remoteModel';
import { apiPlumbing, withoutApiPlumbing } from './apiPlumbing';
import { nodeSettings, replaceNodeSettings } from './nodeSettings';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { get, objectAt, setProperty } from './nativeProperties';

it('conceals dedicated API plumbing without removing it from the executable graph or export', () => {
  const view = remoteView(JSON.stringify(demoConfig)),
    visible = withoutApiPlumbing(view);
  expect(visible.nodes.some((node) => node.id === 'remote-api' || node.id === 'native-in-1')).toBe(
    false,
  );
  expect(
    visible.edges.some((edge) => edge.target === 'remote-api' || edge.source === 'native-in-1'),
  ).toBe(false);
  const ports = visible.nodes.find((node) => node.id === 'native-routing')!.data.outputs;
  expect(ports.some((port) => port.label === 'api')).toBe(false);
  expect(visible.nodes.find((node) => node.id === 'native-routing')!.data.rules).toHaveLength(3);
  expect(view.graph.nodes.some((node) => node.id === 'remote-api')).toBe(true);
  const output = compileRemote(view, createUserWorkspace(view.original, emptyLibrary()));
  expect(output.errors).toEqual([]);
  expect(output.config).toEqual(demoConfig);
  const graphOnly = compileRemote(
    { ...view, original: {} },
    createUserWorkspace(view.original, emptyLibrary()),
  );
  expect(graphOnly.config).toEqual(demoConfig);
});
it('keeps a listener with separate explicit traffic rules visible', () => {
  const config = structuredClone(demoConfig);
  config.routing.rules.push({
    type: 'field',
    inboundTag: ['local-admin'],
    outboundTag: 'direct',
  } as any);
  const view = remoteView(JSON.stringify(config));
  expect(apiPlumbing(config).inboundIndices.size).toBe(0);
  expect(withoutApiPlumbing(view).nodes.some((node) => node.id === 'native-in-1')).toBe(true);
});
it('edits ordinary routing rules while retaining the API rule in its original position', () => {
  const view = remoteView(JSON.stringify(demoConfig));
  const editor = nodeSettings(view, 'native-routing')!;
  expect(get(editor.value as Record<string, unknown>, 'rules')).toHaveLength(3);
  expect(replaceNodeSettings(view, 'native-routing', editor.value)).toBe(view);
  const next = replaceNodeSettings(view, 'native-routing', {
    ...(editor.value as object),
    domainStrategy: 'AsIs',
  });
  expect(get(objectAt(next.original, 'routing'), 'rules')).toEqual(demoConfig.routing.rules);
});
it('edits a dedicated API listener through Core settings without changing unrelated inbound definitions', () => {
  const view = remoteView(JSON.stringify(demoConfig)),
    editor = nodeSettings(view, 'native-options')!;
  const listeners = editor.apiListeners!.map((item) => ({
    ...item,
    value: setProperty(item.value, 'port', 11085),
  }));
  const next = replaceNodeSettings(view, 'native-options', editor.value, listeners);
  expect(next.original).toEqual({
    ...demoConfig,
    inbounds: [demoConfig.inbounds[0], { ...demoConfig.inbounds[1], port: 11085 }],
  });
});
it('turns off API and removes only its dedicated listeners and managed routes', () => {
  const view = remoteView(JSON.stringify(demoConfig)),
    editor = nodeSettings(view, 'native-options')!;
  const next = replaceNodeSettings(
    view,
    'native-options',
    setProperty(editor.value as Record<string, unknown>, 'api', undefined),
    editor.apiListeners,
  );
  expect(get(next.original, 'api')).toBeUndefined();
  expect(next.original.inbounds).toEqual([demoConfig.inbounds[0]]);
  expect(get(objectAt(next.original, 'routing'), 'rules')).toEqual(
    demoConfig.routing.rules.slice(1),
  );
});
it('does not invent routing settings when editing an ordinary configuration', () => {
  const config = { inbounds: [demoConfig.inbounds[0]], outbounds: demoConfig.outbounds };
  const view = remoteView(JSON.stringify(config)),
    editor = nodeSettings(view, 'native-options')!;
  const next = replaceNodeSettings(
    view,
    'native-options',
    { ...(editor.value as object), log: { loglevel: 'error' } },
    [],
  );
  expect(next.original).toEqual({ ...config, log: { loglevel: 'error' } });
});

it('retains concealed API routes when the editable routing object omits ordinary rules', () => {
  const view = remoteView(JSON.stringify(demoConfig));
  const next = replaceNodeSettings(view, 'native-routing', { domainStrategy: 'AsIs' });
  expect(get(objectAt(next.original, 'routing'), 'rules')).toEqual([demoConfig.routing.rules[0]]);
  expect(apiPlumbing(next.original).inboundIndices.size).toBe(1);
  expect(compileRemote(next, createUserWorkspace(next.original, emptyLibrary())).errors).toEqual(
    [],
  );
});
