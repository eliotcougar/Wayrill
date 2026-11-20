import { stableProfileKey } from './profileIdentity';
import type { GraphState, RuleNodeData } from './types';

// Base64url: all 64 symbols are safe in JSON, URLs and exact selector expressions.
// Keep the existing 128-bit identities; only their representation changes.
export function compactTagId(hex: string): string {
  return btoa(String.fromCharCode(...hex.match(/../g)!.map((part) => parseInt(part, 16))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export function generatedTag(prefix: string, ...identity: (string | number)[]): string {
  return `${prefix}-${compactTagId(stableProfileKey(JSON.stringify(identity)))}`;
}
/** Bound Unicode names to a fixed-width identity and distinguish equal names by node ID.
 * Keep this tag when renaming the card, so native references and selectors stay valid. */
export function nodeTag(data: RuleNodeData, id: string): string {
  const prefix =
    data.kind === 'policy-group'
      ? 'pg'
      : data.kind === 'proxy-chain'
        ? 'chain'
        : data.kind === 'dns-handler'
          ? 'dns'
          : data.kind.endsWith('-inbound') || data.kind === 'ics-tun'
            ? 'in'
            : 'out';
  return generatedTag(prefix, data.label, id);
}
/** Native imports can omit tags. Give them identities when editing, while keeping
 * lossless import/export and an untouched saved graph unchanged. */
export function ensureNodeTags(graph: GraphState): GraphState {
  if (!graph.nodes.some((node) => node.data.settings.tag === '')) return graph;
  const used = new Set([
    ...graph.nodes.map((node) => node.data.settings.tag),
    ...(graph.xray?.outboundPool ?? []).map((node) => node.config.tag),
  ]);
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.data.settings.tag !== '') return node;
      let tag = generatedTag('node', node.id),
        collision = 0;
      while (used.has(tag)) tag = generatedTag('node', node.id, ++collision);
      used.add(tag);
      return { ...node, data: { ...node.data, settings: { ...node.data.settings, tag } } };
    }),
  };
}
export const GENERATED_DNS_TAG = 'wdg-global';
export const dnsParallelTag = (nodeId: string, local: boolean) =>
  generatedTag('wds', nodeId, local ? 0 : 1);
// The service installs these IDs on the running copy of this ordered server list.
export const resolverActivityId = (index: number) =>
  `wra-${compactTagId(index.toString(16).padStart(32, '0'))}`;
export const observedTag = (tag: string) => `wob-${compactTagId(stableProfileKey(tag))}`;
export const generatedTagPrefixes = [
  'wr-',
  'wri-',
  'wds-',
  'wdg-',
  'wpp-',
  'wpi-',
  'wpe-',
  'wpm-',
  'wob-',
  'woi-',
  'wc-',
  'wcr-',
  'wte-',
  'wt-',
  'wtr-',
  'wdr-',
  'wdo-',
  'wi6-',
  'wrr-',
];
export const isGeneratedTag = (tag: string) =>
  generatedTagPrefixes.some((prefix) => tag.startsWith(prefix));
