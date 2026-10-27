import { jsonArray, jsonRecord } from './xrayJson';
import { parseApplicationSelectors, type ApplicationSelector } from './applications';
import type { TableRule } from './rules';

export type SourceRule = Omit<TableRule, 'id' | 'source'>;
export interface ListEdits {
  added: string[];
  removed: string[];
}
export interface RuleEdits {
  fields?: Partial<Pick<SourceRule, 'name' | 'enabled' | 'output' | 'matchAll' | 'targetMatch'>>;
  conditions?: Record<string, string | null>;
  domain?: ListEdits;
  ip?: ListEdits;
  applications?: { added: ApplicationSelector[]; removed: string[] };
}
export interface SourceRow {
  identity?: string;
  named: boolean;
  role: string;
  base: SourceRule;
  edits: RuleEdits;
  missing?: boolean;
}
export interface TrafficSource {
  version: 1;
  kind: 'url' | 'file';
  location: string;
  allowHttp: boolean;
  viaWayrill: boolean;
  updatedAt: string;
  bindings: Record<string, string>;
}
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0');
const strings = (value: unknown, max = 16384): value is string[] =>
  jsonArray(value) && value.length <= 4096 && value.every((v) => text(v, max));
export function validateTrafficSource(raw: unknown): TrafficSource {
  if (
    !jsonRecord(raw) ||
    raw.version !== 1 ||
    !['url', 'file'].includes(String(raw.kind)) ||
    !text(raw.location, 32768) ||
    !raw.location.trim() ||
    typeof raw.allowHttp !== 'boolean' ||
    typeof raw.viaWayrill !== 'boolean' ||
    !text(raw.updatedAt, 64) ||
    !Number.isFinite(Date.parse(raw.updatedAt)) ||
    !jsonRecord(raw.bindings) ||
    Object.keys(raw.bindings).length > 128 ||
    Object.entries(raw.bindings).some(([key, value]) => !text(key, 512) || !text(value, 128))
  )
    throw new Error('Invalid traffic filter source.');
  if (raw.kind === 'url') {
    let url: URL;
    try {
      url = new URL(raw.location);
    } catch {
      throw new Error('Invalid traffic filter source URL.');
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol === 'http:' && !raw.allowHttp)
    )
      throw new Error('Invalid traffic filter source URL.');
  }
  return raw as unknown as TrafficSource;
}
export function validateSourceRow(
  raw: unknown,
  validateBase: (base: SourceRule) => void,
  conditionKeys: ReadonlySet<string>,
): SourceRow {
  if (
    !jsonRecord(raw) ||
    typeof raw.named !== 'boolean' ||
    !text(raw.role, 512) ||
    (raw.identity !== undefined && (!text(raw.identity, 512) || !raw.identity.trim())) ||
    (raw.missing !== undefined && typeof raw.missing !== 'boolean') ||
    !jsonRecord(raw.base) ||
    raw.base.source !== undefined ||
    raw.base.id !== undefined ||
    !jsonRecord(raw.edits)
  )
    throw new Error('Invalid sourced traffic rule.');
  validateBase(raw.base as unknown as SourceRule);
  const edits = raw.edits;
  if (
    Object.keys(edits).some(
      (key) => !['fields', 'conditions', 'domain', 'ip', 'applications'].includes(key),
    )
  )
    throw new Error('Invalid traffic rule edits.');
  if (edits.fields !== undefined) {
    if (!jsonRecord(edits.fields)) throw new Error('Invalid traffic rule edits.');
    for (const [key, value] of Object.entries(edits.fields)) {
      if (key === 'enabled' || key === 'matchAll') {
        if (typeof value !== 'boolean') throw new Error('Invalid traffic rule switch.');
      } else if (key === 'targetMatch') {
        if (!['any', 'all'].includes(String(value)))
          throw new Error('Invalid traffic matching mode.');
      } else if (!['name', 'output'].includes(key) || !text(value, 128))
        throw new Error('Invalid traffic rule field override.');
    }
  }
  if (
    edits.conditions !== undefined &&
    (!jsonRecord(edits.conditions) ||
      Object.entries(edits.conditions).some(
        ([key, value]) =>
          !conditionKeys.has(key) ||
          ['domain', 'ip', 'process'].includes(key) ||
          (value !== null && !text(value, 16384)),
      ))
  )
    throw new Error('Invalid traffic condition override.');
  for (const key of ['domain', 'ip']) {
    const list = edits[key];
    if (list !== undefined && (!jsonRecord(list) || !strings(list.added) || !strings(list.removed)))
      throw new Error('Invalid local domain or IP entries.');
  }
  if (edits.applications !== undefined) {
    if (!jsonRecord(edits.applications) || !strings(edits.applications.removed, 8192))
      throw new Error('Invalid local process entries.');
    parseApplicationSelectors(edits.applications.added);
  }
  return raw as unknown as SourceRow;
}
