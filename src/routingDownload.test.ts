import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { downloadRoutingRules, routingUrl } from './routingDownload';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: false, serviceCall: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => mocks.native }));
vi.mock('./serviceClient', () => ({ serviceCall: mocks.serviceCall }));
beforeEach(() => {
  mocks.native = false;
  mocks.invoke.mockReset();
  mocks.serviceCall.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
it.each([
  'file:///C:/private',
  'https://user:pass@example.net/list',
  'https://example.net/#fragment',
  'http://example.net/list',
  'not a URL',
])('rejects unsupported URLs without echoing credentials: %s', (url) => {
  expect(() => routingUrl(url, false)).toThrow();
});
it('allows explicit HTTP and HTTPS query strings', () => {
  expect(routingUrl('http://127.0.0.1/list', true)).toBe('http://127.0.0.1/list');
  expect(routingUrl('https://example.net/list?token=secret', false)).toBe(
    'https://example.net/list?token=secret',
  );
});
it('native download uses the routing-specific unelevated command without activation', async () => {
  mocks.native = true;
  mocks.invoke.mockResolvedValue('[]');
  expect(
    await downloadRoutingRules(
      'https://example.net/list',
      false,
      false,
      new AbortController().signal,
    ),
  ).toBe('[]');
  expect(mocks.invoke).toHaveBeenCalledWith('routing_source_download', {
    url: 'https://example.net/list',
    allowHttp: false,
    proxyPort: null,
  });
  expect(mocks.serviceCall).not.toHaveBeenCalled();
});
it('does not accept a stale native download after cancellation', async () => {
  mocks.native = true;
  const controller = new AbortController();
  mocks.invoke.mockImplementation(() => {
    controller.abort();
    return Promise.resolve('[]');
  });
  await expect(
    downloadRoutingRules('https://example.net/list', false, false, controller.signal),
  ).rejects.toThrow();
});
it('refuses a stopped runtime before attempting a download through Wayrill', async () => {
  mocks.native = true;
  mocks.serviceCall
    .mockResolvedValueOnce({ core: { state: 'stopped' }, config: { revision: 1 } })
    .mockResolvedValueOnce({ revision: 1, config: null });
  await expect(
    downloadRoutingRules('https://example.net/list', false, true, new AbortController().signal),
  ).rejects.toThrow('Start Wayrill');
  expect(mocks.invoke).not.toHaveBeenCalled();
});
it('browser fetch omits credentials, disallows redirects and decodes UTF-8', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('[{"Remarks":"🦊"}]', { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  expect(await downloadRoutingRules('https://example.net/list', false, false, signal)).toContain(
    '🦊',
  );
  expect(fetcher).toHaveBeenCalledWith('https://example.net/list', {
    signal,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
});
it('does not parse error pages or invalid UTF-8 as routing rules', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('error', { status: 404 }))
    .mockResolvedValueOnce(new Response(new Uint8Array([255])));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    downloadRoutingRules('https://example.net/list', false, false, new AbortController().signal),
  ).rejects.toThrow('404');
  await expect(
    downloadRoutingRules('https://example.net/list', false, false, new AbortController().signal),
  ).rejects.toThrow('UTF-8');
});

it('explains browser CORS/network failures without echoing the URL', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(
    downloadRoutingRules(
      'https://example.net/list?token=secret',
      false,
      false,
      new AbortController().signal,
    ),
  ).rejects.toThrow('Browser previews');
});
