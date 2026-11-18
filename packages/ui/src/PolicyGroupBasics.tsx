export const policyGroupModes = [
  {
    value: 'leastPing',
    label: 'Lowest latency',
    help: 'Use the available server with the lowest measured delay.',
  },
  {
    value: 'roundRobin',
    label: 'Round robin',
    help: 'Use each member in turn for new connections.',
  },
  {
    value: 'random',
    label: 'Random',
    help: 'Choose a member at random for each new connection.',
  },
  {
    value: 'leastLoad',
    label: 'Least load',
    help: 'Choose using measured delay, delay variation and configured failure limits.',
  },
] as const;

export default function PolicyGroupBasics({
  name,
  strategy,
  disabled = false,
  onNameChange,
  onStrategyChange,
}: {
  name: string;
  strategy: string;
  disabled?: boolean;
  onNameChange: (name: string) => void;
  onStrategyChange: (strategy: string) => void;
}) {
  return (
    <div className="policy-group-basics">
      <div className="editor-two-fields">
        <label
          className="editor-field policy-name-field"
          data-setting-path="tag"
          data-diagnostic-field="tag"
        >
          <span>Name</span>
          <input
            required
            autoComplete="off"
            value={name}
            disabled={disabled}
            maxLength={128}
            onChange={(event) => onNameChange(event.currentTarget.value)}
          />
        </label>
        <label
          className="editor-field"
          data-setting-path="strategy"
          data-diagnostic-field="strategy"
        >
          <span>Selection mode</span>
          <select
            value={strategy}
            disabled={disabled}
            aria-label="Selection mode"
            onChange={(event) => onStrategyChange(event.currentTarget.value)}
          >
            {policyGroupModes.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            {!policyGroupModes.some(({ value }) => value === strategy) && (
              <option value={strategy}>{strategy}</option>
            )}
          </select>
        </label>
      </div>
      <p className="field-help">{policyGroupModes.find(({ value }) => value === strategy)?.help}</p>
    </div>
  );
}
