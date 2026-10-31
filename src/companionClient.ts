import { invoke, isTauri } from '@tauri-apps/api/core';

export type CompanionBrowser = { id: string; name: string; installed: boolean };
export type CompanionStatus = {
  extensionId: string;
  version: string;
  extensionPath: string;
  hostPath: string;
  available: boolean;
  registered: boolean;
  origins: string[];
  issues: string[];
  browsers: CompanionBrowser[];
};

export const desktopCompanionAvailable = () => isTauri();
export const companionStatus = () => invoke<CompanionStatus>('companion_status');
export const registerCompanion = (extensionId?: string) =>
  invoke<CompanionStatus>('companion_register', extensionId ? { extensionId } : {});
export const unregisterCompanion = () => invoke<CompanionStatus>('companion_unregister');
export const openCompanion = (target: 'folder' | 'browser', browser?: string) =>
  invoke<void>('companion_open', browser ? { target, browser } : { target });
