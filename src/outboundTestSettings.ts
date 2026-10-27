import { useEffect, useState } from 'react';
export interface OutboundTestSettings {
  testUrl: string;
  countryUrl: string;
  speedUrl: string;
  udpEnabled: boolean;
  udpUrl: string;
}
export const testSettingsKey = 'wayrill.outboundTest.settings';
export const defaultTestSettings: OutboundTestSettings = {
  testUrl: 'https://www.google.com/generate_204',
  countryUrl: 'https://api.ip.sb/geoip',
  speedUrl: 'https://speed.cloudflare.com/__down?bytes=99999999',
  udpEnabled: false,
  udpUrl: 'stun://stun.cloudflare.com:3478',
};
export function udpUrlProblem(text: string) {
  try {
    const url = new URL(text);
    if (
      text.length <= 2048 &&
      ['stun:', 'dns:'].includes(url.protocol) &&
      url.hostname &&
      url.hostname.length <= 253 &&
      /^[\x21-\x7e]+$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ['', '/'].includes(url.pathname) &&
      url.port !== '0'
    )
      return '';
  } catch {
    /* validated below */
  }
  return 'Use stun://host:port or dns://host:port, without credentials, a path or query.';
}
export function testUrlProblem(text: string, optional = false) {
  if (optional && !text) return '';
  try {
    const url = new URL(text);
    if (
      text.length <= 2048 &&
      ['https:', 'http:'].includes(url.protocol) &&
      url.hostname &&
      !url.username &&
      !url.password &&
      !url.hash
    )
      return '';
  } catch {
    /* validated below */
  }
  return 'Use an HTTP(S) URL without login credentials or a fragment.';
}
export function loadOutboundTestSettings(): OutboundTestSettings {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(testSettingsKey) ?? 'null');
    if (
      parsed &&
      typeof parsed === 'object' &&
      'testUrl' in parsed &&
      'countryUrl' in parsed &&
      typeof parsed.testUrl === 'string' &&
      typeof parsed.countryUrl === 'string' &&
      !testUrlProblem(parsed.testUrl) &&
      !testUrlProblem(parsed.countryUrl, true)
    )
      return {
        testUrl: parsed.testUrl,
        countryUrl: parsed.countryUrl,
        udpEnabled: 'udpEnabled' in parsed && parsed.udpEnabled === true,
        udpUrl:
          'udpUrl' in parsed && typeof parsed.udpUrl === 'string' && !udpUrlProblem(parsed.udpUrl)
            ? parsed.udpUrl
            : defaultTestSettings.udpUrl,
        speedUrl:
          'speedUrl' in parsed &&
          typeof parsed.speedUrl === 'string' &&
          !testUrlProblem(parsed.speedUrl)
            ? parsed.speedUrl
            : defaultTestSettings.speedUrl,
      };
  } catch {
    /* retain usable defaults */
  }
  return { ...defaultTestSettings };
}
export function useOutboundTestSettings() {
  const [value, setValue] = useState<OutboundTestSettings>(loadOutboundTestSettings);
  useEffect(() => {
    const restored = (event: StorageEvent) => {
      if (event.key === testSettingsKey || event.key === null) setValue(loadOutboundTestSettings());
    };
    window.addEventListener('storage', restored);
    return () => window.removeEventListener('storage', restored);
  }, []);
  return {
    value,
    save: (next: OutboundTestSettings) => {
      const complete = { ...next };
      const problem =
        testUrlProblem(complete.testUrl) ||
        testUrlProblem(complete.countryUrl, true) ||
        testUrlProblem(complete.speedUrl) ||
        (complete.udpEnabled ? udpUrlProblem(complete.udpUrl) : '');
      if (problem) throw new Error(problem);
      try {
        localStorage.setItem(testSettingsKey, JSON.stringify(complete));
      } catch {
        throw new Error('Test settings could not be saved.');
      }
      setValue(complete);
    },
  };
}
