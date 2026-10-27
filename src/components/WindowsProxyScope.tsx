import type { CaptureSettingsRow } from '../systemCapture';

export default function WindowsProxyScope({
  row,
  busy,
  run,
}: {
  row: CaptureSettingsRow;
  busy: boolean;
  run: (method: string, params: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <>
      <label className="editor-field capture-scope-select">
        <span>Scope</span>
        <select
          aria-label="Windows proxy scope"
          value={row.scope}
          disabled={busy || !row.supported}
          onChange={(event) =>
            void run('system.capture.setScope', {
              scope: event.target.value,
              expectedVersion: row.version,
            })
          }
        >
          <option value="user">Per-user</option>
          <option value="machine">Machine-wide · all users</option>
        </select>
      </label>
      {row.managed && (
        <p className="field-help">Changing scope restores the previous Wayrill assignment.</p>
      )}
    </>
  );
}
