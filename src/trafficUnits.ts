import { useSyncExternalStore } from 'react';
import { jsonRecord, parseJson } from './graph/xrayJson';
export type RateUnit = 'bits' | 'bytes' | 'binary';
export type AmountUnit = 'bytes' | 'binary';
export interface TrafficUnits {
  rate: RateUnit;
  amount: AmountUnit;
}
export const TRAFFIC_UNITS_KEY = 'wayrill.traffic.units';
export const defaultTrafficUnits: TrafficUnits = { rate: 'binary', amount: 'binary' };
const validRate = (v: unknown): v is RateUnit =>
  typeof v === 'string' && ['bits', 'bytes', 'binary'].includes(v);
const validAmount = (v: unknown): v is AmountUnit =>
  typeof v === 'string' && ['bytes', 'binary'].includes(v);
export function createTrafficUnitsController(target: Window) {
  const parse = (text: string | null): TrafficUnits => {
    try {
      const parsed: unknown = parseJson(text ?? '{}');
      const v = jsonRecord(parsed) ? parsed : {};
      return {
        rate: validRate(v?.rate) ? v.rate : 'binary',
        amount: validAmount(v?.amount) ? v.amount : 'binary',
      };
    } catch {
      return { ...defaultTrafficUnits };
    }
  };
  let units: TrafficUnits = { ...defaultTrafficUnits },
    error = '';
  try {
    units = parse(target.localStorage.getItem(TRAFFIC_UNITS_KEY));
  } catch {
    error = 'Saved traffic units could not be read.';
  }
  let snapshot = { ...units, error };
  const listeners = new Set<() => void>();
  const publish = () => {
    snapshot = { ...units, error };
    listeners.forEach((f) => f());
  };
  const stored = (e: StorageEvent) => {
    if (e.key !== null && e.key !== TRAFFIC_UNITS_KEY) return;
    units = parse(e.key === null ? null : e.newValue);
    error = '';
    publish();
  };
  target.addEventListener('storage', stored);
  return {
    getSnapshot: () => snapshot,
    subscribe: (f: () => void) => {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
    set: (next: Partial<TrafficUnits>) => {
      units = {
        rate: validRate(next.rate) ? next.rate : units.rate,
        amount: validAmount(next.amount) ? next.amount : units.amount,
      };
      try {
        target.localStorage.setItem(TRAFFIC_UNITS_KEY, JSON.stringify(units));
        error = '';
      } catch {
        error = 'Traffic units changed for this session, but could not be saved.';
      }
      publish();
    },
    dispose: () => {
      target.removeEventListener('storage', stored);
      listeners.clear();
    },
  };
}
let controller: ReturnType<typeof createTrafficUnitsController> | undefined;
export function useTrafficUnits() {
  controller ??= createTrafficUnitsController(window);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { ...snapshot, set: controller.set };
}
export function rateScale(value: number, unit: RateUnit) {
  const base = unit === 'binary' ? 1024 : 1000;
  const labels =
    unit === 'binary'
      ? ['KiB/s', 'MiB/s', 'GiB/s', 'TiB/s', 'PiB/s', 'EiB/s', 'ZiB/s', 'YiB/s']
      : unit === 'bits'
        ? ['kbit/s', 'Mbit/s', 'Gbit/s', 'Tbit/s', 'Pbit/s', 'Ebit/s', 'Zbit/s', 'Ybit/s']
        : ['kB/s', 'MB/s', 'GB/s', 'TB/s', 'PB/s', 'EB/s', 'ZB/s', 'YB/s'];
  let divisor = base / (unit === 'bits' ? 8 : 1),
    index = 0;
  while (value >= divisor * base && index < labels.length - 1) {
    divisor *= base;
    index++;
  }
  return { divisor, unit: labels[index] };
}

export function unitDecimals(value: number): number {
  return value > 0 && value < 0.1 ? Math.min(6, Math.max(3, 1 - Math.floor(Math.log10(value)))) : 1;
}
