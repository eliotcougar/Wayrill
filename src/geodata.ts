import { createContext } from 'react';
import {
  factoryResources,
  resourceFilename,
  resourceSourceName,
  type ResourceKind,
  type ResourceSet,
} from './graph/resources';

export const GeoResourcesContext = createContext<ResourceSet>(factoryResources());

export type GeoSource = { file: string; label: string; prefix: string };
export type GeoGroup = { code: string; count: number };
export type GeoEntry = { value: string | null; preview: string };
export type GeoPage = {
  ready: boolean;
  version?: string;
  total?: number;
  offset?: number;
  rows?: (GeoGroup | GeoEntry)[];
  group?: { count: number; attributes: string[]; inverse: boolean } | null;
};
export type GeoSelection = {
  file: string;
  prefix: string;
  group: string;
  attributes: string[];
  inverse: boolean;
  cidr: string;
};

/** Mirrors the embedded core's common/geodata/rule_parser.go, not Lua syntax. */
export function parseGeoExpression(expression: string, sources: GeoSource[], kind: ResourceKind) {
  let text = expression.trim();
  if (!text) return { error: '' };
  if (text.length > 4096 || /[\r\n\0]/.test(text))
    return { error: 'Enter one expression, up to 4,096 characters.' };
  const value: GeoSelection = {
    file: sources[0].file,
    prefix: '',
    group: '',
    attributes: [],
    inverse: false,
    cidr: '',
  };
  if (kind === 'geoip') {
    const bangs = text.match(/^!*/)?.[0].length ?? 0;
    value.inverse = bangs % 2 === 1;
    text = text.slice(bangs);
  }
  if (text.startsWith(`${kind}:`)) {
    value.prefix = `${kind}:`;
    text = text.slice(value.prefix.length);
  } else {
    const ext = (
      kind === 'geosite' ? /^(ext|ext-domain|ext-site):([^:]+):/ : /^(ext|ext-ip):([^:]+):/
    ).exec(text);
    if (ext) {
      const source = sources.find((s) => s.file === ext[2] || s.prefix === `ext:${ext[2]}:`);
      if (!source) return { error: 'Choose a configured or packaged resource file.' };
      value.file = source.file;
      value.prefix = ext[0];
      text = text.slice(ext[0].length);
    } else if (kind === 'geoip' && !/^(?:geo\w*|ext\w*):/.test(text)) {
      // The service validates IPv4/IPv6 and CIDR widths without using a JS approximation.
      value.cidr = text;
      return { value };
    } else return { error: `Use ${kind}:group or ext:file.dat:group.` };
  }
  if (kind === 'geoip') {
    const bangs = text.match(/^!*/)?.[0].length ?? 0;
    value.inverse = value.inverse !== (bangs % 2 === 1);
    value.group = text.slice(bangs);
    if (!value.group || value.group.includes('@'))
      return { error: 'Enter a GeoIP group without attributes.' };
  } else {
    const [group, ...attributes] = text.split('@');
    if (!group || attributes.some((a) => !a))
      return { error: 'Enter a group and non-empty attributes.' };
    value.group = group;
    // Xray lowercases requested attributes; DAT keys themselves remain case-sensitive.
    value.attributes = [...new Set(attributes.map((a) => a.toLowerCase()))];
  }
  if (
    value.group.length > 128 ||
    value.attributes.length > 256 ||
    value.attributes.some((a) => a.length > 128)
  )
    return { error: 'The group or attribute selection is too long.' };
  return { value };
}
export function geoExpression(value: GeoSelection) {
  return value.cidr
    ? `${value.inverse ? '!' : ''}${value.cidr}`
    : `${value.prefix}${value.inverse ? '!' : ''}${value.group}${value.attributes.map((a) => `@${a}`).join('')}`;
}
/** Prefer the cursor line, then its nearest preceding reference, then the next one. */
export function geoExpressionAtCursor(text: string, cursor: number, kind: ResourceKind) {
  const normalized = text.replace(/\r\n?/g, '\n');
  const offset = Math.max(0, Math.min(normalized.length, cursor));
  const before = normalized.slice(0, offset).split('\n');
  const lines = normalized.split('\n');
  const line = before.length - 1;
  const eligible = (text: string) =>
    kind === 'geosite'
      ? /^(geosite:|ext:|ext-domain:|ext-site:)/.test(text)
      : /^!*(geoip:|ext:|ext-ip:)/.test(text);
  const current = lines[line]?.trim() ?? '';
  if (eligible(current)) return current;
  for (let i = line - 1; i >= 0; i--) if (eligible(lines[i].trim())) return lines[i].trim();
  for (let i = line + 1; i < lines.length; i++)
    if (eligible(lines[i].trim())) return lines[i].trim();
  return '';
}
export function geoSources(set: ResourceSet, kind: ResourceKind): GeoSource[] {
  const primary = set.files.find((file) => file.kind === kind && file.enabled);
  const result: GeoSource[] = primary
    ? [
        {
          file: resourceFilename(primary),
          label: `Default · ${primary.name} · ${resourceSourceName(primary)}`,
          prefix: `${kind}:`,
        },
      ]
    : [];
  for (const extra of set.files.filter((e) => e.kind === kind && e !== primary)) {
    result.push({
      file: resourceFilename(extra),
      label: `${extra.name} · ${resourceSourceName(extra)}`,
      prefix: `ext:${extra.name}:`,
    });
  }
  for (const [prefix, label] of [
    ['', 'XTLS'],
    ['ru-', 'RunetFreedom'],
    ['ir-', 'Chocolate4U'],
    ['cn-', 'Loyalsoldier'],
  ]) {
    const file = `${prefix}${kind}.dat`;
    if (!result.some((s) => s.file === file))
      result.push({ file, label: `${file} · ${label}`, prefix: `ext:${file}:` });
  }
  return result;
}
/** Textarea offsets are UTF-16 positions in its normalized LF value. */
export function insertAfterCursorLine(text: string, cursor: number, entry: string) {
  const value = text.replace(/\r\n?/g, '\n');
  const pos = Number.isFinite(cursor)
    ? Math.max(0, Math.min(value.length, Math.trunc(cursor)))
    : value.length;
  const end = value.indexOf('\n', pos);
  const start = end < 0 ? value.length + (value.length && !value.endsWith('\n') ? 1 : 0) : end + 1;
  const before = end < 0 ? value + (start > value.length ? '\n' : '') : value.slice(0, start);
  const after = end < 0 ? '' : value.slice(start);
  return { value: `${before}${entry}\n${after}`, cursor: start + entry.length };
}
