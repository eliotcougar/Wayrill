import { it, expect } from 'vitest';
import { testUrlProblem, udpUrlProblem } from './outboundTestSettings';
it('accepts STUN and DNS endpoints with default/custom ports and IPv6, and rejects unrelated URLs', () => {
  for (const text of [
    'stun://stun.cloudflare.com:3478',
    'dns://9.9.9.9:9953',
    'dns://[::1]:53',
    'stun://localhost',
  ])
    expect(udpUrlProblem(text), text).toBe('');
  for (const text of [
    'https://example.com',
    'stun://user:pass@host',
    'dns://host/path',
    'dns://host?x',
    'dns://host#x',
    'stun://host:0',
    'stun://',
    'dns://host:70000',
  ])
    expect(udpUrlProblem(text), text).toBeTruthy();
});
it('rejects credentials, non-HTTP URLs and fragments, and permits local test endpoints', () => {
  for (const s of [
    'file:///secret',
    'https://user:pass@example.com',
    'https://example.com/#fragment',
    'not-a-url',
  ])
    expect(testUrlProblem(s)).toBeTruthy();
  expect(testUrlProblem('http://127.0.0.1:18881/health')).toBe('');
});
