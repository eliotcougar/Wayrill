import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, FolderOpen, Plug, RefreshCw, Unplug } from 'lucide-react';
import Dialog from './Dialog';
import { errorText } from '../serviceClient';
import {
  companionStatus,
  desktopCompanionAvailable,
  openCompanion,
  registerCompanion,
  unregisterCompanion,
  type CompanionStatus,
} from '../companionClient';
import './CompanionSettings.css';

export default function CompanionSettings({ onClose }: { onClose: () => void }) {
  const desktop = desktopCompanionAvailable();
  const [status, setStatus] = useState<CompanionStatus>();
  const [browser, setBrowser] = useState('');
  const [legacyId, setLegacyId] = useState('');
  const [busy, setBusy] = useState(desktop);
  const pending = useRef(desktop);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const accept = useCallback((value: CompanionStatus) => {
    setStatus(value);
    setBrowser((current) =>
      value.browsers.some((item) => item.id === current)
        ? current
        : (value.browsers.find((item) => item.installed)?.id ?? value.browsers[0]?.id ?? ''),
    );
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void companionStatus()
      .then((value) => {
        if (active) accept(value);
      })
      .catch((problem) => {
        if (active) setError(errorText(problem));
      })
      .finally(() => {
        if (active) {
          pending.current = false;
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [desktop, accept]);

  const perform = async (operation: () => Promise<CompanionStatus | void>) => {
    if (!desktop || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const next = await operation();
      if (next) accept(next);
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const blocked = !desktop || busy;
  const available = !!status?.available;
  const selected = status?.browsers.find((item) => item.id === browser);
  const customId = legacyId.trim();
  const validCustomId = /^[a-p]{32}$/.test(customId);
  const hasCustomCopies = status?.origins.some((id) => id !== status.extensionId);

  return (
    <Dialog title="Browser Companion" onClose={onClose} className="companion-settings">
      <div className="companion-settings-content" aria-busy={busy}>
        {!desktop && (
          <p className="notice" role="status">
            Companion setup is available in the installed Windows app.
          </p>
        )}
        <section className="companion-section" aria-labelledby="companion-bridge-heading">
          <div className="section-heading">
            <h3 id="companion-bridge-heading">Native bridge</h3>
            <button
              className="icon-button"
              aria-label="Refresh Companion status"
              disabled={blocked}
              onClick={() => void perform(companionStatus)}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <p role="status" className="companion-bridge-state">
            {busy && !status
              ? 'Loading Companion…'
              : status
                ? `Bridge ${status.registered ? 'registered' : 'not registered'} · Companion ${status.version}`
                : 'Bridge status unavailable'}
          </p>
          <p className="field-help">
            The bridge is shared by Chromium browsers. Disconnecting affects all of them.
          </p>
          <div className="action-row">
            <button
              className="primary-button"
              disabled={blocked || !available}
              onClick={() => void perform(() => registerCompanion())}
            >
              <Plug size={16} />
              {hasCustomCopies
                ? 'Use bundled copy'
                : status?.registered
                  ? 'Repair bridge'
                  : 'Enable bridge'}
            </button>
            <button
              className="secondary-button button--danger"
              disabled={blocked}
              onClick={() => void perform(unregisterCompanion)}
            >
              <Unplug size={16} />
              Disconnect all browsers
            </button>
          </div>
          {hasCustomCopies && (
            <p className="field-help">
              Use bundled copy resets authorizations for older and custom copies.
            </p>
          )}
          {status && !available && (
            <p className="notice" role="status">
              Companion files are missing. Reinstall Wayrill to enable the bridge.
            </p>
          )}
          {!!status?.issues.length && (
            <ul className="notice companion-issues" aria-label="Companion setup issues">
              {status.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="companion-section" aria-labelledby="companion-browser-heading">
          <h3 id="companion-browser-heading">Load the extension</h3>
          <div className="form-row">
            <label className="editor-field">
              <span>Browser</span>
              <select
                value={browser}
                disabled={blocked || !status?.browsers.length}
                onChange={(event) => setBrowser(event.target.value)}
              >
                {!status?.browsers.length && <option value="">No supported browser found</option>}
                {status?.browsers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.installed ? '' : ' (not found)'}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-button"
              disabled={blocked || !selected?.installed}
              onClick={() => void perform(() => openCompanion('browser', browser))}
            >
              <ExternalLink size={16} />
              Open extensions
            </button>
          </div>
          <ol className="companion-steps">
            <li>In the browser, enable Developer mode and choose Load unpacked.</li>
            <li>Select the bundled extension folder. Remove older Companion copies there.</li>
          </ol>
          <div className="form-row">
            <label className="editor-field">
              <span>Extension folder</span>
              <input
                value={status?.extensionPath ?? ''}
                readOnly
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <button
              className="icon-button"
              aria-label="Copy extension folder"
              disabled={blocked || !status?.extensionPath}
              onClick={() =>
                void perform(async () => {
                  await navigator.clipboard.writeText(status!.extensionPath);
                  setMessage('Extension folder copied.');
                })
              }
            >
              <Copy size={16} />
            </button>
            <button
              className="secondary-button"
              disabled={blocked || !available}
              onClick={() => void perform(() => openCompanion('folder'))}
            >
              <FolderOpen size={16} />
              Open folder
            </button>
          </div>
          <p className="field-help">
            Remove an extension through its browser’s extensions manager.
          </p>
        </section>

        <details className="editor-advanced settings-advanced">
          <summary>Older or custom copy</summary>
          <p className="field-help">Paste the ID of an already loaded copy to authorize it.</p>
          <div className="form-row">
            <label className="editor-field">
              <span>Extension ID</span>
              <input
                value={legacyId}
                disabled={blocked}
                maxLength={64}
                spellCheck={false}
                autoCapitalize="none"
                onChange={(event) => setLegacyId(event.target.value)}
              />
            </label>
            <button
              className="secondary-button"
              disabled={blocked || !available || !validCustomId}
              onClick={() => void perform(() => registerCompanion(customId))}
            >
              Connect copy
            </button>
          </div>
          <p className="field-help">Use the 32-letter ID shown on the browser’s extensions page.</p>
          {!!status?.origins.length && (
            <div>
              <h4>Authorized extension IDs</h4>
              <ul className="companion-origins">
                {status.origins.map((id) => (
                  <li key={id}>
                    <code>{id}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </details>
        {message && <p role="status">{message}</p>}
        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
