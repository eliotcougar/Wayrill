import type { EdgeProps } from '@xyflow/react';
import type { ConnectionKind } from './connectionKinds';

export type EdgeGeometry = Pick<
  EdgeProps,
  'id' | 'sourceX' | 'sourceY' | 'targetX' | 'targetY' | 'sourcePosition' | 'targetPosition'
> & {
  source?: string;
  target?: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  kind?: ConnectionKind;
};
