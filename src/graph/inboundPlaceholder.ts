import type { NodeDefinition, RuleNodeData } from './types';

export const placeholderKind = 'inbound-placeholder' as const;
export type CapturePlaceholder = 'proxy' | 'tun';
export const capturePlaceholder = (data: RuleNodeData): CapturePlaceholder | undefined =>
  data.kind === placeholderKind &&
  (data.settings.captureKind === 'proxy' || data.settings.captureKind === 'tun')
    ? data.settings.captureKind
    : undefined;

export const placeholderDefinition: NodeDefinition = {
  kind: placeholderKind,
  title: 'Inbound Placeholder',
  group: 'Inbounds',
  category: 'inbound',
  summary: 'Subscribers assign local capture or an inbound to this entry.',
  defaults: { captureKind: 'any', dns: true, encryptedDns: false, nat: false },
  fields: [
    {
      key: 'captureKind',
      label: 'Local capture',
      type: 'select',
      defaultValue: 'any',
      optional: true,
      options: ['any', 'proxy', 'tun'],
      optionLabels: { any: 'Any inbound', proxy: 'Proxy', tun: 'TUN' },
    },
    { key: 'dns', label: 'DNS output', type: 'boolean', defaultValue: true },
    { key: 'encryptedDns', label: 'Encrypted DNS output', type: 'boolean', defaultValue: false },
    { key: 'nat', label: 'Separate NAT outputs', type: 'boolean', defaultValue: false },
  ],
};

export function placeholderPorts(data: RuleNodeData): string[] {
  return [
    'data',
    ...(data.settings.dns ? ['dns'] : []),
    ...(data.settings.encryptedDns ? ['encrypted-dns'] : []),
    ...(data.settings.nat ? ['nat-data', 'nat-dns'] : []),
  ];
}
