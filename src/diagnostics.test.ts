import { expect, it } from 'vitest';
import {
  diagnosticEntries,
  diagnosticSourceId,
  maskDiagnosticText,
  type DiagnosticSource,
} from './diagnostics';
it('keeps local display raw and masks deliberate bulk exports using the preference', () => {
  const text =
    'wayrill-service.exe cannot connect to example.com:443 from 192.168.1.2; resolver [fd90::1]:53 and fd90::2. App 0.29.28';
  expect(maskDiagnosticText(text, '')).toBe(text);
  const masked = maskDiagnosticText(text, 'full');
  expect(masked).not.toContain('example.com');
  expect(masked).not.toContain('192.168.1.2');
  expect(masked).not.toContain('fd90::');
  expect(masked).toContain('wayrill-service.exe');
  expect(masked).toContain('0.29.28');
  expect(masked).toContain(':443');
});
it('uses authoritative core header severity and does not classify message-body brackets', () => {
  const source = (component: string, message: string): DiagnosticSource => ({
    source: 'service',
    folder: '',
    error: null,
    text: JSON.stringify({ timeMs: 1000, pid: 1, component, level: 'info', message }),
  });
  const entries = diagnosticEntries([
    source('TUN', '2026/10/21 10:00:00.123 [Error] [12] app/router: Access is denied.'),
    source('Xray', '[Warning] failed; target name [Info]'),
    source('TUN', 'normal text mentions [Error]'),
    source('renderer', '[Error] example in user text'),
  ]);
  expect(entries.map((entry) => entry.level)).toEqual(['error', 'warning', 'info', 'info']);
  expect(diagnosticSourceId(entries[0])).not.toBe(diagnosticSourceId(entries[1]));
});
