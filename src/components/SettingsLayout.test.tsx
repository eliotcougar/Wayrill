// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GlobalDefaultsEditor from './GlobalDefaultsEditor';
import ProtocolEditor from './ProtocolEditor';
import NativeDnsEditor from './NativeDnsEditor';
import DnsEditor from './DnsEditor';
import { createPolicyExample } from '../graph/policyExample';
import { createDnsExample } from '../graph/example';
import { importXrayConfig } from '../graph/xrayImport';
import { compileXrayGraph } from '../graph/xrayCompiler';
import { makeNode } from '../graph/catalog';
import { DiagnosticFocusContext } from './DiagnosticNavigation';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === name,
  )!;
const input = async (el: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
const closedAdvanced = (el: Element | null) => {
  const details = el?.closest<HTMLDetailsElement>('.settings-advanced');
  expect(details).not.toBeNull();
  expect(details!.open).toBe(false);
  return details!;
};
it('search reveals advanced defaults and closing them retains an invalid draft', async () => {
  const graph = createPolicyExample(),
    apply = vi.fn();
  graph.defaults!.settings.inboundUserLevel = 2;
  await act(() =>
    root.render(<GlobalDefaultsEditor graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  const policy = host.querySelector<HTMLInputElement>('#setting-global-inboundUserLevel')!,
    section = closedAdvanced(policy);
  expect(host.querySelector('#setting-global-sniffing')!.closest('.settings-advanced')).toBeNull();
  await act(() => section.querySelector('summary')!.click());
  await input(policy, '1.5');
  await act(() => section.querySelector('summary')!.click());
  expect(section.open).toBe(false);
  expect(button('Save defaults').disabled).toBe(true);
  expect(policy.value).toBe('1.5');
  const search = host.querySelector<HTMLInputElement>('[aria-label="Search global defaults"]')!;
  await input(search, 'Input policy level');
  expect(section.open).toBe(true);
  expect(policy.value).toBe('1.5');
  await input(policy, '0');
  await act(() => button('Save defaults').click());
  expect(apply.mock.calls[0][0].settings.inboundUserLevel).toBe(0);
});
it('a diagnostic opens and focuses an advanced control on initial load', async () => {
  await act(() =>
    root.render(
      <DiagnosticFocusContext.Provider
        value={{
          surface: 'defaults',
          issue: {
            severity: 'error',
            message: 'test',
            scope: 'defaults',
            fieldKey: 'muxConcurrency',
          },
        }}
      >
        <GlobalDefaultsEditor graph={createPolicyExample()} onApply={vi.fn()} onClose={vi.fn()} />
      </DiagnosticFocusContext.Provider>,
    ),
  );
  const field = host.querySelector<HTMLInputElement>('#setting-global-muxConcurrency')!;
  expect(field.closest<HTMLDetailsElement>('details')!.open).toBe(true);
  expect(document.activeElement).toBe(field);
});
it('keeps active legacy credentials Basic while preserving configured advanced values on Apply', async () => {
  const original = {
    outbounds: [
      {
        tag: 'out',
        protocol: 'trojan',
        settings: {
          servers: [{ address: 'public.example', port: 443, password: 'fixture', level: 0 }],
        },
        streamSettings: {
          network: 'ws',
          security: 'tls',
          wsSettings: { path: '/public', headers: { Host: 'public.example' }, heartbeatPeriod: 17 },
          tlsSettings: { serverName: 'public.example', enableSessionResumption: false },
          sockopt: { tcpKeepAliveIdle: 0 },
        },
        mux: { enabled: false },
      },
    ],
  };
  const graph = importXrayConfig(JSON.stringify(original)),
    node = graph.nodes.find((n) => n.data.kind === 'trojan-outbound')!;
  await act(() =>
    root.render(
      <ProtocolEditor
        node={node}
        defaults={graph.defaults}
        onApply={(_, patch) => {
          node.data = { ...node.data, ...patch };
        }}
        onClose={vi.fn()}
      />,
    ),
  );
  const password = host.querySelector('#protocol-settings-servers-0-password')!;
  expect(password.closest('.settings-advanced')).toBeNull();
  closedAdvanced(host.querySelector('#protocol-settings-servers-0-level'));
  await act(() => button('Transport & security').click());
  expect(host.querySelector('#protocol-transport-path')!.closest('.settings-advanced')).toBeNull();
  const session = closedAdvanced(host.querySelector('#protocol-security-enableSessionResumption'));
  expect(session.querySelector('summary')!.textContent).toContain('1 configured');
  await act(() => session.querySelector('summary')!.click());
  await act(() => session.querySelector('summary')!.click());
  await act(() => button('Apply protocol settings').click());
  expect(compileXrayGraph(graph).config).toEqual(original);
});
it('puts authored DNS timing/cache under Advanced and retains ordinary resolver choices', async () => {
  const graph = createDnsExample(),
    node = graph.nodes.find((n) => n.data.kind === 'dns-servers')!;
  await act(() =>
    root.render(<DnsEditor node={node} graph={graph} onApply={vi.fn()} onClose={vi.fn()} />),
  );
  expect(
    host.querySelector('[aria-label="Server address family"]')!.closest('.settings-advanced'),
  ).toBeNull();
  closedAdvanced(host.querySelector('[aria-label="Timeout (ms)"]'));
  closedAdvanced(host.querySelector('[aria-label="Server EDNS client IP"]'));
});
it('reveals unfinished native DNS input in a collapsed group without changing the native draft', async () => {
  const graph = createPolicyExample(),
    node = makeNode('xray-dns', { x: 0, y: 0 }),
    apply = vi.fn();
  node.data.settings.json = JSON.stringify({
    servers: ['1.1.1.1'],
    serveExpiredTTL: 0,
    disableCache: false,
  });
  graph.nodes.push(node);
  await act(() =>
    root.render(<NativeDnsEditor node={node} graph={graph} onApply={apply} onClose={vi.fn()} />),
  );
  const field = host.querySelector<HTMLInputElement>('#native-dns-serveExpiredTTL')!;
  // The editor prefix is a stable implementation contract; do not guess the field in production UI.
  expect(field).not.toBeNull();
  const section = closedAdvanced(field);
  await act(() => section.querySelector('summary')!.click());
  await input(field, '1.5');
  await act(() => section.querySelector('summary')!.click());
  expect(host.querySelector<HTMLButtonElement>('.primary-button')!.disabled).toBe(true);
  const review = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes('Invalid value'),
  )!;
  expect(review).not.toBeNull();
  await act(() => review.click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(section.open).toBe(true);
  expect(field.value).toBe('1.5');
  expect(document.activeElement).toBe(field);
  expect(JSON.parse(String(node.data.settings.json))).toEqual({
    servers: ['1.1.1.1'],
    serveExpiredTTL: 0,
    disableCache: false,
  });
  expect(apply).not.toHaveBeenCalled();
});

it('edits the authoritative stream method instead of an ignored network field', async () => {
  const original = {
    outbounds: [
      {
        tag: 'out',
        protocol: 'trojan',
        settings: { address: 'public.example', port: 443, password: 'fixture' },
        streamSettings: { method: 'ws', network: 'raw', wsSettings: { path: '/public' } },
      },
    ],
  };
  const graph = importXrayConfig(JSON.stringify(original)),
    node = graph.nodes.find((n) => n.data.kind === 'trojan-outbound')!;
  await act(() =>
    root.render(
      <ProtocolEditor
        node={node}
        defaults={graph.defaults}
        onApply={(_, patch) => {
          node.data = { ...node.data, ...patch };
        }}
        onClose={vi.fn()}
      />,
    ),
  );
  await act(() => button('Transport & security').click());
  const transport = host.querySelector<HTMLSelectElement>('#protocol-stream-method')!;
  expect(transport.value).toBe('ws');
  expect(host.querySelector('#protocol-stream-network')).toBeNull();
  expect(compileXrayGraph(graph).config).toEqual(original);
  await act(() => {
    transport.value = 'xhttp';
    transport.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(() => button('Apply protocol settings').click());
  expect(compileXrayGraph(graph).config).toEqual({
    outbounds: [
      {
        ...original.outbounds[0],
        streamSettings: { ...original.outbounds[0].streamSettings, method: 'xhttp' },
      },
    ],
  });
});
