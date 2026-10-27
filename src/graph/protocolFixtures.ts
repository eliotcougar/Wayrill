// Fictional loopback/source-validation fixtures. No host subscription data.
import { protocolTemplate, type ProtocolSpec } from './protocols';
export const fixtureId = '11111111-2222-4333-8444-555555555555';
export const fixtureKey = 'A'.repeat(43) + '=';
export function protocolFixture(spec: ProtocolSpec): Record<string, unknown> {
  const raw = protocolTemplate(spec),
    settings = raw.settings as Record<string, unknown>;
  if (spec.direction === 'outbound') {
    if ('address' in settings) settings.address = '127.0.0.1';
    if (spec.protocol === 'vmess') settings.id = fixtureId;
    if (['trojan', 'shadowsocks'].includes(spec.protocol)) settings.password = 'fictional-qa-only';
    if (spec.protocol === 'wireguard')
      Object.assign(settings, {
        secretKey: fixtureKey,
        address: ['10.90.0.2'],
        peers: [
          {
            publicKey: 'AQ'.repeat(21) + 'E=',
            endpoint: '127.0.0.1:20922',
            allowedIPs: ['0.0.0.0/0'],
            keepAlive: 0,
          },
        ],
      });
  } else {
    if (['vless', 'vmess'].includes(spec.protocol))
      settings.clients = [{ id: fixtureId, level: 0, email: 'qa@example.invalid' }];
    if (spec.protocol === 'trojan')
      settings.clients = [{ password: 'fictional-qa-only', level: 0, email: 'qa@example.invalid' }];
    if (spec.protocol === 'shadowsocks') settings.password = 'fictional-qa-only';
    if (spec.protocol === 'hysteria')
      settings.clients = [{ auth: 'fictional-qa-only', email: 'qa@example.invalid' }];
    if (spec.protocol === 'masque')
      settings.clients = [{ pass: 'fictional-qa-only', email: 'qa@example.invalid' }];
    if (spec.protocol === 'wireguard')
      Object.assign(settings, { secretKey: fixtureKey, address: ['10.90.0.1'], peers: [] });
  }
  if (
    !['tunnel', 'tun', 'wireguard'].includes(spec.protocol) &&
    spec.direction === 'inbound' &&
    !raw.listen
  )
    Object.assign(raw, { listen: '127.0.0.1', port: 2082 });
  raw.tag = `qa-${spec.protocol}-${spec.direction}`;
  return raw;
}
