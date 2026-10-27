import { useEffect, useRef, useState } from 'react';
import { Pencil, Plus, RefreshCw, ToggleLeft, ToggleRight, Trash2, Upload } from 'lucide-react';
import Dialog from './Dialog';
import EditableSelect from './EditableSelect';
import ResourceWarnings from './ResourceWarnings';
import { formatBytes } from '../traffic';
import {
  desktopServiceAvailable,
  errorText,
  serviceCall,
  type ResourceWarningReport,
} from '../serviceClient';
import {
  parseResources,
  resourceFiles,
  resourceFilename,
  resourceProviders,
  resourceSourceName,
  selectResource,
  type ResourceFile,
  type ResourceKind,
  type ResourceSet,
} from '../graph/resources';

type ResourceStatus = {
  busy: boolean;
  skippedSelectorCount?: number;
  skippedSelectors?: ResourceWarningReport['skippedSelectors'];
  restartRequired?: boolean;
  reloadPending?: boolean;
  reloadError?: { message: string; retryable?: boolean } | null;
  files: {
    file: string;
    id?: string;
    present: boolean;
    updatedAtMs?: number;
    bytes?: number | null;
    lastError?: string;
  }[];
};
const kindName = (kind: ResourceKind) => (kind === 'geosite' ? 'GeoSite' : 'GeoIP');
const sourceOptions = (kind: ResourceKind) => resourceProviders.map((provider) => provider[kind]);
export default function ResourceFields({
  value,
  onChange,
}: {
  value: ResourceSet;
  onChange: (value: ResourceSet) => void;
}) {
  const [status, setStatus] = useState<ResourceStatus | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ResourceFile | null>(null);
  const operation = useRef(false);
  const desktop = desktopServiceAvailable();
  useEffect(() => {
    if (!desktop || busy) return;
    let active = true,
      pending = false;
    const read = () => {
      if (pending) return;
      pending = true;
      void serviceCall<ResourceStatus>('resources.status')
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => {})
        .finally(() => {
          pending = false;
        });
    };
    read();
    const timer = setInterval(read, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [desktop, busy]);
  const run = async (action: () => Promise<ResourceStatus>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      setStatus(await action());
    } catch (e) {
      setError(errorText(e));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  const update = (files: ResourceFile[]) =>
    run(() =>
      serviceCall<ResourceStatus>('resources.update', {
        files: resourceFiles({ ...value, files }),
      }),
    );
  const importFile = (file: File, entry: ResourceFile) =>
    run(async () => {
      const uploaded = { ...entry, url: '', autoUpdate: false };
      parseResources({
        ...value,
        files: value.files.some((current) => current.id === entry.id)
          ? value.files.map((current) => (current.id === entry.id ? uploaded : current))
          : [...value.files, uploaded],
      });
      if (!file.size || file.size > 128 * 1024 * 1024)
        throw new Error('Choose a nonempty DAT file up to 128 MiB.');
      let upload: string | undefined;
      try {
        upload = (
          await serviceCall<{ upload: string }>('resources.uploadBegin', {
            id: entry.id,
            file: resourceFilename(entry),
            kind: entry.kind,
            bytes: file.size,
          })
        ).upload;
        for (let offset = 0; offset < file.size; offset += 512 * 1024) {
          const bytes = new Uint8Array(await file.slice(offset, offset + 512 * 1024).arrayBuffer());
          const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
          await serviceCall('resources.uploadChunk', { upload, offset, hex });
        }
        const result = await serviceCall<ResourceStatus>('resources.uploadCommit', { upload });
        setEditing((current) => (current?.id === entry.id ? uploaded : current));
        return result;
      } catch (e) {
        if (upload) await serviceCall('resources.uploadCancel', { upload }).catch(() => {});
        throw e;
      }
    });
  const add = (kind: ResourceKind) => {
    const names = new Set(value.files.map((file) => file.name.toLowerCase()));
    let n = 1;
    while (names.has(`extra-${kind}-${n}.dat`)) n++;
    setEditing({
      id: crypto.randomUUID(),
      name: `extra-${kind}-${n}.dat`,
      kind,
      url: '',
      enabled: false,
      autoUpdate: false,
      intervalHours: 24,
      throughWayrill: false,
    });
  };
  const save = (entry: ResourceFile) => {
    const previous = value.files.find((file) => file.id === entry.id);
    if (
      previous &&
      previous.name.toLowerCase() !== entry.name.toLowerCase() &&
      status?.files.some(
        (file) =>
          file.present &&
          file.id !== entry.id &&
          file.file.toLowerCase() === entry.name.toLowerCase(),
      )
    )
      throw new Error(`${entry.name} already exists. Choose another filename.`);
    const existing = value.files.some((file) => file.id === entry.id);
    const next = parseResources({
      ...value,
      files: existing
        ? value.files.map((file) => (file.id === entry.id ? entry : file))
        : [...value.files, entry],
    });
    onChange(next);
    setEditing(null);
  };
  const waiting = busy || !!status?.busy;
  return (
    <div className="resource-settings" data-diagnostic-field="resources">
      <div className="resource-toolbar">
        <h3>Resource files</h3>
        <button
          className="secondary-button"
          disabled={!desktop || waiting || !value.files.some((file) => file.url)}
          onClick={() => void update(value.files.filter((file) => file.url))}
        >
          <RefreshCw size={14} />
          {waiting ? 'Updating…' : 'Update now'}
        </button>
      </div>
      {(['geosite', 'geoip'] as const).map((kind) => {
        const files = value.files.filter((file) => file.kind === kind);
        return (
          <section
            className="resource-table-section"
            key={kind}
            aria-label={`${kindName(kind)} files`}
          >
            <div className="resource-table-heading">
              <h3>{kindName(kind)}</h3>
              <div className="resource-actions">
                <button
                  className="icon-button"
                  aria-label={`Add ${kindName(kind)} file`}
                  title="Add file"
                  disabled={value.files.length >= 64}
                  onClick={() => add(kind)}
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>
            <table className="resource-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Default</th>
                  <th>Auto-update</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.map((entry) => {
                  const file = status?.files.find(
                    (file) => file.id === entry.id || file.file === resourceFilename(entry),
                  );
                  const Toggle = entry.enabled ? ToggleRight : ToggleLeft;
                  const Auto = entry.autoUpdate ? ToggleRight : ToggleLeft;
                  return (
                    <tr
                      key={entry.id}
                      className={entry.enabled ? 'resource-default-row' : undefined}
                    >
                      <td>
                        <div className="resource-file-name">
                          <strong title={entry.name}>{entry.name}</strong>
                          <span
                            className="resource-source"
                            title={entry.url || 'Imported from disk'}
                          >
                            {resourceSourceName(entry)}
                          </span>
                        </div>
                        {file && (!file.present || file.bytes != null || !!file.updatedAtMs) && (
                          <small className="resource-file-meta">
                            {file.present ? (
                              <>
                                {file.bytes != null && (
                                  <span className="resource-file-size">
                                    {formatBytes(String(file.bytes))}
                                  </span>
                                )}
                                {!!file.updatedAtMs && (
                                  <span title={new Date(file.updatedAtMs).toLocaleString()}>
                                    Updated {new Date(file.updatedAtMs).toLocaleString()}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span>Not installed</span>
                            )}
                          </small>
                        )}
                        {file?.lastError && <small className="error">{file.lastError}</small>}
                      </td>
                      <td>
                        <button
                          className="icon-button resource-toggle"
                          aria-label={`Default ${entry.name}`}
                          aria-pressed={entry.enabled}
                          title={`Use ${entry.name} for ${kind}: rules`}
                          onClick={() => onChange(selectResource(value, entry.id, !entry.enabled))}
                        >
                          <Toggle size={23} />
                        </button>
                      </td>
                      <td>
                        <button
                          className="icon-button resource-toggle"
                          aria-label={`Auto-update ${entry.name}`}
                          aria-pressed={entry.autoUpdate}
                          disabled={!entry.url}
                          title={
                            entry.url
                              ? `Every ${entry.intervalHours} hours`
                              : 'Set a URL to enable auto-updates'
                          }
                          onClick={() =>
                            onChange({
                              ...value,
                              files: value.files.map((file) =>
                                file.id === entry.id
                                  ? { ...file, autoUpdate: !file.autoUpdate }
                                  : file,
                              ),
                            })
                          }
                        >
                          <Auto size={23} />
                        </button>
                      </td>
                      <td>
                        <div className="resource-actions">
                          <button
                            className="icon-button"
                            aria-label={`Edit ${entry.name}`}
                            title="Edit"
                            onClick={() => setEditing({ ...entry })}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`Delete ${entry.name}`}
                            title="Delete"
                            onClick={() =>
                              onChange({
                                ...value,
                                files: value.files.filter((file) => file.id !== entry.id),
                              })
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!files.length && (
                  <tr>
                    <td colSpan={4} className="editor-empty">
                      No files
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        );
      })}
      <label className="editor-checkbox">
        <input
          type="checkbox"
          checked={value.reloadAfterAutoUpdates}
          onChange={(e) => onChange({ ...value, reloadAfterAutoUpdates: e.target.checked })}
        />
        Reload core after auto-updates
      </label>
      {status?.reloadError ? (
        <p className="field-message error" role="alert">
          {status.reloadError.message}{' '}
          {status.reloadError.retryable ? 'Retrying automatically.' : 'Apply to retry.'}
        </p>
      ) : status?.restartRequired ? (
        <p className="field-help">
          {status.reloadPending === false
            ? 'Updated files will load on the next Apply or Start.'
            : 'Refreshing resource filters.'}
        </p>
      ) : null}
      <ResourceWarnings report={status} />
      {error && (
        <p className="field-message error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <ResourceFileEditor
          key={editing.id}
          value={editing}
          onSave={save}
          onClose={() => setEditing(null)}
          onImport={(file, entry) => void importFile(file, entry)}
          canImport={desktop && !waiting}
          busy={busy}
          error={error}
        />
      )}
    </div>
  );
}

function ResourceFileEditor({
  value,
  onSave,
  onClose,
  onImport,
  canImport,
  busy,
  error,
}: {
  value: ResourceFile;
  onSave: (file: ResourceFile) => void;
  onClose: () => void;
  onImport: (file: File, entry: ResourceFile) => void;
  canImport: boolean;
  busy: boolean;
  error: string;
}) {
  const [draft, setDraft] = useState(value),
    [problem, setProblem] = useState('');
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <Dialog
      title={`${kindName(draft.kind)} file`}
      onClose={onClose}
      className="resource-file-dialog"
      footer={
        <>
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => {
              try {
                onSave(draft);
              } catch (e) {
                setProblem(errorText(e));
              }
            }}
          >
            Save file
          </button>
        </>
      }
    >
      <label className="editor-field">
        <span>Filename</span>
        <input
          value={draft.name}
          disabled={busy}
          readOnly={draft.id.startsWith('packaged-')}
          maxLength={105}
          spellCheck={false}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <div className="editor-field">
        <label htmlFor="resource-file-url">URL</label>
        <EditableSelect
          id="resource-file-url"
          label="Resource URL"
          type="url"
          options={sourceOptions(draft.kind)}
          value={draft.url}
          disabled={busy}
          maxLength={8192}
          spellCheck={false}
          placeholder="https://…"
          onChange={(url) => setDraft({ ...draft, url, autoUpdate: !!url && draft.autoUpdate })}
        />
      </div>
      <div className="resource-update-controls">
        <label className="editor-checkbox">
          <input
            type="checkbox"
            checked={draft.autoUpdate}
            disabled={busy || !draft.url}
            onChange={(e) => setDraft({ ...draft, autoUpdate: e.target.checked })}
          />
          Auto-update
        </label>
        <label className="editor-field">
          <span>Every (hours)</span>
          <input
            type="number"
            min={1}
            disabled={busy}
            max={8760}
            value={Number.isNaN(draft.intervalHours) ? '' : draft.intervalHours}
            onChange={(e) => setDraft({ ...draft, intervalHours: e.target.valueAsNumber })}
          />
        </label>
      </div>
      <label className="editor-checkbox">
        <input
          type="checkbox"
          checked={draft.throughWayrill}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, throughWayrill: e.target.checked })}
        />
        Download through Wayrill
      </label>
      <label className="secondary-button resource-file-upload">
        <Upload size={14} />
        Choose DAT file
        <input
          type="file"
          accept=".dat"
          aria-label="Choose DAT file"
          disabled={!canImport}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImport(file, draft);
            e.target.value = '';
          }}
        />
      </label>
      {(problem || error) && (
        <p className="field-message error" role="alert">
          {problem || error}
        </p>
      )}
    </Dialog>
  );
}
