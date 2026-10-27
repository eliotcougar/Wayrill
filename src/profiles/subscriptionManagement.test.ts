import { expect, it, vi } from 'vitest';
import { importProfiles } from './import';
import { refreshSubscriptionGroups, subscriptionUrlKey } from './subscriptionManagement';

const group = (id: string) => ({
  ...importProfiles('socks://test.example:1080#Test').groups[0],
  id,
  name: id,
  url: `https://${id}.example/sub`,
});
it('refreshes sequentially, continues after failure, includes manually refreshed paused groups and skips absent sources', async () => {
  const a = group('a'),
    b = group('b'),
    manual = { ...group('manual'), url: '' },
    paused = { ...group('paused'), maintenancePaused: true };
  const groups = new Map([a, b, manual, paused].map((value) => [value.id, value]));
  const progress = vi.fn();
  let concurrent = 0,
    maximum = 0;
  const refresh = vi.fn(async (value: typeof a) => {
    maximum = Math.max(maximum, ++concurrent);
    try {
      if (value.id === 'a')
        groups.set('b', { ...b, name: 'Changed B', url: 'https://new.example/sub' });
      if (value.id === 'b') {
        expect(value.name).toBe('Changed B');
        throw new Error('Provider unavailable');
      }
      await Promise.resolve();
    } finally {
      concurrent--;
    }
  });
  const result = await refreshSubscriptionGroups(
    ['a', 'b', 'manual', 'paused', 'removed'],
    (id) => groups.get(id),
    refresh,
    new AbortController().signal,
    progress,
  );
  expect(maximum).toBe(1);
  expect(refresh.mock.calls.map(([value]) => value.id)).toEqual(['a', 'b', 'paused']);
  expect(result).toMatchObject({
    completed: 5,
    total: 5,
    updated: ['a', 'paused'],
    skipped: 2,
    failed: [{ id: 'b', name: 'Changed B', message: 'Provider unavailable' }],
  });
  expect(progress.mock.calls.at(-1)?.[0].active).toBe('');
});
it('does not advance a cancelled queue or publish late completion of its native request', async () => {
  const groups = [group('a'), group('b'), group('c')];
  const controller = new AbortController();
  let finish!: () => void;
  const progress = vi.fn();
  const refresh = vi.fn(async (value: (typeof groups)[number]) => {
    if (value.id === 'b')
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
  });
  const result = refreshSubscriptionGroups(
    groups.map((value) => value.id),
    (id) => groups.find((value) => value.id === id),
    refresh,
    controller.signal,
    progress,
  );
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  controller.abort();
  finish();
  await expect(result).rejects.toThrow();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
    completed: 1,
    updated: ['a'],
    active: 'b',
  });
});
it('rejects an already cancelled batch before resolving any source', async () => {
  const controller = new AbortController();
  controller.abort();
  const resolve = vi.fn();
  await expect(
    refreshSubscriptionGroups(['a'], resolve, vi.fn(), controller.signal, vi.fn()),
  ).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
});
it('compares equivalent URL authorities without changing case-sensitive subscription tokens', () => {
  expect(subscriptionUrlKey(' HTTPS://EXAMPLE.NET:443/sub?token=ABC ')).toBe(
    subscriptionUrlKey('https://example.net/sub?token=ABC'),
  );
  expect(subscriptionUrlKey('https://example.net/sub?token=ABC')).not.toBe(
    subscriptionUrlKey('https://example.net/sub?token=abc'),
  );
});
