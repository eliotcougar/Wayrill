/** Execution metadata lives beside the configuration, never inside exported Xray JSON. */
export type RoutingHop = {
  filterId: string;
  ruleId: string | null;
  rule: string;
  outputId: string;
  output: string;
};
const traces = new WeakMap<object, RoutingHop[]>();
export type RoutingInput = { nodeId: string; port: string };
const inputs = new WeakMap<object, RoutingInput>();
export function setRoutingInput<T extends object>(rule: T, input: RoutingInput | undefined): T {
  if (input) inputs.set(rule, input);
  return rule;
}
export const getRoutingInput = (rule: object) => inputs.get(rule);
export function setRoutingTrace<T extends object>(rule: T, trail: RoutingHop[]): T {
  if (trail.length) traces.set(rule, trail);
  return rule;
}
export const getRoutingTrace = (rule: object) => traces.get(rule);
export function copyRoutingTrace<T extends object>(from: object, to: T): T {
  setRoutingInput(to, inputs.get(from));
  const trail = traces.get(from);
  return trail ? setRoutingTrace(to, trail) : to;
}
