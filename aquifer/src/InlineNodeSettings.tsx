import { useState } from 'react';
import { jsonEqual, jsonRecord } from './graph/xrayJson';
import { errorMessage } from './remoteClient';
import RemoteNodeSettings from './RemoteNodeSettings';
import { optionalSettingsIssues, outboundFields } from './settingsFields';
import type { RouteDestination } from './routingEditor';
import ServerFields from './ServerFields';
import { objectAt, setProperty } from './nativeProperties';

export default function InlineNodeSettings({
  value,
  schema,
  destinations,
  onSave,
  onDirty,
}: {
  value: unknown;
  schema: string;
  destinations: RouteDestination[];
  onSave: (value: unknown) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const initial = typeof value === 'string' ? { address: value } : value;
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const [validated, setValidated] = useState(false);
  const issues = validated && jsonRecord(draft) ? optionalSettingsIssues(schema, draft) : [];
  const dirty = !jsonEqual(draft, initial);
  if (!jsonRecord(draft)) return null;
  const protocol = outboundFields(draft);
  const change = (next: Record<string, unknown>) => {
    setDraft(next);
    onDirty(!jsonEqual(next, initial));
    setError('');
  };
  return (
    <form
      className="inline-node-settings"
      aria-label="Node settings"
      onSubmit={(event) => {
        event.preventDefault();
        setValidated(true);
        if (optionalSettingsIssues(schema, draft).length) return;
        try {
          onSave(
            typeof value === 'string' && Object.keys(draft).length === 1 ? draft.address : draft,
          );
          onDirty(false);
          setError('');
        } catch (reason) {
          setError(errorMessage(reason));
        }
      }}
    >
      <RemoteNodeSettings
        schema={schema}
        value={draft}
        tab="Server"
        issues={issues}
        destinations={destinations}
        onChange={change}
        showProtocolAdvanced={false}
      />
      {schema === 'OutboundDetourConfig' && (
        <details className="inline-advanced">
          <summary>Advanced</summary>
          <ServerFields
            schema={protocol.schema}
            object={objectAt(draft, 'settings')}
            root={draft}
            path="settings."
            fieldSets={protocol.fieldSets}
            direction="outbound"
            issues={issues}
            advancedOnly
            onChange={(next) => change(setProperty(draft, 'settings', next))}
          />
          <RemoteNodeSettings
            schema={schema}
            value={draft}
            tab="Advanced"
            issues={issues}
            destinations={destinations}
            onChange={change}
          />
        </details>
      )}
      {issues.length > 0 && (
        <ul className="inline-settings-errors" role="alert">
          {issues.map((issue) => (
            <li key={issue.path}>{issue.message}</li>
          ))}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="inline-settings-actions">
        <button className="primary" type="submit" disabled={!dirty}>
          Apply changes
        </button>
        <button
          type="button"
          disabled={!dirty}
          onClick={() => {
            setDraft(initial);
            onDirty(false);
            setValidated(false);
            setError('');
          }}
        >
          Reset
        </button>
      </div>
    </form>
  );
}
