/** Execution metadata lives beside the configuration, never inside exported Xray JSON. */
export type RoutingHop = {
  filterId: string;
  ruleId: string | null;
  rule: string;
  outputId: string;
  output: string;
};
const traces = new WeakMap<object, RoutingHop[]>();
export function setRoutingTrace<T extends object>(rule: T, trail: RoutingHop[]): T {
  if (trail.length) traces.set(rule, trail);
  return rule;
}
export const getRoutingTrace = (rule: object) => traces.get(rule);
export function copyRoutingTrace<T extends object>(from: object, to: T): T {
  const trail = traces.get(from);
  return trail ? setRoutingTrace(to, trail) : to;
}
