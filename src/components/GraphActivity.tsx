import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Handle } from '@xyflow/react';
import { activityPortKey, noGraphActivity } from '../graph/activity';
import useGraphActivity, { type GraphActivitySource } from '../useGraphActivity';

export const GraphActivityContext = createContext(noGraphActivity);

/** Polling state belongs to the decorations, not the entire editor. */
export function GraphActivityProvider({
  children,
  ...source
}: GraphActivitySource & { children: ReactNode }) {
  const activity = useGraphActivity(source);
  return <GraphActivityContext.Provider value={activity}>{children}</GraphActivityContext.Provider>;
}

// Only these small decorations subscribe to samples; cards and path layout do not.
export const ActivityHandle = memo(function ActivityHandle({
  nodeId,
  style,
  ...props
}: ComponentProps<typeof Handle> & { nodeId: string }) {
  const activity =
    useContext(GraphActivityContext).ports.get(
      activityPortKey(nodeId, props.type, props.id ?? ''),
    ) ?? 0;
  const glowStyle = useMemo(
    () => ({ ...style, '--traffic-glow': activity }) as CSSProperties,
    [style, activity],
  );
  return <Handle {...props} style={glowStyle} />;
});

export const EdgeActivity = memo(function EdgeActivity({
  id,
  path,
  color,
}: {
  id: string;
  path: string;
  color: CSSProperties['stroke'];
}) {
  const activity = useContext(GraphActivityContext).edges.get(id) ?? 0;
  return <GlowPath path={path} color={color} activity={activity} />;
});

// Unchanged wires do not recreate SVG children on every context sample.
const GlowPath = memo(function GlowPath({
  path,
  color,
  activity,
}: {
  path: string;
  color: CSSProperties['stroke'];
  activity: number;
}) {
  return (
    <g
      className="edge-activity"
      style={{ opacity: activity }}
      fill="none"
      color={color}
      strokeLinecap="round"
      strokeLinejoin="round"
      pointerEvents="none"
      aria-hidden="true"
    >
      <path d={path} strokeWidth={18} strokeOpacity={0.14} />
      <path d={path} strokeWidth={10} strokeOpacity={0.32} />
      <path d={path} strokeWidth={4} strokeOpacity={0.85} stroke="var(--activity-core)" />
    </g>
  );
});
