import { useTrafficUnits, type RateUnit, type AmountUnit } from '../trafficUnits';
export default function TrafficUnitSettings() {
  const units = useTrafficUnits();
  return (
    <fieldset className="traffic-unit-settings">
      <legend>Traffic units</legend>
      <label>
        Data rate
        <select
          aria-label="Data rate units"
          value={units.rate}
          onChange={(e) => units.set({ rate: e.target.value as RateUnit })}
        >
          <option value="bits">Kilobits per second (kbit/s, Mbit/s…)</option>
          <option value="bytes">Kilobytes per second (kB/s, MB/s…)</option>
          <option value="binary">Kibibytes per second (KiB/s, MiB/s…)</option>
        </select>
      </label>
      <label>
        Data amount
        <select
          aria-label="Data amount units"
          value={units.amount}
          onChange={(e) => units.set({ amount: e.target.value as AmountUnit })}
        >
          <option value="bytes">Kilobytes (kB, MB…)</option>
          <option value="binary">Kibibytes (KiB, MiB…)</option>
        </select>
      </label>
      {units.error && <p role="alert">{units.error}</p>}
    </fieldset>
  );
}
