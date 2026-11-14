import { Fragment } from 'react';
import { SettingField } from '../components/SettingField';
import { globalFields } from '../graph/defaults';
import { formatPoolSetting, poolSettingKeys, type PoolSettings } from '../graph/poolSettings';

const poolSettingFields = poolSettingKeys.map((key) =>
  globalFields.find((field) => field.key === key)!,
);

export function PoolSettingSummary({ settings }: { settings?: PoolSettings }) {
  if (!settings) return null;
  return (
    <dl className="pool-summary">
      {poolSettingKeys.map((key, index) => {
        const value = settings[key];
        return value === undefined ? null : (
          <Fragment key={key}>
            <dt>{poolSettingFields[index].label}</dt>
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
  return poolSettingKeys.map((key, index) => {
    const current = value?.[key];
    return (
      <SettingField
        key={key}
        field={{ ...poolSettingFields[index], placeholder: `Inherit: ${inheritedLabel}` }}
        value={current}
        issues={[]}
        idPrefix="pool-setting"
        inherited={current === undefined}
        inheritHint={{ text: inheritedLabel, source: 'global' }}
        onInherit={() => {
          const next = { ...value };
          delete next[key];
          onChange(next);
        }}
        onValidity={onValidity}
        onChange={(setting) => {
          if (typeof setting === 'number' || typeof setting === 'string')
            onChange({ ...value, [key]: setting });
        }}
      />
    );
  });
}
