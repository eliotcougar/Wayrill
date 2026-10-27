import { Monitor, Moon, Sun } from 'lucide-react';
import Dialog from './Dialog';
import type useTheme from '../useTheme';
import '../appearance.css';
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
  onClose,
}: {
  theme: ReturnType<typeof useTheme>;
  onClose: () => void;
}) {
  return (
    <Dialog title="Appearance" onClose={onClose}>
      <fieldset className="theme-choices">
        <legend>Theme</legend>
        {choices.map(({ value, label, icon: Icon }) => (
          <label className="theme-choice" key={value}>
            <input
              type="radio"
              name="app-theme"
              value={value}
              checked={theme.preference === value}
              onChange={() => theme.setPreference(value)}
            />
            <Icon size={21} aria-hidden="true" />
            <span>
              <strong>{label}</strong>
            </span>
          </label>
        ))}
      </fieldset>
      {(theme.persistenceError || theme.windowError) && (
        <p className="theme-error" role="status">
          {theme.persistenceError || theme.windowError}
        </p>
      )}
    </Dialog>
  );
}
