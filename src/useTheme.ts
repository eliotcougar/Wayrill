import { useEffect, useState, useSyncExternalStore } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { initializeTheme, themeBackgrounds } from './theme';

let nativeUpdates: Promise<unknown> = Promise.resolve();
export default function useTheme() {
  const controller = initializeTheme();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [windowError, setWindowError] = useState('');
  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    // Serialize rapid choices so an older IPC reply cannot leave the frame in another theme.
    const update = nativeUpdates
      .catch(() => {})
      .then(async () => {
        const appWindow = getCurrentWindow();
        await appWindow.setTheme(snapshot.preference === 'system' ? null : snapshot.preference);
        await appWindow.setBackgroundColor(themeBackgrounds[snapshot.resolved]);
      });
    nativeUpdates = update;
    void update.then(
      () => {
        if (current) setWindowError('');
      },
      () => {
        if (current)
          setWindowError('The app theme changed, but the Windows frame could not be updated.');
      },
    );
    return () => {
      current = false;
    };
  }, [snapshot.preference, snapshot.resolved]);
  return { ...snapshot, setPreference: controller.setPreference, windowError };
}
