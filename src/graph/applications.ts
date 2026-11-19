export * from '@wayrill/core/applications';
import { parseApplicationSelectors, type ApplicationSelector } from '@wayrill/core/applications';
import { jsonRecord, ownValue, parseJson } from './xrayJson';
import type { GraphState } from './types';

type PortableIdentity = { kind: 'package' | 'service'; value: string };
export type PoolExecutable = {
  name: string;
  originalName?: string;
  product?: string;
  company?: string;
  signer?: string;
  relativePath?: string;
};
export type PoolApplicationIdentity = {
  id: string;
  name: string;
  identities: PortableIdentity[];
  executable?: PoolExecutable;
  requireLocal?: true;
};
export type PoolApplicationSelector = {
  kind: 'pool';
  identity: PoolApplicationIdentity;
  children: boolean;
  enabled: boolean;
};
export type RuleApplication = ApplicationSelector | PoolApplicationSelector;
export type PoolApplicationBinding = { kind: ApplicationSelector['kind']; value: string };
export type PoolApplicationBindings = Record<string, PoolApplicationBinding>;
export type PoolApplicationChanges = Record<string, PoolApplicationBinding | null>;
export type PoolApplicationDetection = Record<string, { path?: string; candidates: string[] }>;

export function effectivePoolApplications(graph: GraphState): PoolApplicationBindings | undefined {
  return graph.poolAutomaticApplications
    ? { ...graph.poolAutomaticApplications, ...graph.poolApplicationBindings }
    : graph.poolApplicationBindings;
}

export function readPoolExecutable(raw: unknown): PoolExecutable {
  if (!jsonRecord(raw)) throw new Error('Invalid executable identity.');
  const { name } = raw;
  if (
    typeof name !== 'string' ||
    !/^[^<>:"/\\|?*]+\.exe$/i.test(name) ||
    name.length > 255 ||
    [...name].some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error('Enter an executable filename such as Example.exe.');
  const descriptor: PoolExecutable = { name };
  for (const key of ['originalName', 'product', 'company', 'signer', 'relativePath'] as const) {
    const value = ownValue(raw, key);
    if (value === undefined) continue;
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > 512 ||
      [...value].some((char) => char.charCodeAt(0) < 32)
    )
      throw new Error('Invalid executable identity metadata.');
    if (
      key === 'relativePath' &&
      (/[<>:"|?*\\]/.test(value) ||
        value.split('/').some((part) => !part || part === '.' || part === '..') ||
        value.split('/').at(-1)?.toLowerCase() !== name.toLowerCase())
    )
      throw new Error('Invalid relative executable path.');
    descriptor[key] = value;
  }
  return descriptor;
}

const applicationId = (value: string) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

export function readPoolApplication(raw: unknown): PoolApplicationIdentity {
  if (
    !jsonRecord(raw) ||
    typeof raw.id !== 'string' ||
    !applicationId(raw.id) ||
    typeof raw.name !== 'string' ||
    !raw.name.trim() ||
    raw.name.length > 128 ||
    !Array.isArray(raw.identities) ||
    raw.identities.length > 32 ||
    (raw.requireLocal !== undefined && (raw.requireLocal !== true || raw.identities.length > 0))
  )
    throw new Error('Invalid app identity. Use a name and up to 32 Windows identities.');
  const identities = raw.identities.map((item): PortableIdentity => {
    const binding = readApplicationBinding(item);
    if (binding.kind === 'process')
      throw new Error('App identities cannot include local executable paths.');
    return { kind: binding.kind, value: binding.value };
  });
  return {
    id: raw.id,
    name: raw.name.trim(),
    identities,
    ...(raw.executable !== undefined && { executable: readPoolExecutable(raw.executable) }),
    ...(raw.requireLocal === true ? { requireLocal: true } : {}),
  };
}

function readApplicationBinding(raw: unknown): PoolApplicationBinding {
  if (!jsonRecord(raw) || typeof raw.value !== 'string')
    throw new Error('Invalid Windows app binding.');
  const value = raw.value.trim();
  switch (raw.kind) {
    case 'process':
      parseApplicationSelectors([
        { kind: 'process', value, mode: 'path', enabled: true, children: false },
      ]);
      return { kind: 'process', value };
    case 'package':
      if (!/^[a-z0-9.-]{3,50}_[a-z0-9]{13}$/i.test(value))
        throw new Error('Enter a Windows Package Family Name.');
      return { kind: 'package', value };
    case 'service':
      if (
        !value ||
        value.length > 256 ||
        /[\\/]/.test(value) ||
        [...value].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error('Enter the internal Windows service name.');
      return { kind: 'service', value };
    default:
      throw new Error('Choose a Windows package, service, or executable.');
  }
}

function readBindingEntries(raw: unknown) {
  if (!jsonRecord(raw) || Object.keys(raw).length > 1024)
    throw new Error('Use at most 1,024 local Pool application bindings.');
  return Object.entries(raw).map(([id, value]) => {
    if (!applicationId(id)) throw new Error('Invalid Pool application ID.');
    return [id, value === null ? null : readApplicationBinding(value)] as const;
  });
}

export function readPoolApplicationBindings(raw: unknown): PoolApplicationBindings {
  return Object.fromEntries(
    readBindingEntries(raw).flatMap(([id, value]) => (value ? [[id, value]] : [])),
  );
}

export function updatePoolApplicationBindings(
  bindings: PoolApplicationBindings = {},
  changes?: PoolApplicationChanges,
): PoolApplicationBindings {
  return changes
    ? readPoolApplicationBindings({
        ...bindings,
        ...Object.fromEntries(readBindingEntries(changes)),
      })
    : bindings;
}

export function readRuleApplications(raw: unknown): RuleApplication[] {
  if (!Array.isArray(raw) || raw.length > 4096)
    throw new Error('Choose at most 4,096 application selectors.');
  const ordinary = raw.filter((row: unknown) => !jsonRecord(row) || row.kind !== 'pool');
  parseApplicationSelectors(ordinary);
  return raw.map((row: RuleApplication) => {
    if (row.kind !== 'pool') return row;
    if (typeof row.children !== 'boolean' || typeof row.enabled !== 'boolean')
      throw new Error('Invalid Pool application rule.');
    return {
      kind: 'pool',
      identity: readPoolApplication(row.identity),
      children: row.children,
      enabled: row.enabled,
    };
  });
}

export function readApplicationIdentity(text: string): PoolApplicationIdentity {
  if (text.length > 65536) throw new Error('Application identity files must be under 64 KiB.');
  const file = parseJson(text);
  if (!jsonRecord(file) || file.format !== 'wayrill.app-identity' || file.version !== 1)
    throw new Error('Choose a Wayrill application identity file.');
  return readPoolApplication(file.identity);
}

export function writeApplicationIdentity(identity: PoolApplicationIdentity) {
  return (
    JSON.stringify(
      {
        format: 'wayrill.app-identity',
        version: 1,
        identity: readPoolApplication(identity),
      },
      null,
      2,
    ) + '\n'
  );
}
