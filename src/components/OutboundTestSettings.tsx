import { useState, useRef } from 'react';
import useModalDialog from './useModalDialog';
import type { OutboundTests } from '../useOutboundTests';
import { defaultTestSettings } from '../outboundTestSettings';
import {
  testUrlSuggestions,
  countryUrlSuggestions,
  speedUrlSuggestions,
  udpUrlSuggestions,
} from '../testUrlSuggestions';
import { X } from 'lucide-react';
import EditableSelect from './EditableSelect';
export default function OutboundTestSettings({
  settings,
  onClose,
}: {
  settings: OutboundTests['settings'];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(dialog);
  const [draft, setDraft] = useState({ ...settings.value }),
    [error, setError] = useState('');
  return (
    <dialog
      ref={dialog}
      className="app-dialog"
      aria-labelledby="test-settings-title"
      onClose={onClose}
    >
      <div className="dialog-header">
        <h2 id="test-settings-title">Outbound tests</h2>
        <button className="icon-button" aria-label="Close outbound test settings" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            settings.save(draft);
            onClose();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        <div className="dialog-body">
          <div className="editor-field">
            <label htmlFor="outbound-test-url">Latency test URL</label>
            <EditableSelect
              id="outbound-test-url"
              label="Latency test URL"
              options={testUrlSuggestions}
              type="url"
              required
              value={draft.testUrl}
              onChange={(testUrl) => setDraft({ ...draft, testUrl })}
            />
          </div>
          <label className="editor-checkbox">
            <input
              type="checkbox"
              checked={draft.udpEnabled}
              onChange={(e) => setDraft({ ...draft, udpEnabled: e.target.checked })}
            />
            Test UDP with delay tests
          </label>
          <div className="editor-field">
            <label htmlFor="outbound-udp-url">UDP test destination</label>
            <EditableSelect
              id="outbound-udp-url"
              label="UDP test destination"
              options={udpUrlSuggestions}
              value={draft.udpUrl}
              required={draft.udpEnabled}
              disabled={!draft.udpEnabled}
              onChange={(udpUrl) => setDraft({ ...draft, udpUrl })}
            />
            <p className="field-help">
              STUN checks UDP connectivity. DNS checks UDP to that resolver only.
            </p>
          </div>
          <div className="editor-field">
            <label htmlFor="outbound-country-url">Country / exit IP URL</label>
            <EditableSelect
              id="outbound-country-url"
              label="Country / exit IP URL"
              options={countryUrlSuggestions}
              type="url"
              value={draft.countryUrl}
              placeholder="Disabled when blank"
              onChange={(countryUrl) => setDraft({ ...draft, countryUrl })}
            />
          </div>
          <div className="editor-field">
            <label htmlFor="outbound-speed-url">Speed test URL</label>
            <EditableSelect
              id="outbound-speed-url"
              label="Speed test URL"
              options={speedUrlSuggestions}
              type="url"
              required
              value={draft.speedUrl}
              onChange={(speedUrl) => setDraft({ ...draft, speedUrl })}
            />
          </div>
          <p className="field-help">
            Speed tests download for up to 5 seconds or 256 MiB per route. Use a download file URL.
          </p>
          {error && (
            <p role="alert" className="runtime-error">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            className="secondary-button"
            onClick={() => setDraft({ ...defaultTestSettings })}
          >
            Reset defaults
          </button>
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button">
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
