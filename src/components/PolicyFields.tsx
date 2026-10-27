import { useState } from 'react';
import useFieldValidity from './useFieldValidity';
import { Plus, Trash2 } from 'lucide-react';
import { policyLevelFields, policySystemFields } from '../graph/nativeFields';
import { jsonRecord } from '../graph/xrayJson';
import NativeObjectFields from './NativeObjectFields';

export default function PolicyFields({
  policy,
  onChange,
  onValidity,
  idPrefix,
}: {
  policy: Record<string, unknown>;
  onChange: (policy: Record<string, unknown>) => void;
  onValidity: (id: string, valid: boolean) => void;
  idPrefix: string;
}) {
  const levels = jsonRecord(policy.levels) ? policy.levels : {},
    ids = Object.keys(levels),
    [selected, setSelected] = useState(ids[0] ?? ''),
    [next, setNext] = useState('0'),
    [error, setError] = useState('');
  const chosen = ids.includes(selected) ? selected : (ids[0] ?? '');
  const { report: levelValidity, blocked: levelBlocked } = useFieldValidity(onValidity);
  function add() {
    if (
      !/^(0|[1-9]\d*)$/.test(next) ||
      Number(next) > 4294967295 ||
      ids.includes(next) ||
      ids.length >= 64
    ) {
      setError('Choose an unused policy level from 0 to 4294967295; at most 64 levels.');
      return;
    }
    onChange({ ...policy, levels: { ...levels, [next]: {} } });
    setSelected(next);
    setNext(String(Number(next) + 1));
    setError('');
  }
  const system = jsonRecord(policy.system) ? policy.system : {};
  return (
    <div className="native-policy-fields">
      <p className="runtime-scope">
        Blank values use Xray’s native policy defaults. Inbound and outbound account settings select
        a level. Enable core statistics to collect the selected counters.
      </p>
      <div className="runtime-actions">
        <label className="editor-field">
          <span>Policy level</span>
          <select
            aria-label={`${idPrefix} policy level`}
            value={chosen}
            disabled={levelBlocked}
            aria-describedby={levelBlocked ? `${idPrefix}-entry-error` : undefined}
            onChange={(e) => {
              if (!levelBlocked) setSelected(e.target.value);
            }}
          >
            <option value="">Select a level</option>
            {ids.map((id) => (
              <option key={id} value={id}>
                Level {id}
              </option>
            ))}
          </select>
        </label>
        <label className="editor-field">
          <span>New level number</span>
          <input
            type="number"
            min={0}
            max={4294967295}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <button className="secondary-button" disabled={levelBlocked} onClick={add}>
          <Plus size={14} /> Add level
        </button>
        <button
          className="secondary-button"
          disabled={!chosen}
          onClick={() => {
            const remaining = { ...levels };
            delete remaining[chosen];
            onChange({ ...policy, levels: remaining });
            setSelected('');
          }}
        >
          <Trash2 size={14} /> Remove level
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {levelBlocked && (
        <p className="field-message error" id={`${idPrefix}-entry-error`}>
          Correct invalid fields before changing entries.
        </p>
      )}
      {chosen && (
        <NativeObjectFields
          key={chosen}
          object={jsonRecord(levels[chosen]) ? levels[chosen] : {}}
          fields={policyLevelFields}
          idPrefix={`${idPrefix}-level-${chosen}`}
          onValidity={levelValidity}
          onChange={(value) => onChange({ ...policy, levels: { ...levels, [chosen]: value } })}
        />
      )}
      <h3>System counters</h3>
      <NativeObjectFields
        object={system}
        fields={policySystemFields}
        idPrefix={`${idPrefix}-system`}
        onValidity={onValidity}
        onChange={(value) => onChange({ ...policy, system: value })}
      />
    </div>
  );
}
