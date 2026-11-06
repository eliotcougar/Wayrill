const kindLabels: Record<string, string> = {
  fakedns: 'FAKEDNS',
  'proxy-inbound': 'PROXY',
  'policy-group': 'POLICY GROUP',
  'proxy-chain': 'PROXY CHAIN',
  observatory: 'OBSERVATORY',
  'dns-servers': 'DNS SERVERS',
  'xray-dns-servers': 'DNS SERVERS',
  'dns-routing-filter': 'DNS FILTER',
  'dns-handler': 'DNS HANDLER',
  'xray-dns': 'DNS HANDLER',
  'routing-filter': 'ROUTING FILTER',
  'xray-options': 'CORE SETTINGS',
};
const categoryLabels: Record<string, string> = {
  inbound: 'INBOUND',
  outbound: 'OUTBOUND',
  filter: 'CONDITION',
  rule: 'ROUTING RULE',
};

export function nodeKindLabel(kind: string, category: string) {
  return kindLabels[kind] ?? categoryLabels[category] ?? category.toUpperCase();
}
