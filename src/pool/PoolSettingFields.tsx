import { Fragment, useId } from 'react';
import EditableSelect from '../components/EditableSelect';
import { SettingField } from '../components/SettingField';
import { globalFields } from '../graph/defaults';
import {
  formatPoolSetting,
  isPoolResourceKey,
  poolResourceLabel,
  poolResourceProblem,
  poolSettingKeys,
  type PoolSettings,
} from '../graph/poolSettings';
import { packagedResources, poolResourceKinds } from '../graph/resources';

const globalField = (key: string) => globalFields.find((field) => field.key === key)!;

export function PoolSettingSummary({ settings }: { settings?: PoolSettings }) {
  if (!settings) return null;
  return (
    <dl className="pool-summary">
      {poolSettingKeys.map((key) => {
        const value = settings[key];
        return value === undefined ? null : (
          <Fragment key={key}>
            <dt>{isPoolResourceKey(key) ? poolResourceLabel(key) : globalField(key).label}</dt>
            <dd>{formatPoolSetting(key, value)}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

export function PoolSettingFields({
  value,
  inheritedLabel,
  onChange,
  onValidity,
}: {
  value?: PoolSettings;
  inheritedLabel: string;
  onChange: (settings: PoolSettings) => void;
  onValidity: (key: string, valid: boolean) => void;
}) {
  const id = useId();
  return poolSettingKeys.map((key) => {
    const current = value?.[key];
    const inherit = () => {
      const next = { ...value };
      delete next[key];
      onChange(next);
    };
    if (isPoolResourceKey(key)) {
      const label = poolResourceLabel(key);
      const fieldId = `${id}-${key}`;
      const problem = current === undefined ? null : poolResourceProblem(key, current);
      return (
        <div className="field" key={key}>
          <label htmlFor={fieldId}>{label}</label>
          <EditableSelect
            id={fieldId}
            label={label}
            options={packagedResources
              .filter((file) => file.kind === poolResourceKinds[key])
              .map((file) => file.name)}
            value={String(current ?? '')}
            maxLength={105}
            spellCheck={false}
            placeholder={`Inherit: ${inheritedLabel}`}
            aria-invalid={!!problem}
            aria-describedby={problem ? `${fieldId}-problem` : undefined}
            onChange={(file) => {
              onValidity(key, !file || !poolResourceProblem(key, file));
              if (file) onChange({ ...value, [key]: file });
              else inherit();
            }}
          />
          {problem && (
            <p className="field-message error" id={`${fieldId}-problem`}>
              {problem}
            </p>
          )}
        </div>
      );
    }
    return (
      <SettingField
        key={key}
        field={{ ...globalField(key), placeholder: `Inherit: ${inheritedLabel}` }}
        value={current}
        issues={[]}
        idPrefix="pool-setting"
        inherited={current === undefined}
        inheritHint={{ text: inheritedLabel, source: 'global' }}
        onInherit={inherit}
        onValidity={onValidity}
        onChange={(setting) => {
          if (typeof setting === 'number' || typeof setting === 'string')
            onChange({ ...value, [key]: setting });
        }}
      />
    );
  });
}
