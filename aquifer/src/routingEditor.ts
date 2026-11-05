import { jsonArray, jsonRecord, jsonText } from './graph/xrayJson';
import { get, propertyKey } from './nativeProperties';
import { routingConditionFields } from './graph/rules';
import { portRangeProblem } from './graph/portRanges';
export type RouteDestination = {
  tag: string;
  group: boolean;
  internal?: boolean;
  hidden?: boolean;
};
export type Settings = Record<string, unknown>;
export const ruleList = (value: Settings) => {
  const rules = get(value, 'rules');
  return jsonArray(rules) ? rules.filter(jsonRecord) : [];
};
export const malformedRules = (value: Settings) => {
  const rules = get(value, 'rules');
  return rules !== undefined && (!jsonArray(rules) || !rules.every(jsonRecord));
};
export function conditionKey(rule: Settings, key: string) {
  if (key === 'domain' && get(rule, 'domains') !== undefined) return propertyKey(rule, 'domains');
  if (
    key === 'sourceIP' &&
    get(rule, 'sourceIP') === undefined &&
    get(rule, 'source') !== undefined
  )
    return propertyKey(rule, 'source');
  return propertyKey(rule, key);
}
export function ruleTarget(rule: Settings) {
  const outbound = get(rule, 'outboundTag');
  return {
    tag: jsonText(outbound || get(rule, 'balancerTag') || ''),
    group: !outbound && !!get(rule, 'balancerTag'),
  };
}
export function ruleIssues(value: Settings, destinations: RouteDestination[]) {
  if (malformedRules(value))
    return [
      {
        path: 'rules',
        message: 'Rules must be a list of objects. Correct the imported value in Edit JSON.',
        tab: 'Rules',
      },
    ];
  return ruleList(value).flatMap((rule, index) => {
    const issues: { path: string; message: string; tab: string }[] = [];
    const add = (key: string, message: string) =>
      issues.push({
        path: `rules.${index}.${key}`,
        message: `Rule ${index + 1}: ${message}`,
        tab: 'Rules',
      });
    const target = ruleTarget(rule);
    if (!destinations.some((item) => item.tag === target.tag && item.group === target.group))
      add('destination', 'choose an available destination.');
    const effective =
      routingConditionFields.some(({ key }) => {
        const value = rule[conditionKey(rule, key)];
        return jsonArray(value)
          ? value.length > 0
          : jsonRecord(value)
            ? Object.keys(value).length > 0
            : value !== undefined && value !== '';
      }) || !!get(rule, 'webhook');
    if (!effective)
      add('conditions', 'add a condition; unmatched traffic uses the first outbound.');
    for (const name of ['port', 'sourcePort', 'localPort', 'vlessRoute']) {
      const ports = get(rule, name);
      if (ports !== undefined && portRangeProblem(jsonText(ports), name === 'vlessRoute' ? 0 : 1))
        add(name, 'enter valid ports or port ranges.');
    }
    return issues;
  });
}
