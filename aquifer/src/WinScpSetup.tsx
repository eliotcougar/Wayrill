import { useEffect, useRef } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type { SessionInventory } from './remoteClient';

export default function WinScpSetup({
  inventory,
  busy,
  available,
  error,
  onClose,
  onChoose,
  onConfig,
  onReset,
}: {
  inventory: SessionInventory | null;
  busy: boolean;
  available: boolean;
  error: string;
  onClose: () => void;
  onChoose: (kind: 'executable' | 'ini') => void;
  onConfig: (config: string) => void;
  onReset: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="workspace-dialog winscp-setup-dialog"
      aria-label="WinSCP setup"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="user-dialog-header">
        <h2>WinSCP setup</h2>
        <button className="icon-button" aria-label="Close WinSCP setup" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="workspace-dialog-body">
        <fieldset className="settings-unboxed" disabled={busy || !available}>
          <label>WinSCP executable</label>
          <div className="field-with-button">
            <input
              readOnly
              aria-label="Detected WinSCP executable"
              value={inventory?.executable ?? 'Not found'}
              title={inventory?.executable ?? undefined}
            />
            <button aria-label="Locate WinSCP" onClick={() => onChoose('executable')}>
              <FolderOpen size={15} />
              Browse…
            </button>
          </div>
          {inventory?.executableVersion && (
            <p className="muted">WinSCP {inventory.executableVersion}</p>
          )}
          <label htmlFor="session-storage">Session storage</label>
          <div className="field-with-button">
            <select
              id="session-storage"
              value={inventory?.selectedConfig ?? 'auto'}
              onChange={(event) => onConfig(event.target.value)}
            >
              <option value="auto">Automatic</option>
              {inventory?.configs.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              aria-label="Choose WinSCP INI file"
              title="Choose WinSCP INI file"
              onClick={() => onChoose('ini')}
            >
              <FolderOpen size={17} />
            </button>
          </div>
          <button className="setup-reset" onClick={onReset}>
            Reset detection
          </button>
        </fieldset>
        {inventory && (
          <dl className="setup-source">
            <div>
              <dt>Current source</dt>
              <dd>{inventory.source}</dd>
            </div>
            {inventory.windowsUser && (
              <div>
                <dt>Windows account</dt>
                <dd>{inventory.windowsUser}</dd>
              </div>
            )}
          </dl>
        )}
        {inventory?.warnings.map((warning) => (
          <p className="setup-warning" key={warning}>
            {warning}
          </p>
        ))}
        {!available && (
          <p className="muted">WinSCP connections are available in the desktop app.</p>
        )}
        {(error || inventory?.compatibilityError) && (
          <p className="user-error" role="alert">
            {error || inventory?.compatibilityError}
          </p>
        )}
      </div>
      <footer className="user-dialog-footer">
        <span className="muted">Connection settings apply immediately.</span>
        <button onClick={onClose}>Close</button>
      </footer>
    </dialog>
  );
}
