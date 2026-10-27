import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import useModalDialog from './useModalDialog';
import { errorText } from '../serviceClient';
import type { RuntimeController } from '../useRuntime';

export default function StartupSettings({
  runtime,
  onClose,
}: {
  runtime: RuntimeController;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(dialog);
  const saved = runtime.snapshot?.startup;
  const [enabled, setEnabled] = useState(saved?.enabled ?? false);
  const [error, setError] = useState('');
  useEffect(() => setEnabled(saved?.enabled ?? false), [saved?.enabled]);
  const supported =
    runtime.desktop && runtime.connected && runtime.capabilities.includes('service.startup');
  const needsConfig = enabled && !runtime.snapshot?.config.present;
  const canApply = supported && !runtime.busy && !needsConfig && enabled !== saved?.enabled;
  const close = () => onClose();
  const apply = async () => {
    setError('');
    try {
      await runtime.run('startup.set', {
        enabled,
        expectedRevision: runtime.snapshot!.config.revision,
      });
    } catch (error) {
      setError(errorText(error));
    }
  };
  return (
    <dialog
      ref={dialog}
      className="app-dialog"
      aria-labelledby="startup-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClose={close}
    >
      <div className="dialog-header">
        <h2 id="startup-title">Startup</h2>
        <button className="icon-button" aria-label="Close startup settings" onClick={close}>
          <X size={18} />
        </button>
      </div>
      <div className="dialog-body">
        <label className="editor-check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!supported || runtime.busy}
            onChange={(event) => {
              setEnabled(event.target.checked);
              setError('');
            }}
          />
          Start routing at boot before sign-in
        </label>
        <p>
          Start the applied configuration when Windows boots. Stop cancels recovery for the current
          Windows session; this option starts a new run at the next boot.
        </p>
        <p className="field-help">
          Before sign-in, Xray uses restricted LocalService. Changes take effect on the next start.
          Configuration files must be accessible to that account.
        </p>
        {runtime.snapshot?.config.present && (
          <p className="field-help">
            Applied revision: {runtime.snapshot.config.revision}. Unsaved graph changes are not
            used.
          </p>
        )}
        {needsConfig && <p role="status">Apply a working configuration first.</p>}
        {!supported && (
          <p role="status">
            {runtime.desktop
              ? 'Connect to the current Wayrill service to change startup.'
              : 'Startup is available in the installed Windows app.'}
          </p>
        )}
        {saved?.waitingForNetwork && (
          <p role="status">Waiting for Windows networking. Retrying automatically…</p>
        )}
        {saved?.lastError && (
          <p className="runtime-error" role="status">
            Last automatic start: {saved.lastError.message}
          </p>
        )}
        {error && (
          <p className="runtime-error" role="alert">
            {error}
          </p>
        )}
        {saved?.enabled && (
          <p className="field-help">
            With this off, routing that was stopped stays stopped after reboot. A running setup
            still recovers automatically; Xray may wait for the installation owner's Windows
            session.
          </p>
        )}
      </div>
      <div className="dialog-footer">
        <button className="secondary-button" onClick={close}>
          Close
        </button>
        <button className="primary-button" disabled={!canApply} onClick={() => void apply()}>
          {runtime.busy ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </dialog>
  );
}
