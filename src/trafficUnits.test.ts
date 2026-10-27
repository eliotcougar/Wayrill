// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createTrafficUnitsController, TRAFFIC_UNITS_KEY } from './trafficUnits';
import { formatBytes, formatRate } from './traffic';
import { trafficScale } from './trafficPresentation';
it('converts decimal bits/bytes and binary bytes without losing exact totals', () => {
  expect(formatRate(1, 'binary')).toBe('0.00098 KiB/s');
  expect(formatRate(125000, 'bits')).toBe('1.0 Mbit/s');
  expect(formatRate(1000000, 'bytes')).toBe('1.0 MB/s');
  expect(formatRate(1048576, 'binary')).toBe('1.0 MiB/s');
  expect(formatBytes('1000000', 'bytes')).toBe('1.0 MB');
  expect(formatBytes('1048576', 'binary')).toBe('1.0 MiB');
  expect(formatBytes('0', 'bytes')).toBe('0.0 kB');
  expect(formatBytes('999950', 'bytes')).toBe('1000.0 kB');
  expect(formatBytes('340282366920938463463374607431768211455', 'bytes')).not.toMatch(
    /NaN|Infinity/,
  );
  for (const unit of ['bits', 'bytes', 'binary'] as const) {
    expect(formatRate(null, unit)).toBe('—');
    expect(formatRate(Infinity, unit)).toBe('—');
  }
  const point = {
    sampleId: 1,
    timestampMs: 1,
    elapsedMs: 1,
    uploadPerSecond: 125000,
    downloadPerSecond: 0,
  };
  const scale = trafficScale([point], 'bits');
  expect(scale.unit).toBe('Mbit/s');
  expect(scale.label(125000)).toBe('1.0');
});
it('persists independent presentation preferences and syncs other windows', () => {
  localStorage.clear();
  const c = createTrafficUnitsController(window),
    listener = vi.fn();
  const off = c.subscribe(listener);
  c.set({ rate: 'bits' });
  c.set({ amount: 'bytes' });
  expect(c.getSnapshot()).toEqual({ rate: 'bits', amount: 'bytes', error: '' });
  expect(JSON.parse(localStorage.getItem(TRAFFIC_UNITS_KEY)!)).toEqual({
    rate: 'bits',
    amount: 'bytes',
  });
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: TRAFFIC_UNITS_KEY,
      newValue: '{"rate":"bytes","amount":"binary"}',
    }),
  );
  expect(c.getSnapshot().rate).toBe('bytes');
  expect(listener).toHaveBeenCalledTimes(3);
  off();
  c.dispose();
  localStorage.clear();
});
it('keeps session units usable when preference storage fails', () => {
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('denied');
  });
  const c = createTrafficUnitsController(window);
  c.set({ rate: 'bits' });
  expect(c.getSnapshot().rate).toBe('bits');
  expect(c.getSnapshot().error).toContain('could not be saved');
  c.dispose();
  spy.mockRestore();
});

it('rejects malformed saved unit types and keeps valid independent preferences', () => {
  for (const [stored, rate, amount] of [
    [{ rate: ['bits'], amount: ['bytes'] }, 'binary', 'binary'],
    [{ rate: null, amount: 1 }, 'binary', 'binary'],
    [{ rate: 'bits', amount: true }, 'bits', 'binary'],
    [{ rate: 'unknown', amount: 'bytes' }, 'binary', 'bytes'],
  ] as const) {
    localStorage.setItem(TRAFFIC_UNITS_KEY, JSON.stringify(stored));
    const c = createTrafficUnitsController(window);
    expect(c.getSnapshot()).toEqual({ rate, amount, error: '' });
    c.dispose();
  }
  localStorage.clear();
});
