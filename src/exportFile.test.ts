// @vitest-environment jsdom
import { expect, it, vi, afterEach } from 'vitest';
const api = vi.hoisted(() => ({ desktop: true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => api.desktop, invoke: api.invoke }));
import { exportFile } from './exportFile';
afterEach(() => vi.clearAllMocks());
it('uses the native save command and reports cancellation accurately', async () => {
  api.invoke.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  expect(await exportFile('graph.wayrill.json', '{}')).toBe(false);
  expect(await exportFile('graph.wayrill.json', '{}')).toBe(true);
  expect(api.invoke).toHaveBeenCalledWith('export_json', {
    name: 'graph.wayrill.json',
    text: '{}',
  });
});
it('propagates save failures without claiming export success', async () => {
  api.invoke.mockRejectedValueOnce('Access denied');
  await expect(exportFile('graph.json', '{}')).rejects.toBe('Access denied');
});
