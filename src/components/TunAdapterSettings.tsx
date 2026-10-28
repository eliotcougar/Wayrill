import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Trash2, X } from 'lucide-react';
import useModalDialog from './useModalDialog';
import { errorText, serviceCall } from '../serviceClient';
import type { RuntimeController } from '../useRuntime';

type Adapter = {
  kind: 'host' | 'ics';
  id: string;
  name: string;
  state: 'running' | 'disabled' | 'enabled' | 'missing' | 'conflict';
  error: string | null;
  canRemove: boolean;
};
type Inventory = {
  reuseAdapters: boolean;
  adapters: Adapter[];
  recoveryPending: boolean;
};
const states: Record<Adapter['state'], string> = {
  running: 'Running',
  disabled: 'Disabled',
  enabled: 'Enabled',
  missing: 'Removed from Windows',
  conflict: 'Needs attention',
};

export default function TunAdapterSettings({
  runtime,
  onClose,
}: {
  runtime: RuntimeController;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(dialog);
  const [inventory, setInventory] = useState<Inventory>();
  const [reuse, setReuse] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<Adapter>();
  const [generation, setGeneration] = useState(0);
  const refresh = () => setGeneration((value) => value + 1);
  const supported =
    runtime.desktop && runtime.connected && runtime.capabilities.includes('windows.tun.adapters');
  const blocked = runtime.busy || loading;
  const retired =
    (runtime.snapshot?.core.state === 'stopped' || runtime.snapshot?.core.state === 'failed') &&
    !runtime.snapshot.core.pid;
  const canManage = supported && retired && !blocked;
  const canChange =
    canManage &&
    runtime.snapshot?.tun?.state !== 'running' &&
    !!inventory &&
    !inventory.recoveryPending;
  useEffect(() => {
    setLoading(supported);
    setError('');
    setInventory(undefined);
    setRemoving(undefined);
    if (!supported) return;
    let active = true;
    void serviceCall<Inventory>('tun.adapters.get')
      .then((value) => {
        if (!active) return;
        setInventory(value);
        setReuse(value.reuseAdapters);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    supported,
    runtime.snapshot?.instanceId,
    runtime.snapshot?.core.state,
    runtime.snapshot?.tun?.state,
    generation,
  ]);
  const apply = async () => {
    setError('');
    try {
      await runtime.run('tun.adapters.set', { reuseAdapters: reuse });
      refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const remove = async () => {
    if (!removing) return;
    setError('');
    try {
      await runtime.run('tun.adapters.remove', {
        kind: removing.kind,
        expectedId: removing.id,
      });
      refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <dialog
      ref={dialog}
      className="app-dialog"
      aria-labelledby="tun-adapters-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="dialog-header">
        <h2 id="tun-adapters-title">TUN adapters</h2>
        <button className="icon-button" aria-label="Close TUN adapter settings" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="dialog-body">
        <label className="editor-field">
          <span>Adapter management</span>
          <select
            value={reuse ? 'keep' : 'disposable'}
            disabled={!canChange}
            onChange={(event) => setReuse(event.target.value === 'keep')}
          >
            <option value="keep">Keep and reuse</option>
            <option value="disposable">Disposable</option>
          </select>
        </label>
        <p className="field-help">
          {reuse
            ? 'Adapters are disabled when routing stops and re-enabled on the next start.'
            : 'Used adapters are removed when routing stops. Remove unused kept adapters below.'}
        </p>
        {!supported && (
          <p role="status">Connect to the installed Windows service to manage adapters.</p>
        )}
        {supported && !retired && (
          <p role="status">Stop routing to change adapter management or remove adapters.</p>
        )}
        {retired && inventory?.recoveryPending && (
          <p role="status">Finish Internet sharing recovery before removing the shared adapter.</p>
        )}
        <div className="section-heading tun-adapter-heading">
          <h3>Installed adapters</h3>
          <button
            className="icon-button"
            aria-label="Refresh TUN adapters"
            disabled={!supported || blocked}
            onClick={refresh}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        {loading && <p role="status">Loading adapters…</p>}
        {inventory && inventory.adapters.length === 0 && <p>No retained adapters.</p>}
        {inventory?.adapters.map((adapter) => (
          <div className="tun-adapter-row" key={adapter.id}>
            <div>
              <strong>{adapter.name}</strong>
              <span className="field-help">
                {adapter.kind === 'ics' ? 'ICS TUN' : 'Host TUN'} · {states[adapter.state]}
              </span>
              {adapter.error && <p className="notice notice--error">{adapter.error}</p>}
            </div>
            <button
              className="icon-button"
              aria-label={`Remove ${adapter.name}`}
              disabled={!canManage || !adapter.canRemove}
              onClick={() => setRemoving(adapter)}
            >
              <Trash2 size={17} />
            </button>
          </div>
        ))}
        {removing && (
          <div className="notice notice--warning" role="group" aria-label="Confirm adapter removal">
            <p>Remove {removing.name} from Windows?</p>
            <p className="field-help">Starting TUN again creates an adapter.</p>
            <div className="action-row">
              <button
                className="secondary-button"
                disabled={blocked}
                onClick={() => setRemoving(undefined)}
              >
                Cancel
              </button>
              <button
                className="secondary-button tun-adapter-remove"
                disabled={!canManage || !removing.canRemove}
                onClick={() => void remove()}
              >
                Remove adapter
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-footer">
        <button className="secondary-button" onClick={onClose}>
          Close
        </button>
        <button
          className="primary-button"
          disabled={!canChange || reuse === inventory?.reuseAdapters}
          onClick={() => void apply()}
        >
          Apply
        </button>
      </div>
    </dialog>
  );
}
