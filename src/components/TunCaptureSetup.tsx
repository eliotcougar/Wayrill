import { useEffect, useState } from 'react';
import { tunCaptureScope } from '../graph/tun';
import { desktopServiceAvailable, errorText, serviceCall } from '../serviceClient';
export default function TunCaptureSetup({
  settings,
  onChange,
}: {
  settings: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
}) {
  const [adapters, setAdapters] = useState<{ name: string; active: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!desktopServiceAvailable()) return;
    let current = true;
    setBusy(true);
    setProblem('');
    void serviceCall<{ name: string; active: boolean }[]>('tun.interfaces').then(
      (adapters) => {
        if (current) {
          setAdapters(adapters);
          setBusy(false);
        }
      },
      (error: unknown) => {
        if (current) {
          setProblem(errorText(error));
          setBusy(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [refresh]);
  const ipv6 =
    Array.isArray(settings.autoSystemRoutingTable) &&
    settings.autoSystemRoutingTable.some((s) => typeof s === 'string' && s.includes(':'));
  const uplink =
    typeof settings.autoOutboundsInterface === 'string' ? settings.autoOutboundsInterface : 'auto';
  return (
    <section className="tun-capture-setup" aria-label="Windows TUN setup">
      <div className="action-row field-action-row">
        <button
          type="button"
          className="secondary-button"
          onClick={() => onChange(tunCaptureScope(settings, true))}
        >
          Capture this PC · IPv4 + IPv6
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => onChange(tunCaptureScope(settings, false))}
        >
          Capture IPv4 only
        </button>
      </div>
      <p className="field-message">
        Apply activates the adapter; Stop disables it when adapter reuse is enabled. Connect DNS to
        a DNS handler for split DNS. Without that connection, DNS follows Traffic.
      </p>
      {!ipv6 && <p className="field-message warning">IPv6 is outside this capture scope.</p>}
      <div className="form-row field-action-row">
        <label className="editor-field">
          <span>Uplink</span>
          <select
            aria-label="TUN uplink"
            value={uplink || 'auto'}
            onChange={(e) => onChange({ ...settings, autoOutboundsInterface: e.target.value })}
          >
            <option value="auto">Automatic · current Windows route</option>
            {uplink && uplink !== 'auto' && !adapters.some((a) => a.name === uplink) && (
              <option value={uplink}>{uplink}</option>
            )}
            {adapters.map((a) => (
              <option key={a.name} value={a.name} disabled={!a.active}>
                {a.name}
                {a.active ? '' : ' · inactive'}
              </option>
            ))}
          </select>
        </label>
        {desktopServiceAvailable() && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {busy ? 'Refreshing…' : 'Refresh adapters'}
          </button>
        )}
      </div>
      {problem && (
        <p className="field-message error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
