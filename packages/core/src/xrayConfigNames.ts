import { jsonRecord, parseXrayJson, jsonArray } from './xrayJson';
import { nativeValue as field } from './nativeProperties';

/** The caller supplies the schema generated from its own pinned Xray source. */
interface XrayNameSchema {
  structures: Record<string, Record<string, string>>;
  protocols: { inbound: Record<string, string>; outbound: Record<string, string> };
  masks: Record<string, Record<string, string>>;
}

/** A property-name correction; values and user-defined dictionary keys never change. */
export interface XrayNameCorrection {
  path: string;
  from: string;
  to: string;
}
interface Change extends XrayNameCorrection {
  parts: string[];
}

export function createXrayNameTools(source: XrayNameSchema, maxConfigBytes: number) {
  const schemas = source.structures;
  const lookups = new Map(
    Object.entries(schemas).map(([name, fields]) => [
      name,
      new Map(Object.keys(fields).map((key) => [key.toLowerCase(), key])),
    ]),
  );
  const pointer = (parts: string[]) =>
    '/' + parts.map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
  const accounts: Record<string, string> = {
    VLessInboundConfig: 'VLessUserConfig',
    VLessOutboundVnext: 'VLessOutboundUserConfig',
    VMessInboundConfig: 'VMessUserConfig',
    VMessOutboundTarget: 'VMessUserConfig',
    HTTPRemoteConfig: 'HTTPUserConfig',
    SocksRemoteConfig: 'SocksUserConfig',
  };

  function childType(
    structure: string,
    key: string,
    value: Record<string, unknown>,
    path: string[],
  ): string {
    if (key === 'settings' && ['InboundDetourConfig', 'OutboundDetourConfig'].includes(structure)) {
      const protocols: Record<string, string> =
        source.protocols[structure === 'InboundDetourConfig' ? 'inbound' : 'outbound'];
      const protocol = field(value, 'protocol');
      return typeof protocol === 'string' ? (protocols[protocol.toLowerCase()] ?? '') : '';
    }
    if (structure === 'RouterConfig' && key === 'rules') return '[]RawFieldRule';
    if (structure === 'StrategyConfig' && key === 'settings')
      return String(field(value, 'type')).toLowerCase() === 'leastload'
        ? 'strategyLeastLoadConfig'
        : '';
    if (structure === 'SplitHTTPConfig' && key === 'extra') return 'SplitHTTPConfig';
    if (structure === 'TCPConfig' && key === 'header') {
      const header = field(value, key);
      return jsonRecord(header) && String(field(header, 'type')).toLowerCase() === 'http'
        ? 'HTTPHeader'
        : 'HeaderType';
    }
    if (key === 'settings' && (structure === 'Mask' || structure === 'XDNSResolver')) {
      const kind = structure === 'XDNSResolver' ? 'xdns' : path.at(-2)?.toLowerCase();
      return source.masks[kind ?? '']?.[String(field(value, 'type')).toLowerCase()] ?? '';
    }
    if ((key === 'users' || key === 'clients') && accounts[structure])
      return '[]' + accounts[structure];
    if (
      key === 'reverse' &&
      ['VLessUserConfig', 'VLessOutboundUserConfig', 'VLessOutboundConfig'].includes(structure)
    )
      return 'AccountReverse';
    return schemas[structure]?.[key] ?? '';
  }

  function changesIn(value: unknown): Change[] {
    if (!jsonRecord(value)) throw new Error('Supply a complete Xray JSON object.');
    const changes: Change[] = [];
    function visit(value: unknown, type: string, path: string[]): void {
      type = type.replace(/^\*+/, '');
      if (type === 'FakeDNSConfig') {
        visit(
          value,
          jsonArray(value) ? '[]FakeDNSPoolElementConfig' : 'FakeDNSPoolElementConfig',
          path,
        );
        return;
      }
      if (type.startsWith('[]')) {
        if (jsonArray(value))
          value.forEach((entry, i) => visit(entry, type.slice(2), [...path, String(i)]));
        return;
      }
      const map = /^map\[[^\]]+\](.+)$/.exec(type);
      if (map) {
        if (jsonRecord(value))
          for (const [key, entry] of Object.entries(value)) visit(entry, map[1], [...path, key]);
        return;
      }
      const names = lookups.get(type);
      if (!names || !jsonRecord(value)) return;
      const matched = new Map<string, string>();
      for (const key of Object.keys(value)) {
        const canonical = names.get(key.toLowerCase());
        if (!canonical) continue;
        const previous = matched.get(canonical);
        if (previous !== undefined)
          throw new Error(
            `Ambiguous Xray fields at ${pointer(path)}: "${previous}" and "${key}" both refer to "${canonical}". Resolve the duplicate names before fixing capitalization.`,
          );
        matched.set(canonical, key);
      }
      for (const [canonical, key] of matched) {
        const parts = [...path, key];
        if (key !== canonical)
          changes.push({ path: pointer(parts), from: key, to: canonical, parts });
        visit(value[key], childType(type, canonical, value, path), parts);
      }
    }
    visit(value, 'Config', []);
    return changes;
  }

  function inspectXrayCapitalization(text: string): XrayNameCorrection[] {
    return changesIn(parseXrayJson(text, undefined, maxConfigBytes)).map(({ path, from, to }) => ({
      path,
      from,
      to,
    }));
  }

  /** Replace only recognized name tokens, retaining JSONC comments/spacing and every value. */
  function fixXrayCapitalization(text: string): {
    text: string;
    changes: XrayNameCorrection[];
  } {
    const changes = changesIn(parseXrayJson(text, undefined, maxConfigBytes));
    if (!changes.length) return { text, changes: [] };
    const byPath = new Map(changes.map((change) => [JSON.stringify(change.parts), change.to]));
    const edits: { start: number; end: number; name: string }[] = [];
    parseXrayJson(
      text,
      (token) => {
        const name = byPath.get(JSON.stringify([...token.path, token.key]));
        if (name !== undefined) edits.push({ start: token.start, end: token.end, name });
      },
      maxConfigBytes,
    );
    if (edits.length !== changes.length)
      throw new Error('Could not safely locate every field name.');
    const chunks: string[] = [];
    let end = 0;
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
      chunks.push(text.slice(end, edit.start), JSON.stringify(edit.name));
      end = edit.end;
    }
    chunks.push(text.slice(end));
    return {
      text: chunks.join(''),
      changes: changes.map(({ path, from, to }) => ({ path, from, to })),
    };
  }

  return { inspectXrayCapitalization, fixXrayCapitalization };
}
