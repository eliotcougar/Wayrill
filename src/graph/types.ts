import type { Edge, Node, Viewport } from '@xyflow/react';

export type ProtocolInboundKind =
  | 'tunnel-inbound'
  | 'vless-inbound'
  | 'vmess-inbound'
  | 'trojan-inbound'
  | 'shadowsocks-inbound'
  | 'wireguard-inbound'
  | 'hysteria-inbound'
  | 'masque-inbound'
  | 'tun-inbound'
  | 'ics-tun';
export type ProtocolOutboundKind =
  | 'http-outbound'
  | 'vmess-outbound'
  | 'trojan-outbound'
  | 'shadowsocks-outbound'
  | 'wireguard-outbound'
  | 'hysteria-outbound'
  | 'masque-outbound'
  | 'loopback-outbound'
  | 'dns-outbound';
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
export type SettingValue = string | number | boolean;
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
export interface SettingDefinition {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'boolean' | 'password' | 'textarea' | 'json';
  options?: string[];
  optionLabels?: Record<string, string>;
  placeholder?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  required?: boolean;
  /** Omission is meaningful and handled by the owning module. */
  optional?: boolean;
  section?: string;
  help?: string;
  defaultValue?: SettingValue;
  visibleWhen?: Record<string, SettingValue | SettingValue[]>;
  jsonShape?: 'object' | 'array';
  jsonItems?: 'nonemptyStrings';
}
export interface SettingSection {
  id: string;
  title: string;
  description?: string;
  advanced?: boolean;
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
