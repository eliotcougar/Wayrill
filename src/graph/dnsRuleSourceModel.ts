import { jsonRecord } from './xrayJson';
import type { DnsRoute } from './dns';
import type { ListEdits } from './ruleSourceModel';

export type DnsSourceRule = Omit<DnsRoute, 'id' | 'source'>;
export const dnsSourceLists = ['domains', 'expectedIPs', 'unexpectedIPs'] as const;
export const dnsSourceFields = ['name', 'enabled', 'output', 'skipFallback', 'finalQuery'] as const;
export interface DnsSourceRow {
  identity: string;
  role: string;
  base: DnsSourceRule;
  edits: {
    fields?: Partial<Pick<DnsSourceRule, (typeof dnsSourceFields)[number]>>;
    lists?: Partial<Record<(typeof dnsSourceLists)[number], ListEdits>>;
  };
  missing?: boolean;
}
const text = (value: unknown, max = 16384): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0');

export function validateDnsSourceRow(raw: unknown): DnsSourceRow {
  if (
    !jsonRecord(raw) ||
    !text(raw.identity, 128) ||
    !raw.identity ||
    !text(raw.role, 128) ||
    !jsonRecord(raw.base) ||
    raw.base.source !== undefined ||
    raw.base.id !== undefined ||
    !jsonRecord(raw.edits) ||
    (raw.missing !== undefined && typeof raw.missing !== 'boolean')
  )
    throw new Error('Invalid DNS preference source.');
  const base = raw.base;
  if (
    !text(base.name, 128) ||
    !text(base.output, 128) ||
    ['enabled', 'skipFallback', 'finalQuery'].some((key) => typeof base[key] !== 'boolean') ||
    dnsSourceLists.some((key) => !text(base[key]))
  )
    throw new Error('Invalid source DNS preference.');
  if (Object.keys(raw.edits).some((key) => !['fields', 'lists'].includes(key)))
    throw new Error('Invalid DNS preference edits.');
  const { fields, lists } = raw.edits;
  if (
    fields !== undefined &&
    (!jsonRecord(fields) ||
      Object.entries(fields).some(([key, value]) =>
        key === 'name' || key === 'output'
          ? !text(value, 128)
          : !['enabled', 'skipFallback', 'finalQuery'].includes(key) || typeof value !== 'boolean',
      ))
  )
    throw new Error('Invalid DNS preference field override.');
  if (
    lists !== undefined &&
    (!jsonRecord(lists) ||
      Object.entries(lists).some(
        ([key, edit]) =>
          !dnsSourceLists.includes(key as (typeof dnsSourceLists)[number]) ||
          !jsonRecord(edit) ||
          ['added', 'removed'].some(
            (part) =>
              !Array.isArray(edit[part]) ||
              edit[part].length > 4096 ||
              !edit[part].every((value) => text(value)),
          ),
      ))
  )
    throw new Error('Invalid local DNS preference entries.');
  return raw as unknown as DnsSourceRow;
}
