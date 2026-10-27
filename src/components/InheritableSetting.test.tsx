// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { getDefinition, makeNode } from '../graph/catalog';
import {
  factoryDefaults,
  overrideSetting,
  resetNodeDefaults,
  resolveNodeData,
  resetCoreDefault,
} from '../graph/defaults';
import InheritableSetting from './InheritableSetting';
import { importXrayConfig } from '../graph/xrayImport';
import { xrayOutboundConfig } from '../graph/xrayCompiler';
import type { GlobalDefaults, RuleNodeData } from '../graph/types';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
function Field({
  initial,
  defaults,
  fieldKey = 'tcpKeepAliveIdle',
}: {
  initial: RuleNodeData;
  defaults: GlobalDefaults;
  fieldKey?: string;
}) {
  const [data, setData] = useState(initial),
    resolved = resolveNodeData(data, defaults),
    field = getDefinition(data.kind).fields.find((f) => f.key === fieldKey)!;
  return (
    <InheritableSetting
      field={field}
      data={resolved}
      defaults={defaults}
      preparedRoot={xrayOutboundConfig(resolved)}
      value={resolved.settings[fieldKey]}
      issues={[]}
      onReset={() => setData(resetNodeDefaults(data, defaults, fieldKey))}
      onOverride={() =>
        setData({
          ...resolved,
          ...overrideSetting(resolved, fieldKey, resolved.settings[fieldKey]),
        })
      }
      onChange={(v) => setData({ ...resolved, ...overrideSetting(resolved, fieldKey, v) })}
    />
  );
}
const button = (name: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
it('shows the imported omission, correct hint, and reset target without displaying encoded zero', async () => {
  const defaults = factoryDefaults();
  defaults.settings.tcpKeepAliveIdle = 30;
  const graph = importXrayConfig(
      JSON.stringify({ outbounds: [{ tag: 'out', protocol: 'freedom', settings: {} }] }),
    ),
    data = graph.nodes.find((n) => n.data.kind === 'direct-outbound')!.data;
  await act(() => root.render(<Field initial={data} defaults={defaults} />));
  const input = host.querySelector<HTMLInputElement>('input')!;
  expect(input.value).toBe('');
  expect(input.placeholder).toBe('45 seconds for outbound TCP');
  expect(host.textContent).toContain('Imported omission');
  expect(host.textContent).toContain('Use default → App default · 30');
  const descriptions = input
    .getAttribute('aria-describedby')!
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ');
  expect(descriptions).toContain('Absent from JSON');
  expect(descriptions).toContain('App default · 30');
  await act(() => button('Use default for TCP keepalive idle (seconds)').click());
  expect(host.textContent).toContain('App default');
  expect(input.value).toBe('');
  expect(input.placeholder).toBe('30');
  expect(button('Override TCP keepalive idle (seconds)')).toBeTruthy();
});
it('freezes the current inherited value and follows new app defaults only after reset', async () => {
  const defaults = factoryDefaults();
  defaults.settings.tcpKeepAliveIdle = 30;
  const data = resolveNodeData(makeNode('vless-outbound', { x: 0, y: 0 }).data, defaults);
  const show = (d: GlobalDefaults) => act(() => root.render(<Field initial={data} defaults={d} />));
  await show(defaults);
  await act(() => button('Override TCP keepalive idle (seconds)').click());
  expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('30');
  expect(host.textContent).toContain('Overridden');
  await show({ ...defaults, settings: { ...defaults.settings, tcpKeepAliveIdle: 60 } });
  expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('30');
  expect(host.textContent).toContain('Use default → App default · 60');
  await act(() => button('Use default for TCP keepalive idle (seconds)').click());
  expect(host.querySelector<HTMLInputElement>('input')!.placeholder).toBe('60');
});
it('shows the zero-sentinel behavior for an explicit zero without making it inherited', async () => {
  const defaults = factoryDefaults();
  let data = makeNode('vless-outbound', { x: 0, y: 0 }).data;
  data = { ...data, ...overrideSetting(data, 'tcpKeepAliveIdle', 0) };
  await act(() => root.render(<Field initial={data} defaults={defaults} />));
  expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('0');
  expect(host.textContent).toContain('Overridden');
  expect(host.textContent).toContain('Effective · 0 → 45 seconds for outbound TCP');
  expect(host.querySelector('input')!.getAttribute('aria-describedby')).toContain('-effective');
});
it('keeps explicit false distinct from the inherited disabled state', async () => {
  const defaults = factoryDefaults(),
    initial = makeNode('vless-outbound', { x: 0, y: 0 }).data;
  await act(() =>
    root.render(<Field initial={initial} defaults={defaults} fieldKey="muxEnabled" />),
  );
  expect(host.querySelector('select')!.value).toBe('__wayrill_inherit__');
  await act(() => button('Override Enable multiplexing').click());
  expect(host.querySelector('select')!.value).toBe('false');
  expect(host.textContent).toContain('Overridden');
  await act(() => button('Use default for Enable multiplexing').click());
  expect(host.querySelector('select')!.value).toBe('__wayrill_inherit__');
});
it('labels an absent app setting as Xray inheritance', async () => {
  const defaults = resetCoreDefault(factoryDefaults(), 'tcpKeepAliveIdle'),
    data = resolveNodeData(makeNode('vless-outbound', { x: 0, y: 0 }).data, defaults);
  await act(() => root.render(<Field initial={data} defaults={defaults} />));
  expect(host.querySelector('.inherited-badge')!.textContent).toBe('Xray default');
});
it('names the actual app reset target in the dropdown while a blank override uses the core fallback', async () => {
  const defaults = factoryDefaults();
  defaults.settings.fingerprint = 'firefox';
  let data = makeNode('vless-outbound', { x: 0, y: 0 }).data;
  data = { ...data, ...overrideSetting(data, 'fingerprint', 'chrome') };
  await act(() => root.render(<Field initial={data} defaults={defaults} fieldKey="fingerprint" />));
  expect(host.querySelector('option[value="__wayrill_inherit__"]')!.textContent).toBe(
    'Default: firefox',
  );
  expect(host.querySelector('option[value=""]')!.textContent).toBe('Xray default');
  await act(() => {
    const select = host.querySelector('select')!;
    select.value = '__wayrill_inherit__';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.textContent).toContain('App default · firefox');
});
