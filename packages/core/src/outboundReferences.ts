import { cloneJson, jsonRecord, jsonText } from './xrayJson';
import { nativeKey, nativeValue } from './nativeProperties';

export interface OutboundReference {
  object: Record<string, unknown>;
  key: string;
  tag: string;
  namespace: 'inbound' | 'outbound';
  path: string[];
}

/** Stored subscription tags can name several profiles or a concrete graph
 * handler. Resolve only when exactly one destination owns the requested name. */
export class ProfileDialerTags {
  private readonly names = new Map<string, Set<string>>();

  add(source: string, target: string) {
    if (!source) return;
    const targets = this.names.get(source);
    if (targets) targets.add(target);
    else this.names.set(source, new Set([target]));
  }

  resolve(tag: string, hasExact: boolean, label: string): string {
    const targets = new Set(this.names.get(tag));
    if (hasExact) targets.add(tag);
    if (targets.size > 1)
      throw new Error(
        `${label}: dial-through tag ${tag} matches multiple selected configurations. Use distinct source tags.`,
      );
    for (const target of targets) return target;
    throw new Error(
      `${label}: dial-through destination ${tag} is missing from the outbound set and graph.`,
    );
  }
}

export interface OutboundStream {
  object: Record<string, unknown>;
  path: string[];
  /** With penetrate, the download transport uses its parent's socket settings. */
  socketOwner: Record<string, unknown>;
  socketPath: string[];
}

export function outboundStreams(
  outbound: Record<string, unknown>,
  mode: 'active' | 'all' = 'active',
): OutboundStream[] {
  const root = nativeValue(outbound, 'streamSettings');
  if (!jsonRecord(root)) return [];
  const path = [nativeKey(outbound, 'streamSettings')];
  const streams: OutboundStream[] = [{ object: root, path, socketOwner: root, socketPath: path }];
  for (const site of streams) {
    const { object, path } = site;
    if (
      mode === 'active' &&
      !['xhttp', 'splithttp'].includes(
        jsonText(nativeValue(object, 'method') ?? nativeValue(object, 'network')).toLowerCase(),
      )
    )
      continue;
    const modern = nativeValue(object, 'xhttpSettings');
    const transportKeys =
      mode === 'all'
        ? ['xhttpSettings', 'splithttpSettings']
        : [modern === undefined || modern === null ? 'splithttpSettings' : 'xhttpSettings'];
    for (const name of transportKeys) {
      const xhttp = nativeValue(object, name);
      if (!jsonRecord(xhttp)) continue;
      const xhttpPath = [...path, nativeKey(object, name)],
        extra = nativeValue(xhttp, 'extra');
      const sources =
        mode === 'all' || extra === undefined ? [{ object: xhttp, path: xhttpPath }] : [];
      if (jsonRecord(extra))
        sources.push({ object: extra, path: [...xhttpPath, nativeKey(xhttp, 'extra')] });
      for (const source of sources) {
        const download = nativeValue(source.object, 'downloadSettings');
        if (!jsonRecord(download)) continue;
        const downloadPath = [...source.path, nativeKey(source.object, 'downloadSettings')];
        const socket = nativeValue(site.socketOwner, 'sockopt');
        const inherited =
          mode === 'active' && jsonRecord(socket) && nativeValue(socket, 'penetrate') === true;
        streams.push({
          object: download,
          path: downloadPath,
          socketOwner: inherited ? site.socketOwner : download,
          socketPath: inherited ? site.socketPath : downloadPath,
        });
      }
    }
  }
  return streams;
}

/** Active references follow Xray precedence. Rewriting uses all stored transport
 * settings, including inactive ones, so switching transport later stays coherent.
 * Payloads, credentials, headers and selector queries are never references. */
export function outboundReferences(
  outbound: Record<string, unknown>,
  mode: 'active' | 'all' = 'active',
): OutboundReference[] {
  const refs: OutboundReference[] = [];
  const add = (
    object: Record<string, unknown>,
    name: string,
    namespace: OutboundReference['namespace'],
    path: string[],
  ) => {
    const actual = nativeKey(object, name),
      tag = object[actual];
    if (typeof tag === 'string' && tag)
      refs.push({ object, key: actual, tag, namespace, path: [...path, actual] });
  };
  const proxy = nativeValue(outbound, 'proxySettings');
  if (jsonRecord(proxy)) add(proxy, 'tag', 'outbound', [nativeKey(outbound, 'proxySettings')]);
  const settings = nativeValue(outbound, 'settings');
  if (
    jsonText(nativeValue(outbound, 'protocol')).toLowerCase() === 'loopback' &&
    jsonRecord(settings)
  )
    add(settings, 'inboundTag', 'inbound', [nativeKey(outbound, 'settings')]);
  for (const site of outboundStreams(outbound, mode)) {
    const sock = nativeValue(site.socketOwner, 'sockopt');
    if (jsonRecord(sock))
      add(sock, 'dialerProxy', 'outbound', [
        ...site.socketPath,
        nativeKey(site.socketOwner, 'sockopt'),
      ]);
  }
  return refs;
}

/** The caller owns this JSON object. Remaps are simultaneous, including tag swaps. */
export function remapOutboundReferences(
  outbound: Record<string, unknown>,
  outputs: ReadonlyMap<string, string>,
  inputs: ReadonlyMap<string, string> = new Map(),
): void {
  for (const ref of outboundReferences(outbound, 'all'))
    ref.object[ref.key] = (ref.namespace === 'outbound' ? outputs : inputs).get(ref.tag) ?? ref.tag;
}

/** Copy an executable bundle into a new tag namespace. Only active, external
 * dependencies need resolution against the containing policy group. */
export function copyOutboundBundle(
  bundle: Record<string, unknown>[],
  rename: ReadonlyMap<string, string>,
  resolveExternal?: (tag: string) => string,
): Record<string, unknown>[] {
  const internal = new Set(bundle.map((o) => String(o.tag)));
  return bundle.map((outbound) => {
    const copy = cloneJson(outbound);
    const active = resolveExternal
      ? outboundReferences(copy).filter(
          (ref) => ref.namespace === 'outbound' && !internal.has(ref.tag),
        )
      : [];
    copy.tag = rename.get(String(outbound.tag)) ?? outbound.tag;
    if (rename.size) remapOutboundReferences(copy, rename);
    if (resolveExternal) for (const ref of active) ref.object[ref.key] = resolveExternal(ref.tag);
    return copy;
  });
}

/** Attach each independently dialed socket to the previous chain hop. */
export function attachChainUnderlay(
  config: Record<string, unknown>,
  internal: ReadonlySet<string>,
  underlay: string,
  label: string,
) {
  if (
    outboundReferences(config).some((ref) => ref.namespace === 'outbound' && !internal.has(ref.tag))
  )
    throw new Error(
      label + ': remove its existing external dial-through setting before using it as a chain hop.',
    );
  const proxy = nativeValue(config, 'proxySettings');
  if (jsonRecord(proxy) && nativeValue(proxy, 'tag')) return;
  const streamKey = nativeKey(config, 'streamSettings');
  if (!jsonRecord(config[streamKey])) config[streamKey] = {};
  for (const { socketOwner } of outboundStreams(config)) {
    const key = nativeKey(socketOwner, 'sockopt');
    const stored = socketOwner[key];
    const sock = jsonRecord(stored) ? stored : (socketOwner[key] = {});
    if (!nativeValue(sock, 'dialerProxy')) sock[nativeKey(sock, 'dialerProxy')] = underlay;
  }
}
