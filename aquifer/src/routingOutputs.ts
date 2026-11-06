import { readRuleTable, tableSettings } from './graph/rules';
import { remoteView, routingDestinations, type RemoteView } from './remoteModel';
import { get } from './nativeProperties';
import { allOutboundNodes, nativePoolNodes } from './graph/nativePool';
import { jsonEqual, jsonRecord, jsonText } from './graph/xrayJson';
import type { RouteDestination, Settings } from './routingEditor';
import { ruleList, ruleTarget } from './routingEditor';

export interface RoutingOutput {
  id: string;
  name: string;
  tag: string;
  group: boolean;
  targetId?: string;
  fallback?: boolean;
}
export const destinationKey = (target: { tag: string; group: boolean }) =>
  JSON.stringify([target.group, target.tag]);

export function readRoutingOutputs(view: RemoteView): RoutingOutput[] {
  const node = view.graph.nodes.find((node) => node.id === 'native-routing');
  if (!node) return [];
  const table = readRuleTable(node.data.settings);
  const targets = new Map(allOutboundNodes(view.graph).map((target) => [target.id, target]));
  return table.outputs.flatMap((output) => {
    const edge = view.graph.edges.find(
      (edge) => edge.source === node.id && edge.sourceHandle === output.id,
    );
    const target = edge ? targets.get(edge.target) : undefined;
    return target
      ? [
          {
            ...output,
            tag: String(target.data.settings.tag ?? ''),
            group: target.data.kind === 'policy-group',
            targetId: target.id,
            fallback: table.defaultOutput === output.id,
          },
        ]
      : [];
  });
}

/** JSON editing may introduce a destination that has no named graph output yet. */
export function syncRoutingOutputs(value: Settings, previous: RoutingOutput[]): RoutingOutput[] {
  const next = [...previous];
  for (const rule of ruleList(value)) {
    const target = ruleTarget(rule);
    if (target.tag && !next.some((output) => destinationKey(output) === destinationKey(target))) {
      let name = target.tag.slice(0, 64),
        suffix = 2;
      while (next.some((output) => output.name.trim().toLowerCase() === name.toLowerCase()))
        name = `${target.tag.slice(0, 58)} (${suffix++})`;
      next.push({ ...target, id: crypto.randomUUID(), name });
    }
  }
  return next;
}

export function outputIssues(outputs: RoutingOutput[], destinations: RouteDestination[]) {
  if (outputs.length > 128)
    return [{ path: 'outputs', tab: 'Outputs', message: 'Use at most 128 outputs.' }];
  const names = new Set<string>(),
    targets = new Set<string>();
  return outputs.flatMap((output) => {
    const key = destinationKey(output),
      name = output.name.trim().toLowerCase();
    const message = !name
      ? 'Enter an output name.'
      : names.has(name)
        ? 'Output names must be unique.'
        : targets.has(key)
          ? 'Each destination needs only one output.'
          : !output.fallback && !destinations.some((target) => destinationKey(target) === key)
            ? 'Choose an available output destination.'
            : '';
    names.add(name);
    targets.add(key);
    return message ? [{ path: 'outputs', tab: 'Outputs', message }] : [];
  });
}

/** Rebuild graph-only port names/order without adding fields to Xray JSON. */
export function applyRoutingOutputs(view: RemoteView, outputs: RoutingOutput[]): RemoteView {
  const node = view.graph.nodes.find((node) => node.id === 'native-routing');
  if (!node) return view;
  if (!outputs.length && !readRoutingOutputs(view).length) return view;
  const destinations = routingDestinations(view);
  const problems = outputIssues(outputs, destinations);
  if (problems.length) throw new Error(problems[0].message);
  const current = readRoutingOutputs(view);
  const ports = (items: RoutingOutput[]) =>
    items.map(({ id, name, tag, group }) => ({ id, name, tag, group }));
  if (jsonEqual(ports(current), ports(outputs))) return view;
  const byTarget = new Map(outputs.map((output) => [destinationKey(output), output]));
  const byPort = new Map(
    current.map((output) => [output.id, byTarget.get(destinationKey(output))]),
  );
  const table = readRuleTable(node.data.settings);
  const fallback = byPort.get(table.defaultOutput);
  if (
    (current.some((output) => output.fallback) && !fallback) ||
    table.rules.some((rule) => !byPort.get(rule.output))
  )
    throw new Error('Keep an output for unmatched traffic and every routing rule.');
  const edges = outputs.map((output) => {
    const target = view.nodes.find(
      (node) =>
        jsonRecord(node.data.raw) &&
        jsonText(get(node.data.raw, 'tag') ?? '') === output.tag &&
        node.id.startsWith('native-balancer-') === output.group &&
        (node.id.startsWith('native-out-') ||
          node.id.startsWith('native-balancer-') ||
          node.data.category === 'internal'),
    );
    if (!target) throw new Error('The output destination is no longer available.');
    return {
      id: `routing-${output.id}`,
      source: node.id,
      sourceHandle: output.id,
      target: target.id,
      targetHandle: 'in',
    };
  });
  const usedTargets = new Set(edges.map((edge) => edge.target));
  const promoted = nativePoolNodes(view.graph)
    .filter((node) => usedTargets.has(node.id))
    .map((node) => ({
      ...node,
      position: view.nodes.find((item) => item.id === node.id)!.position,
    }));
  const promotedIds = new Set(promoted.map((node) => node.id));
  const graph = {
    ...view.graph,
    ...(view.graph.xray
      ? {
          xray: {
            ...view.graph.xray,
            outboundPool: view.graph.xray.outboundPool?.filter((item) => !promotedIds.has(item.id)),
          },
        }
      : {}),
    nodes: [
      ...view.graph.nodes.map((item) =>
        item.id !== node.id
          ? item
          : {
              ...item,
              data: {
                ...item.data,
                settings: tableSettings({
                  ...table,
                  outputs: [
                    ...outputs.map(({ id, name }) => ({ id, name })),
                    ...(!fallback
                      ? table.outputs.filter((output) => output.id === table.defaultOutput)
                      : []),
                  ],
                  defaultOutput: fallback?.id ?? table.defaultOutput,
                  rules: table.rules.map((rule) => ({
                    ...rule,
                    output: byPort.get(rule.output)!.id,
                  })),
                }),
              },
            },
      ),
      ...promoted,
    ],
    edges: [...view.graph.edges.filter((edge) => edge.source !== node.id), ...edges],
  };
  return remoteView(JSON.stringify(view.original), graph);
}

/** Node IDs keep port identity stable when an outbound is renamed or another node is edited. */
export function retainRoutingOutputs(previous: RemoteView, next: RemoteView) {
  const current = readRoutingOutputs(next);
  const retained = readRoutingOutputs(previous).flatMap((output) => {
    const target = next.nodes.find((node) => node.id === output.targetId);
    const tag =
      target?.data.raw && typeof target.data.raw === 'object'
        ? get(target.data.raw as Settings, 'tag')
        : undefined;
    return target && (typeof tag === 'string' || (output.fallback && tag === undefined))
      ? [
          {
            ...output,
            tag: String(tag ?? ''),
            fallback: current.some((item) => item.fallback && item.targetId === output.targetId),
          },
        ]
      : [];
  });
  const keys = new Set(retained.map(destinationKey));
  const combined: RoutingOutput[] = [...retained];
  for (const output of current.filter((output) => !keys.has(destinationKey(output)))) {
    let name = output.name,
      suffix = 2;
    while (combined.some((item) => item.name.trim().toLowerCase() === name.toLowerCase()))
      name = `${output.name.slice(0, 58)} (${suffix++})`;
    combined.push({
      ...output,
      name,
      id: combined.some((item) => item.id === output.id) ? crypto.randomUUID() : output.id,
    });
  }
  return applyRoutingOutputs(next, combined);
}
