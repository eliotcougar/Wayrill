import { compileXrayGraph } from './graph/xrayCompiler';
import { jsonArray, jsonRecord, parseXrayJson } from './graph/xrayJson';
import { fixXrayCapitalization } from './graph/xrayConfigNames';
import { virtualDestinations } from './graph/virtualDestinations';
import { outboundDependencyProblems } from './graph/protocols';
import type { RemoteView } from './remoteModel';
import { compileUsers, type UserWorkspace } from './users/model';

export function compileRemote(view: RemoteView, users: UserWorkspace) {
  const config = compileXrayGraph(view.graph).config;
  const result = compileUsers(config, users);
  const endpoints = virtualDestinations(result.config.api, result.config.inbounds);
  const handlers = new Set(endpoints.keys());
  const metrics = result.config.metrics;
  if (jsonRecord(metrics) && typeof metrics.tag === 'string' && metrics.tag)
    handlers.add(metrics.tag);
  const reverse = result.config.reverse;
  for (const portal of jsonRecord(reverse) && jsonArray(reverse.portals) ? reverse.portals : []) {
    if (jsonRecord(portal) && typeof portal.tag === 'string' && portal.tag)
      handlers.add(portal.tag);
  }
  result.errors.push(
    ...outboundDependencyProblems(result.config, handlers).map(
      ({ tag, message }) => `${tag}: ${message}`,
    ),
  );
  for (const node of view.graph.nodes) {
    if (node.data.kind === 'xray-internal' && !endpoints.has(String(node.data.settings.tag)))
      result.errors.push(`Restore the user or API that owns the route to ${node.data.label}.`);
  }
  return {
    ...result,
    config: parseXrayJson(fixXrayCapitalization(JSON.stringify(result.config)).text) as Record<
      string,
      unknown
    >,
  };
}
