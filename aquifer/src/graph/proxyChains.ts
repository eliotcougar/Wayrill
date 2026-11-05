import { validPolicyReference, type PolicyReference } from './policySources';
import { jsonRecord, checkJson, jsonArray, parseJson } from './xrayJson';
import type { RuleNodeData, NodeDefinition, Diagnostic } from './types';
export interface ChainStep {
  id: string;
  outbound: PolicyReference;
}
export interface ProxyChain {
  version: 1;
  steps: ChainStep[];
}
export const emptyProxyChain = (): ProxyChain => ({ version: 1, steps: [] });
export const isCompositeKind = (kind: string) => kind === 'policy-group' || kind === 'proxy-chain';
export const proxyChainDefinition: NodeDefinition = {
  kind: 'proxy-chain',
  title: 'Proxy chain',
  group: 'Outbounds',
  category: 'outbound',
  summary: 'Ordered reusable outbound hops',
  defaults: {
    tag: 'proxy-chain',
    steps: '{"version":1,"steps":[]}',
    observe: false,
    observationSettings: '',
  },
  fields: [
    { key: 'tag', label: 'Outbound tag', type: 'text', required: true, maxLength: 128 },
    {
      key: 'steps',
      label: 'Chain hops',
      type: 'json',
      jsonShape: 'object',
      maxLength: 64 * 1024 * 1024,
    },
    { key: 'observe', label: 'Use observation', type: 'boolean' },
    {
      key: 'observationSettings',
      label: 'Saved observation settings',
      type: 'json',
      jsonShape: 'object',
      maxLength: 65536,
    },
  ],
};
export function readProxyChain(data: RuleNodeData): ProxyChain {
  const value: unknown = parseJson(String(data.settings.steps));
  checkJson(value);
  if (
    !jsonRecord(value) ||
    value.version !== 1 ||
    !jsonArray(value.steps) ||
    value.steps.length > 32
  )
    throw new Error('A proxy chain supports at most 32 ordered hops.');
  const ids = new Set<string>();
  for (const step of value.steps) {
    if (
      !jsonRecord(step) ||
      typeof step.id !== 'string' ||
      !/^[\w-]{1,128}$/.test(step.id) ||
      ids.has(step.id) ||
      !validPolicyReference(step.outbound)
    )
      throw new Error('Invalid proxy-chain hop.');
    ids.add(step.id);
  }
  return value as unknown as ProxyChain;
}
export function chainProblems(data: RuleNodeData): Diagnostic[] {
  if (data.kind !== 'proxy-chain') return [];
  try {
    const chain = readProxyChain(data);
    return chain.steps.length >= 2
      ? []
      : [
          {
            severity: 'error',
            fieldKey: 'steps',
            message: 'Add at least two hops, in order from this PC to the destination.',
          },
        ];
  } catch (error) {
    return [
      {
        severity: 'error',
        fieldKey: 'steps',
        message: error instanceof Error ? error.message : 'Invalid chain.',
      },
    ];
  }
}
