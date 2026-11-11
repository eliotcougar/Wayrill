import {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Handle } from '@xyflow/react';
import { activityPortKey, noGraphActivity, type GraphActivity } from '../graph/activity';
import useGraphActivity, { type GraphActivitySource } from '../useGraphActivity';

type DecorationKind = keyof GraphActivity;
type Listener = () => void;

class ActivityStore {
  private activity = noGraphActivity;
  private readonly listeners = {
    edges: new Map<string, Set<Listener>>(),
    ports: new Map<string, Set<Listener>>(),
  };

  level(kind: DecorationKind, id: string) {
    return this.activity[kind].get(id) ?? 0;
  }

  subscribe(kind: DecorationKind, id: string, listener: Listener) {
    const subscriptions = this.listeners[kind];
    const listeners = subscriptions.get(id) ?? new Set<Listener>();
    listeners.add(listener);
    subscriptions.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) subscriptions.delete(id);
    };
  }

  update(activity: GraphActivity) {
    const previous = this.activity;
    if (previous === activity) return;
    this.activity = activity;
    for (const kind of ['edges', 'ports'] as const) {
      const before = previous[kind],
        after = activity[kind];
      for (const [id, level] of before)
        if (level !== (after.get(id) ?? 0))
          this.listeners[kind].get(id)?.forEach((notify) => notify());
      for (const [id, level] of after)
        if (level !== 0 && !before.has(id))
          this.listeners[kind].get(id)?.forEach((notify) => notify());
    }
  }
}

const GraphActivityContext = createContext<ActivityStore | null>(null);
const idleLevel = () => 0;
const noSubscription = () => {};

export function useGraphActivityLevel(kind: DecorationKind, id: string): number {
  const store = useContext(GraphActivityContext);
  const subscribe = useCallback(
    (listener: Listener) => store?.subscribe(kind, id, listener) ?? noSubscription,
    [store, kind, id],
  );
  return useSyncExternalStore(subscribe, () => store?.level(kind, id) ?? 0, idleLevel);
}

/** Polling state belongs to the decorations, not the entire editor. */
export function GraphActivityProvider({
  children,
  ...source
}: GraphActivitySource & { children: ReactNode }) {
  const activity = useGraphActivity(source);
  const [store] = useState(() => new ActivityStore());
  useLayoutEffect(() => store.update(activity), [store, activity]);
  return (
    <GraphActivityContext.Provider value={source.enabled ? store : null}>
      {children}
    </GraphActivityContext.Provider>
  );
}

// Only these small decorations subscribe to samples; cards and path layout do not.
export const ActivityHandle = memo(function ActivityHandle({
  nodeId,
  style,
  ...props
}: ComponentProps<typeof Handle> & { nodeId: string }) {
  const activity = useGraphActivityLevel(
    'ports',
    activityPortKey(nodeId, props.type, props.id ?? ''),
  );
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
  const activity = useGraphActivityLevel('edges', id);
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
