import { jsonArray, jsonRecord } from './xrayJson';

export function virtualDestinations(api: unknown, inbounds: unknown) {
  const targets = new Map<string, { id: string; title: string; raw: Record<string, unknown> }>();
  if (jsonRecord(api) && typeof api.tag === 'string' && api.tag)
    targets.set(api.tag, { id: 'remote-api', title: 'Xray API · internal', raw: api });
  for (const inbound of jsonArray(inbounds) ? inbounds : []) {
    if (!jsonRecord(inbound) || inbound.protocol !== 'vless' || !jsonRecord(inbound.settings))
      continue;
    const accounts = inbound.settings.clients ?? inbound.settings.users;
    for (const account of jsonArray(accounts) ? accounts : []) {
      if (!jsonRecord(account) || !jsonRecord(account.reverse)) continue;
      const tag = account.reverse.tag;
      if (typeof tag === 'string' && tag && !targets.has(tag))
        targets.set(tag, {
          id: `remote-reverse-${targets.size}`,
          title: 'VLESS reverse · internal',
          raw: account.reverse,
        });
    }
  }
  return targets;
}
