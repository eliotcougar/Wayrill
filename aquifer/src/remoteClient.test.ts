import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { nativeClient } from './remoteClient';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));

beforeEach(() => vi.mocked(invoke).mockReset());

it('sends Cancel only for its original native SSH request', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(undefined);
  const controller = new AbortController();
  const connection = nativeClient.discover('server', controller.signal);
  const rejected = expect(connection).rejects.toMatchObject({ name: 'AbortError' });
  const request = vi.mocked(invoke).mock.calls[0]?.[1] as { requestId: string };
  controller.abort();
  expect(invoke).toHaveBeenNthCalledWith(2, 'ssh_cancel', { requestId: request.requestId });

  const next = new AbortController();
  await nativeClient.serverStatus('other', next.signal);
  const second = vi.mocked(invoke).mock.calls[2]?.[1] as { requestId: string };
  expect(second.requestId).not.toBe(request.requestId);
  next.abort();
  expect(invoke).toHaveBeenCalledTimes(3);
  finish(undefined);
  await rejected;
});
