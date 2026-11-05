import { invoke } from '@tauri-apps/api/core';
import { desktopAvailable } from '../remoteClient';
import { emptyLibrary, parseUserLibrary, type UserLibrary } from './model';

export interface UserStore {
  load(): Promise<UserLibrary>;
  save(library: UserLibrary): Promise<void>;
}
export const userStore: UserStore = {
  load: async () => {
    if (!desktopAvailable) return emptyLibrary();
    const text = await invoke<string | null>('user_library_load');
    return text === null ? emptyLibrary() : parseUserLibrary(text);
  },
  save: async (library) => {
    if (desktopAvailable) await invoke('user_library_save', { text: JSON.stringify(library) });
  },
};

export async function exportJson(filename: string, text: string): Promise<void> {
  if (desktopAvailable) {
    await invoke('export_json', { filename, text });
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
