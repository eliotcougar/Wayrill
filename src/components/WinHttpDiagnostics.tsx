import { useRef, useState } from 'react';
import { errorText, serviceCall } from '../serviceClient';
import type { CaptureChannel } from '../systemCapture';

export default function WinHttpDiagnostics({
  channel,
  disabled,
}: {
  channel: CaptureChannel;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [report, setReport] = useState(''),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const inspect = async () => {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setReport('');
    setCopied(false);
    try {
      const result = await serviceCall('system.capture.diagnose', { channel });
      if (current === generation.current) setReport(JSON.stringify(result, null, 2));
    } catch (e) {
      if (current === generation.current) setError(errorText(e));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
    } catch {
      setError('Copy is unavailable. Select and copy the diagnostics below.');
    }
  };
  return (
    <div className="capture-diagnostics">
      <div className="action-row runtime-actions">
        <button
          className="secondary-button"
          disabled={disabled || busy}
          onClick={() => void inspect()}
        >
          {busy ? 'Reading diagnostics…' : 'Inspect WinHTTP'}
        </button>
        {!!report && (
          <button className="secondary-button" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy diagnostics'}
          </button>
        )}
      </div>
      {!!error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {!!report && (
        <details className="disclosure" open>
          <summary>WinHTTP diagnostics</summary>
          <p className="field-help">
            Includes proxy addresses and PAC URLs. Review before sharing.
          </p>
          <textarea
            className="text-control code-control"
            aria-label="WinHTTP diagnostics"
            readOnly
            value={report}
            spellCheck={false}
          />
        </details>
      )}
    </div>
  );
}
