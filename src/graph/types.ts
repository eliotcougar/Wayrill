import type { Edge, Node, Viewport } from '@xyflow/react';

import type { ProtocolInboundKind, ProtocolOutboundKind } from '@wayrill/core/protocolCatalog';
export type { ProtocolInboundKind, ProtocolOutboundKind } from '@wayrill/core/protocolCatalog';
import type { SettingValue, SettingDefinition, SettingSection } from '@wayrill/core/settings';
export type { SettingValue, SettingDefinition, SettingSection } from '@wayrill/core/settings';

export type NodeKind =
  | ProtocolInboundKind
  | ProtocolOutboundKind
  | 'windivert-inbound'
  | 'proxy-inbound'
  | 'xray-inbound'
  | 'xray-outbound'
  | 'xray-options'
  | 'xray-dns'
  | 'xray-dns-servers'
  | 'policy-group'
  | 'proxy-chain'
  | 'observatory'
  | 'routing-filter'
  | 'dns-handler'
  | 'dns-routing-filter'
  | 'dns-servers'
  | 'fakedns'
  | 'vless-outbound'
  | 'socks-outbound'
  | 'direct-outbound'
  | 'block-outbound';
export interface StashLink {
  groupId: string;
  entryId: string;
}
export type RuleNodeData = {
  /** Canvas-only inbound activation. Omitted means enabled; never an Xray field. */
  enabled?: boolean;
  stashLink?: StashLink;
  kind: NodeKind;
  label: string;
  description: string;
  settings: Record<string, SettingValue>;
  overrides?: string[];
  /** Derived core inheritance; excluded from saved graph documents. */
  coreDefaults?: string[];
  native?: NativeProjection;
  /** Compiler-only source tags for weights after nested outbound expansion. */
  preparedWeightTags?: Record<string, string>;
};
export type RuleNode = Node<RuleNodeData, 'rule'>;
export type RuleEdge = Edge;
export interface GlobalDefaults {
  resources?: import('./resources').ResourceSet;
  version: 1;
  settings: Record<string, SettingValue>;
}
export interface GraphState {
  /** Workspace quick-switch target; never an Xray setting. */
  mainOutboundId?: string;
  name: string;
  nodes: RuleNode[];
  edges: RuleEdge[];
  viewport?: Viewport;
  captureOptions?: import('./capture').CaptureOptions;
  defaults?: GlobalDefaults;
  xray?: XrayGraphMetadata;
}
export interface NativeProjection {
  version: 1;
  original: Record<string, unknown>;
  projection: Record<string, unknown>;
  overrideKeys?: string[];
  // Explicit shared-field edits, including values equal to import placeholders.
  editedKeys?: string[];
}
export interface XrayGraphMetadata {
  version: 1;
  optionsNodeId: string;
  routingNodeId: string;
  dnsNodeId?: string;
  inboundOrder: string[];
  outboundOrder: string[];
  outboundPool?: { id: string; config: Record<string, unknown> }[];
  balancerOrder: string[];
  inboundsPresent: boolean;
  outboundsPresent: boolean;
  routingPresent: boolean;
  rulesPresent: boolean;
  balancersPresent: boolean;
  dnsServersPresent: boolean;
  defaultsProjection: Record<string, unknown>;
}
export interface GraphDocument extends GraphState {
  format: 'wayrill.graph';
  version: 2;
}
export interface NodeDefinition {
  kind: NodeKind;
  title: string;
  group: 'Local capture' | 'Inbounds' | 'Rules & filters' | 'Outbounds';
  category: 'inbound' | 'filter' | 'rule' | 'outbound';
  summary: string;
  defaults: Record<string, SettingValue>;
  fields: SettingDefinition[];
  sections?: SettingSection[];
}
export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  fieldKey?: string;
  rowId?: string;
  controlId?: string;
  outputId?: string;
  portId?: string;
  scope?: 'defaults';
}
