import { expect, it } from 'vitest';
import { formatPoolInvitation, parsePoolInvitation, type PoolSource } from './invitation';

const invite =
  'wp1.0123456789abcdef0123456789abcdef.00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const urlSource: PoolSource = { kind: 'url', address: 'https://example.com/pool', invite };
const exampleCode =
  'WP2HX608Q9Q2J1MSX608Q9Q2J1MSH00QV4ZJ918EA+IJRNSFS%3XH00QV4ZJ918EA+IJRNSFS%3X42E1LDDOFG0E/WD15FGOFFIF:';

it('copies a QR alphanumeric share code and restores the original source and access key', () => {
  const sources: PoolSource[] = [
    urlSource,
    { kind: 'url', address: 'https://example.com:8443/Team%20Pool/α', invite },
    { kind: 'url', address: 'HTTPS://example.com/Team/Pool', invite },
    { kind: 'url', address: 'http://[::1]:8080/Pool', invite },
    { kind: 'folder', address: String.raw`\\server\共享\Team Pool`, invite },
  ];
  for (const source of sources) {
    const code = formatPoolInvitation(source);
    expect(code).toMatch(/^[0-9A-Z$%*+./:-]+$/);
    expect(parsePoolInvitation(`\r\n${code}\r\n`)).toEqual(source);
  }
  expect(formatPoolInvitation(urlSource)).toBe(exampleCode);
});

it('accepts legacy invitations and rejects incomplete or invalid share codes', () => {
  expect(
    parsePoolInvitation(`Wayrill Pool invitation\r\n${urlSource.address}\r\n${invite}`),
  ).toEqual(urlSource);
  for (const partial of [exampleCode.slice(0, -1), exampleCode.slice(0, -8)]) {
    expect(parsePoolInvitation(partial)).toBeUndefined();
  }
  expect(
    parsePoolInvitation(`${exampleCode.slice(0, 4)}///${exampleCode.slice(7)}`),
  ).toBeUndefined();
});
