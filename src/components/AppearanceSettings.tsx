import { Monitor, Moon, Sun } from 'lucide-react';
import Dialog from './Dialog';
import type useTheme from '../useTheme';
import type { useGraphActivityPreference } from '../useGraphActivity';
const choices = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  {
    value: 'system',
    label: 'System',
    icon: Monitor,
  },
] as const;
export default function AppearanceSettings({
  theme,
  trafficGlow,
  onClose,
}: {
  theme: ReturnType<typeof useTheme>;
  trafficGlow: ReturnType<typeof useGraphActivityPreference>;
  onClose: () => void;
}) {
  return (
    <Dialog title="Appearance" onClose={onClose}>
      <fieldset className="choice-group">
        <legend>Theme</legend>
        {choices.map(({ value, label, icon: Icon }) => (
          <label className="check-control choice-card" key={value}>
            <input
              type="radio"
              name="app-theme"
              value={value}
              checked={theme.preference === value}
              onChange={() => theme.setPreference(value)}
            />
            <Icon size={21} aria-hidden="true" />
            <span className="item-content">
              <strong>{label}</strong>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="check-control">
        <input
          type="checkbox"
          checked={trafficGlow.enabled}
          onChange={(event) => trafficGlow.setEnabled(event.currentTarget.checked)}
        />
        Traffic glow on graph
      </label>
      <p className="field-hint">
        Data outputs show throughput; links glow with recent routing matches.
      </p>
      {trafficGlow.error && (
        <p className="notice notice--error" role="status">
          {trafficGlow.error}
        </p>
      )}
      {(theme.persistenceError || theme.windowError) && (
        <p className="notice notice--error" role="status">
          {theme.persistenceError || theme.windowError}
        </p>
      )}
    </Dialog>
  );
}
