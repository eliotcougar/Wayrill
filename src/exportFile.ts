import { invoke, isTauri } from '@tauri-apps/api/core';
/** Native WebView2 does not implement anchor/Blob downloads. Cancellation is quiet. */
export async function exportFile(name: string, text: string): Promise<boolean> {
  if (isTauri()) return invoke<boolean>('export_json', { name, text });
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return true;
}
