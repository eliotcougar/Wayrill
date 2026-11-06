import type { Connection, Edge } from '@xyflow/react';
import type { RemoteView, ViewNode } from '../remoteModel';
import {
  inboundObjects,
  inboundUserProtocol,
  userProtocols,
  compileUsers,
  inboundUsers,
  type UserWorkspace,
  type UsersCompilation,
} from './model';

export const userNodeId = (id: string) => `user-set:${id}`;
export function canConnectUsers(
  connection: Connection | Edge,
  view: RemoteView,
  workspace: UserWorkspace,
): boolean {
  if (
    connection.sourceHandle !== 'users' ||
    connection.targetHandle !== 'users' ||
    !connection.source.startsWith('user-set:') ||
    !/^native-in-\d+$/.test(connection.target)
  )
    return false;
  const set = workspace.sets.find((s) => userNodeId(s.id) === connection.source);
  return (
    !!set &&
    !workspace.bindings.some(
      (b) => b.set === set.id && b.inbound === Number(connection.target.slice(10)),
    ) &&
    inboundUserProtocol(
      inboundObjects(view.original)[Number(connection.target.slice(10))] ?? {},
    ) === set.protocol
  );
}

export function withUserNodes(
  view: RemoteView,
  workspace: UserWorkspace,
  compilation: UsersCompilation = compileUsers(view.original, workspace),
): RemoteView {
  const inbounds = inboundObjects(compilation.config);
  const nodes = view.nodes.map((node): ViewNode => {
    if (!/^native-in-\d+$/.test(node.id)) return node;
    const index = Number(node.id.slice(10)),
      inbound = inbounds[index],
      protocol = inboundUserProtocol(inbound ?? {});
    if (!protocol) return node;
    const count = compilation.errors.length
      ? workspace.bindings
          .filter((b) => b.inbound === index)
          .reduce(
            (sum, b) =>
              sum +
              (workspace.sets.find((s) => s.id === b.set)?.users.filter((u) => u.enabled).length ??
                0),
            0,
          )
      : inboundUsers(inbound).length;
    return {
      ...node,
      data: {
        ...node.data,
        userProtocol: protocol,
        inboundIndex: index,
        inputs: [{ id: 'users', label: 'Users', kind: 'users' }],
        facts: [
          ...node.data.facts.filter(([label]) => label !== 'Accounts'),
          ['Users', String(count)],
        ],
        raw: inbound,
      },
    };
  });
  const left =
    Math.min(
      0,
      ...view.nodes.filter((n) => n.data.category === 'inbound').map((n) => n.position.x),
    ) - 370;
  const top = Math.min(0, ...view.nodes.map((n) => n.position.y));
  let row = top;
  for (const set of workspace.sets) {
    const bindings = workspace.bindings.filter((b) => b.set === set.id);
    nodes.push({
      id: userNodeId(set.id),
      type: 'remote',
      position: { x: left, y: row },
      data: {
        kind: 'user-set',
        title: set.name,
        subtitle: `${userProtocols[set.protocol]} · User set`,
        category: 'users',
        userSetId: set.id,
        facts: [
          [
            'Users',
            `${set.users.filter((u) => u.enabled).length} enabled · ${set.users.length} total`,
          ],
          ['Inbounds', String(workspace.bindings.filter((b) => b.set === set.id).length)],
        ],
        outputs: [
          ...bindings.map((binding) => ({
            id: `users-${binding.inbound}`,
            label:
              view.nodes.find((node) => node.id === `native-in-${binding.inbound}`)?.data.title ??
              `Inbound ${binding.inbound + 1}`,
            kind: 'users' as const,
          })),
          { id: 'users', label: 'Add inbound', kind: 'users' },
        ],
        hasInput: false,
        raw: set,
      },
    });
    row += 210 + 29 * bindings.length;
  }
  const edges = [
    ...view.edges,
    ...workspace.bindings.map((binding) => ({
      id: `users:${binding.set}:${binding.inbound}`,
      source: userNodeId(binding.set),
      sourceHandle: `users-${binding.inbound}`,
      target: `native-in-${binding.inbound}`,
      targetHandle: 'users',
      type: 'schematic',
      style: { stroke: 'var(--connection-users)', strokeWidth: 1.8, strokeDasharray: '6 3' },
      data: { connectionKind: 'users' },
    })),
  ];
  return { ...view, nodes, edges };
}
