/** Presentation metadata; kept independent of protocol forms and their defaults. */
export const connectionTypes = {
  traffic: {
    label: 'Traffic',
    color: 'var(--connection-traffic)',
    description: 'Network traffic routed by Xray',
    dash: undefined,
  },
  'dns-traffic': {
    label: 'DNS traffic',
    color: 'var(--connection-dns)',
    description: 'Captured DNS traffic or network requests made by a resolver',
    dash: undefined,
  },
  resolver: {
    label: 'Resolver selection',
    color: 'var(--connection-resolver)',
    description: 'DNS resolver selection and server configuration',
    dash: '3 3',
  },
  observation: {
    label: 'Observation',
    color: 'var(--connection-observation)',
    description: 'Shared health and latency observation settings',
    dash: '5 4',
  },
} as const;

export type ConnectionKind = keyof typeof connectionTypes;
