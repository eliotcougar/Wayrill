import { connectionTypes, type ConnectionKind } from './graph/connectionKinds';
export type ViewConnectionKind = ConnectionKind | 'users';
export const viewConnections = {
  ...connectionTypes,
  users: {
    label: 'Users',
    color: 'var(--connection-users)',
    description: 'Shared inbound credentials',
    dash: '6 3',
  },
} as const;
