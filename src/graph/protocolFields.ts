import { protocolSource } from './protocolSource';
import { jsonRecord, jsonArray } from './xrayJson';
import type { NativeField } from './nativeFields';
import type { ProtocolSpec } from './protocols';
type Structure = keyof typeof protocolSource;
export interface ProtocolField extends NativeField {
  context: 'protocol';
  structure?: Structure;
  collection?: boolean;
  jsonShape?: 'array' | 'object';
  secret?: boolean;
}
const titles: Record<string, string> = {
  id: 'User ID / UUID',
  auth: 'Authentication token',
  useSystemCA: 'Use system certificate authorities',
  warp: 'Cloudflare WARP',
  xmux: 'Connection multiplexing',
  pass: 'Password',
  user: 'Username',
  mtu: 'MTU (bytes)',
  desc: 'Adapter description',
  remoteDNS: 'Remote DNS servers',
  udp: 'Enable UDP relay',
  ip: 'Advertised UDP relay IP',
  decryption: 'VLESS decryption',
  encryption: 'VLESS encryption',
  flow: 'VLESS flow',
  testseed: 'Test seed (JSON)',
  noKernelTun: 'Use userspace network stack',
  keepAlive: 'Keepalive (seconds)',
  level: 'Policy level',
  userLevel: 'Policy level',
  allowedIPs: 'Allowed IPs / CIDRs',
  rewriteAddress: 'Rewrite destination address',
  rewritePort: 'Rewrite destination port',
  rewriteNetwork: 'Rewrite network',
  allowedNetwork: 'Accepted networks',
  qType: 'DNS request types',
  rCode: 'DNS response code',
  autoSystemRoutingTable: 'Automatic system routes',
  autoOutboundsInterface: 'Outbound interface',
  autoSystemDnsToGateway: 'Use gateway for system DNS',
  autoSystemWfpBlockLeak: 'Windows WFP leak prevention',
};
const selectors: Record<string, string[]> = {
  method: [
    'aes-128-gcm',
    'aes-256-gcm',
    'chacha20-poly1305',
    'xchacha20-poly1305',
    '2022-blake3-aes-128-gcm',
    '2022-blake3-aes-256-gcm',
    '2022-blake3-chacha20-poly1305',
    'none',
    'plain',
  ],
  security: ['auto', 'aes-128-gcm', 'chacha20-poly1305'],
  flow: ['', 'xtls-rprx-vision'],
  nonIPQuery: ['drop', 'skip'],
  action: ['direct', 'drop', 'return', 'hijack'],
  auth: ['noauth', 'password'],
};
const arrayChildren: Record<string, Structure> = {
  VLessInboundConfig: 'VLessUserConfig',
  VMessInboundConfig: 'VMessUserConfig',
};
export function fieldsForStructure(structure: Structure): ProtocolField[] {
  return protocolSource[structure].fields.map((source) => {
    const go = source.goType.replace(/^\*/, ''),
      childName = go.replace(/^\[\]/, '').replace(/^\*/, '') as Structure;
    const field: ProtocolField = {
      key: source.key,
      label:
        titles[source.key] ??
        source.key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()),
      type: 'text',
      context: 'protocol',
      coreKey: structure + '.' + source.key,
    };
    if (structure === 'FinalMask' && ['tcp', 'udp'].includes(source.key))
      field.label = source.key === 'tcp' ? 'TCP masks' : 'UDP masks';
    if (go === 'bool') field.type = 'boolean';
    else if (/^(?:u?int(?:8|16|32|64)?|byte)$/.test(go)) {
      field.type = 'integer';
      field.min =
        go.startsWith('u') || go === 'byte'
          ? 0
          : -(2 ** (Number(go.match(/\d+/)?.[0] ?? '32') - 1));
      field.max = Math.min(
        Number.MAX_SAFE_INTEGER,
        go === 'byte'
          ? 255
          : 2 ** (Number(go.match(/\d+/)?.[0] ?? '32') - (go.startsWith('u') ? 0 : 1)) - 1,
      );
    } else if (go === '[]string' || go === 'StringList') {
      field.type = 'list';
    } else if (go === 'string' || go === 'Address') {
      if (
        selectors[source.key] &&
        (!['method', 'security', 'auth'].includes(source.key) ||
          (source.key === 'method' && structure.startsWith('Shadowsocks')) ||
          (source.key === 'security' && structure.startsWith('VMess')) ||
          (source.key === 'auth' && structure === 'SocksServerConfig'))
      ) {
        field.type = 'select';
        field.options = selectors[source.key];
      }
    } else {
      field.type = 'json';
      if (go.startsWith('[]')) field.jsonShape = 'array';
      else if (go.startsWith('map[')) field.jsonShape = 'object';
    }
    if (childName in protocolSource) {
      field.structure = childName;
      field.collection = go.startsWith('[]');
      field.type = 'json';
      field.jsonShape = field.collection ? 'array' : 'object';
    }
    if (arrayChildren[structure] && ['users', 'clients'].includes(source.key)) {
      field.structure = arrayChildren[structure];
      field.collection = true;
    }
    if (go === '[]json.RawMessage' && structure === 'VMessOutboundTarget') {
      field.structure = 'VMessUserConfig';
      field.collection = true;
    }
    if (go === '[]json.RawMessage' && structure === 'VLessOutboundVnext') {
      field.structure = 'VLessOutboundUserConfig';
      field.collection = true;
    }
    if (
      go === '[]json.RawMessage' &&
      ['HTTPRemoteConfig', 'SocksRemoteConfig'].includes(structure)
    ) {
      field.structure = structure === 'HTTPRemoteConfig' ? 'HTTPUserConfig' : 'SocksUserConfig';
      field.collection = true;
    }
    // []byte accepts a Base64 string or byte array in Go's JSON loader.
    if (go === '[]byte') delete field.jsonShape;
    field.secret =
      (/password|secretKey|preSharedKey|privateKey|mldsa65Seed|auth|pass|secrets/i.test(
        source.key,
      ) &&
        !['auth'].includes(source.key)) ||
      (source.key === 'auth' && structure !== 'SocksServerConfig');
    if (field.secret && field.type === 'text') field.type = 'password';
    if (source.key === 'port' || source.key === 'rewritePort') {
      field.min = 0;
      field.max = 65535;
    }
    return field;
  });
}
export function settingsFields(
  spec: ProtocolSpec,
  object: Record<string, unknown>,
): ProtocolField[] {
  const fields = fieldsForStructure(spec.structure),
    legacy = Object.keys(object).find(
      (k) => ['vnext', 'servers'].includes(k.toLowerCase()) && jsonArray(object[k]),
    );
  // The core's flat endpoint is authoritative when address is present. Keep an
  // existing endpoint list editable rather than silently flattening it.
  return fields.filter((field) => {
    if (
      spec.protocol === 'tun' &&
      ['autoSystemDnsToGateway', 'autoOutboundsInterface'].includes(field.key)
    )
      return false;
    if (
      ['users', 'clients'].includes(field.key) &&
      fields.some((f) => f.key === 'clients') &&
      Object.keys(object).some((k) => k.toLowerCase() === 'clients')
    )
      return field.key !== 'users';
    if (
      field.key === 'accounts' &&
      Object.keys(object).some((k) => k.toLowerCase() === 'users') &&
      !Object.keys(object).some((k) => k.toLowerCase() === 'accounts')
    )
      return false;
    if (
      field.key === 'users' &&
      fields.some((f) => f.key === 'accounts') &&
      Object.keys(object).some((k) => k.toLowerCase() === 'accounts')
    )
      return false;
    if (
      legacy &&
      !Object.keys(object).some((k) => k.toLowerCase() === 'address') &&
      spec.direction === 'outbound'
    )
      return ['vnext', 'servers', 'headers'].includes(field.key);
    if (!legacy && ['vnext', 'servers'].includes(field.key)) return false;
    return !(field.key === 'flow' && spec.protocol === 'trojan');
  });
}
export function structureProblems(
  structure: Structure,
  object: Record<string, unknown>,
  path = 'settings',
): string[] {
  const errors: string[] = [];
  for (const field of fieldsForStructure(structure)) {
    const key = Object.keys(object).find((k) => k.toLowerCase() === field.key.toLowerCase());
    if (key === undefined || object[key] === null) continue;
    const value = object[key],
      name = `${path}.${key}`;
    if (
      field.type === 'integer' &&
      (typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < (field.min ?? -Infinity) ||
        value > (field.max ?? Infinity))
    )
      errors.push(`${name} must be an integer from ${field.min} to ${field.max}.`);
    else if (field.type === 'boolean' && typeof value !== 'boolean')
      errors.push(`${name} must be boolean.`);
    else if (['text', 'password', 'select'].includes(field.type) && typeof value !== 'string')
      errors.push(`${name} must be text.`);
    else if (field.jsonShape === 'array' && !jsonArray(value))
      errors.push(`${name} must be an array.`);
    else if (field.jsonShape === 'object' && !jsonRecord(value))
      errors.push(`${name} must be an object.`);
    else if (field.structure) {
      if (field.collection && jsonArray(value)) {
        for (const [i, item] of value.entries())
          if (jsonRecord(item))
            errors.push(...structureProblems(field.structure, item, `${name}[${i}]`));
          else errors.push(`${name} entries must be objects.`);
      } else if (jsonRecord(value)) errors.push(...structureProblems(field.structure, value, name));
    }
  }
  return errors;
}
