import { invoke } from '@tauri-apps/api/core';
export const openAquifer = () => invoke<void>('aquifer_open');
