import { cloneJson, jsonArray, jsonRecord, jsonText } from './graph/xrayJson';
import { get, objectAt, setProperty } from './nativeProperties';
import type { RemoteView, ViewNode } from './remoteModel';
export type StashTab = 'outbounds' | 'policyGroups' | 'proxyChains';
export const stashTabs: { key: StashTab; label: string }[] = [
  { key: 'outbounds', label: 'Outbounds' },
  { key: 'policyGroups', label: 'Policy groups' },
  { key: 'proxyChains', label: 'Proxy chains' },
];
export const primaryProxy = (outbound: Record<string, unknown>) =>
  jsonText(
    get(objectAt(outbound, 'proxySettings'), 'tag') ||
      get(objectAt(objectAt(outbound, 'streamSettings'), 'sockopt'), 'dialerProxy') ||
      '',
  );

export function chainPath(
  outbounds: Record<string, unknown>[],
  root: number,
  byTag = new Map(outbounds.map((item, index) => [get(item, 'tag'), index])),
) {
  const indices: number[] = [],
    visited = new Set<number>();
  let index = root,
    error = '';
  while (index >= 0 && index < outbounds.length) {
    if (visited.has(index)) {
      error = 'This proxy chain contains a loop.';
      break;
    }
    visited.add(index);
    indices.push(index);
    const next = primaryProxy(outbounds[index]);
    if (!next) break;
    index = byTag.get(next) ?? -1;
    if (index < 0) error = `Next outbound is unavailable: ${next}`;
  }
  return { indices, error };
}

export function setNextProxy(outbound: Record<string, unknown>, tag: string) {
  const legacy = objectAt(outbound, 'proxySettings'),
    stream = objectAt(outbound, 'streamSettings'),
    sockopt = objectAt(stream, 'sockopt');
  if (get(legacy, 'tag')) {
    let next = setProperty(outbound, 'proxySettings', setProperty(legacy, 'tag', tag || undefined));
    if (get(sockopt, 'dialerProxy') !== undefined)
      next = setProperty(
        next,
        'streamSettings',
        setProperty(stream, 'sockopt', setProperty(sockopt, 'dialerProxy', undefined)),
      );
    return next;
  }
  return setProperty(
    outbound,
    'streamSettings',
    setProperty(stream, 'sockopt', setProperty(sockopt, 'dialerProxy', tag || undefined)),
  );
}

export function configuredOutbounds(view: RemoteView) {
  const value = get(view.original, 'outbounds');
  return jsonArray(value) ? value.filter(jsonRecord) : [];
}
export function stashNodes(view: RemoteView, tab: StashTab): ViewNode[] {
  return view.nodes.filter((node) =>
    tab === 'policyGroups'
      ? node.id.startsWith('native-balancer-')
      : node.id.startsWith('native-out-') &&
        (tab === 'outbounds' || (jsonRecord(node.data.raw) && !!primaryProxy(node.data.raw))),
  );
}
export function applyChain(config: Record<string, unknown>, outbounds: Record<string, unknown>[]) {
  return setProperty(cloneJson(config), 'outbounds', outbounds);
}
