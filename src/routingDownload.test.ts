import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { downloadRoutingRules } from './routingDownload';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: false, serviceCall: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => mocks.native }));
vi.mock('./serviceClient', () => ({ serviceCall: mocks.serviceCall }));
beforeEach(() => {
  mocks.native = false;
  mocks.invoke.mockReset();
  mocks.serviceCall.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
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
