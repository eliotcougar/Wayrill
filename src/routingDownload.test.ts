import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { downloadRoutingRules } from './routingDownload';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: false }));
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    constructor(readonly onmessage: () => void) {}
  },
  invoke: mocks.invoke,
  isTauri: () => mocks.native,
}));
beforeEach(() => {
  mocks.native = false;
  mocks.invoke.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
it.each([false, true])(
  'cancels exactly the native request, admitted first: %s',
  async (admitted) => {
    mocks.native = true;
    const controller = new AbortController();
    mocks.invoke.mockReturnValueOnce(new Promise<string>(() => {})).mockResolvedValue(undefined);
    const result = downloadRoutingRules(
      'https://example.net/list',
      false,
      false,
      controller.signal,
    );
    const [command, { id, ready }] = mocks.invoke.mock.calls[0];
    expect(command).toBe('routing_source_download');
    if (admitted) ready.onmessage();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    if (!admitted) {
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      ready.onmessage();
    }
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith('routing_source_download_cancel', { id });
  },
);
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
