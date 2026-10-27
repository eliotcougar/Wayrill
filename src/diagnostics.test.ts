import { expect, it } from 'vitest';
import {
  diagnosticEntries,
  diagnosticSourceId,
  diagnosticText,
  maskDiagnosticText,
  type DiagnosticSource,
} from './diagnostics';
it('orders separate component files chronologically without altering raw entries', () => {
  const sources: DiagnosticSource[] = [
    {
      source: 'service',
      folder: '',
      error: null,
      text: JSON.stringify({
        timeMs: 3000,
        pid: 1,
        component: 'tun',
        level: 'error',
        message: 'later',
      }),
    },
    {
      source: 'desktop',
      folder: '',
      error: null,
      text: JSON.stringify({
        timeMs: 1000,
        pid: 2,
        component: 'ipc',
        level: 'info',
        message: 'earlier',
      }),
    },
  ];
  const before = JSON.stringify(sources),
    text = diagnosticText(diagnosticEntries(sources));
  expect(text.indexOf('earlier')).toBeLessThan(text.indexOf('later'));
  expect(JSON.stringify(sources)).toBe(before);
});
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

it('keeps malformed lines and unknown levels inspectable without invalid dates', () => {
  const text = [
    'null',
    '"text"',
    '{"message":"partial"}',
    '{broken',
    JSON.stringify({
      timeMs: 1e20,
      pid: 1,
      component: 'TUN',
      level: 'error',
      message: 'invalid date',
    }),
    JSON.stringify({
      timeMs: 1000,
      pid: 1,
      component: 'future',
      level: 'fatal',
      message: 'future level',
    }),
  ].join('\n');
  const entries = diagnosticEntries([{ source: 'service', folder: '', error: null, text }]);
  expect(
    entries.slice(0, 5).every((entry) => entry.level === 'unknown' && entry.timeMs === null),
  ).toBe(true);
  expect(entries[5].level).toBe('fatal');
  expect(diagnosticText(entries)).toContain('{broken');
  expect(diagnosticText(entries)).not.toContain('Invalid Date');
  expect(entries.map((entry) => entry.line).join('\n')).toBe(text);
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
