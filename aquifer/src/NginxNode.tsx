import { connectionTypes } from './graph/connectionKinds';
import {
  nginxRouteLabel,
  nginxRoutes,
  type NginxObservation,
  type NginxRoute,
} from './nginxRoutes';
import type { RemoteView, ViewNode } from './remoteModel';

export const nginxNodeId = 'observed-nginx';

export function withNginx(
  view: RemoteView,
  observation: NginxObservation,
  host: string,
): RemoteView {
  if (observation.state !== 'ready') return view;
  const targets = new Set(view.nodes.map(({ id }) => id));
  const routes = nginxRoutes(observation, view.normalized, host).filter((route) =>
    targets.has('native-in-' + route.inbound),
  );
  const inboundIds = new Set(routes.map(({ inbound }) => 'native-in-' + inbound));
  const first = view.nodes.find(({ id }) => inboundIds.has(id));
  const left = view.nodes.reduce((x, node) => Math.min(x, node.position.x), 0);
  const node: ViewNode = {
    id: nginxNodeId,
    type: 'remote',
    position: { x: left - 330, y: first?.position.y ?? 0 },
    data: {
      kind: 'nginx',
      title: 'Nginx',
      subtitle: 'Reverse proxy · Read-only',
      category: 'internal',
      facts: [['Routes to Xray', String(routes.length)]],
      outputs: routes.map((route, index) => ({
        id: 'relay-' + index,
        kind: 'traffic',
        label: nginxRouteLabel(route),
      })),
      hasInput: false,
      raw: routes,
      nginxRoutes: routes,
    },
  };
  return {
    ...view,
    nodes: [
      node,
      ...view.nodes.map((item) =>
        inboundIds.has(item.id)
          ? { ...item, data: { ...item.data, hasInput: true, inputKinds: ['traffic' as const] } }
          : item,
      ),
    ],
    edges: [
      ...view.edges,
      ...routes.map((route, index) => ({
        id: 'observed-nginx-' + index,
        type: 'schematic',
        source: nginxNodeId,
        sourceHandle: 'relay-' + index,
        target: 'native-in-' + route.inbound,
        targetHandle: 'in',
        style: { stroke: connectionTypes.traffic.color, strokeWidth: 1.8 },
        data: { connectionKind: 'traffic' },
      })),
    ],
  };
}

export function NginxDetails({
  routes,
  view,
  onFocus,
}: {
  routes: NginxRoute[];
  view: RemoteView;
  onFocus: (id: string) => void;
}) {
  return (
    <>
      {!routes.length && (
        <p className="muted">No supported Nginx routes lead to an inbound in this configuration.</p>
      )}
      <div className="nginx-routes">
        {routes.map((route) => {
          const id = 'native-in-' + route.inbound;
          const target = view.nodes.find((item) => item.id === id);
          return (
            <article className="editor-panel" key={JSON.stringify(route)}>
              <strong>{nginxRouteLabel(route)}</strong>
              <dl className="detail-facts">
                {route.http && (
                  <div>
                    <dt>Location</dt>
                    <dd>{route.http.location}</dd>
                  </div>
                )}
                {route.via && (
                  <div>
                    <dt>Via</dt>
                    <dd>{route.via}</dd>
                  </div>
                )}
                <div>
                  <dt>Backend</dt>
                  <dd>{route.backend}</dd>
                </div>
              </dl>
              <button type="button" className="secondary-button" onClick={() => onFocus(id)}>
                {target?.data.title ?? 'Show inbound'}
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}
