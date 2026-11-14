import { invoke } from '@tauri-apps/api/core';
import type { PoolTransfer } from './layers';

export const openPool = () => invoke<void>('pool_open');
export const choosePoolFolder = () =>
  invoke<string | null>('process_picker', { mode: 'pool-folder' });
export const sendPoolExport = (transfer: PoolTransfer) =>
  invoke<void>('pool_send', { id: crypto.randomUUID(), text: JSON.stringify(transfer) });
