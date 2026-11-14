import type { NodeDefinition, RuleNodeData } from './types';

export const placeholderKind = 'inbound-placeholder' as const;
export const placeholderDefinition: NodeDefinition = {
  kind: placeholderKind,
  title: 'Inbound Placeholder',
  group: 'Inbounds',
  category: 'inbound',
  summary: 'Subscribers assign local capture or an inbound to this entry.',
  defaults: { dns: true, encryptedDns: false, nat: false },
  fields: [
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
