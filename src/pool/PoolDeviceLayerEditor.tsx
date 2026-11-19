import { useState } from 'react';
import AppProtectionSettings from '../components/AppProtectionSettings';
import Dialog from '../components/Dialog';
import LoopbackPackageList from '../components/LoopbackPackageList';
import { useWindowsCatalog } from '../components/useWindowsCatalog';
import { errorText } from '../serviceClient';
import { packageFamily, readDeviceLayer, type DeviceLayerData } from './deviceLayers';

export default function PoolDeviceLayerEditor({
  initial,
  name,
  busy,
  failure,
  onSave,
  onClose,
}: {
  initial: DeviceLayerData;
  name: string;
  busy: boolean;
  failure: string;
  onSave: (data: DeviceLayerData) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState(initial);
  const [family, setFamily] = useState('');
  const [error, setError] = useState('');
  const { catalog } = useWindowsCatalog(data.kind === 'loopback');
  function addPackage(input = family) {
    if (data.kind !== 'loopback') return;
    const value = input.trim();
    if (!packageFamily(value) || data.packages.length >= 256) {
      setError('Enter an exact Windows package family name. A layer can have up to 256 packages.');
      return;
    }
    if (!data.packages.some((entry) => entry.toLowerCase() === value.toLowerCase()))
      setData({ ...data, packages: [...data.packages, value] });
    setFamily('');
    setError('');
  }
  return (
    <Dialog
      title={name}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="secondary-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => {
              try {
                setError('');
                onSave(readDeviceLayer(data));
              } catch (failure) {
                setError(errorText(failure));
              }
            }}
          >
            Save layer
          </button>
        </>
      }
    >
      {data.kind === 'loopback' ? (
        <fieldset className="capture-settings-fields" disabled={busy}>
          <label className="editor-field">
            <span>Package family name</span>
            <input
              value={family}
              onChange={(event) => setFamily(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && family.trim()) {
                  event.preventDefault();
                  addPackage();
                }
              }}
              placeholder="Microsoft.WindowsStore_8wekyb3d8bbwe"
            />
          </label>
          <button
            className="secondary-button"
            disabled={!family.trim()}
            onClick={() => addPackage()}
          >
            Add package
          </button>
          {!!catalog?.packages.length && (
            <label className="editor-field">
              <span>Installed packages</span>
              <select
                value=""
                onChange={(event) => {
                  if (event.currentTarget.value) addPackage(event.currentTarget.value);
                }}
              >
                <option value="">Choose from this PC…</option>
                {catalog.packages.map(({ family, name }) => (
                  <option key={family} value={family}>
                    {name} ({family})
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="field-help">
            An exemption allows an installed Windows package to access local services. The package
            can be absent on this PC. Uncheck a package below to remove it from the layer.
          </p>
          {!!data.packages.length && (
            <LoopbackPackageList
              rows={data.packages.map((entry) => ({ name: entry, family: entry, enabled: true }))}
              onChange={(entry) =>
                setData({ ...data, packages: data.packages.filter((item) => item !== entry) })
              }
            />
          )}
        </fieldset>
      ) : (
        <fieldset disabled={busy}>
          <AppProtectionSettings
            layer={{
              config: data.protection,
              onChange: (protection) => setData({ ...data, protection }),
            }}
          />
        </fieldset>
      )}
      {(error || failure) && (
        <p className="notice notice--error" role="alert">
          {error || failure}
        </p>
      )}
    </Dialog>
  );
}
