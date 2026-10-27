import {
  ArrowUpRight,
  Filter,
  GitBranch,
  Globe,
  OctagonX,
  RadioTower,
  ShieldCheck,
  Server,
  Shuffle,
  Activity,
} from 'lucide-react';
import type { NodeKind } from '../graph/types';

const icons = {
  'ics-tun': GitBranch,
  'xray-inbound': RadioTower,
  'xray-outbound': Server,
  'xray-options': Activity,
  'xray-dns': Globe,
  fakedns: Globe,
  'xray-dns-servers': Server,
  'proxy-inbound': RadioTower,
  'policy-group': Shuffle,
  'proxy-chain': GitBranch,
  observatory: Activity,
  'routing-filter': Filter,
  'dns-handler': Globe,
  'block-outbound': OctagonX,
  'vless-outbound': ShieldCheck,
  'socks-outbound': Server,
  'direct-outbound': ArrowUpRight,
  'dns-servers': Server,
  'dns-routing-filter': GitBranch,
};
export default function NodeIcon({ kind, size = 18 }: { kind: NodeKind; size?: number }) {
  const Icon =
    icons[kind as keyof typeof icons] ?? (kind.endsWith('-inbound') ? RadioTower : Server);
  return <Icon size={size} strokeWidth={1.65} aria-hidden="true" />;
}
