import type { RuleNode } from './types';
type Position = { x: number; y: number };
type Size = { width: number; height: number };
const padding = 32;
/** Choose a nearby free card rectangle. Use measured cards, including enlarged rule/policy nodes. */
export function clearNodePosition(
  nodes: readonly RuleNode[],
  desired: Position,
  size: Size = { width: 250, height: 230 },
): Position {
  const clear = (p: Position) =>
    nodes.every((node) => {
      const width = node.measured?.width ?? node.width ?? 250;
      const height = node.measured?.height ?? node.height ?? 230;
      return (
        p.x + size.width + padding <= node.position.x ||
        p.x >= node.position.x + width + padding ||
        p.y + size.height + padding <= node.position.y ||
        p.y >= node.position.y + height + padding
      );
    });
  if (clear(desired)) return desired;
  for (let radius = 1; radius <= 32; radius++) {
    const candidates: Position[] = [];
    for (let x = -radius; x <= radius; x++)
      for (let y = -radius; y <= radius; y++) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== radius) continue;
        candidates.push({
          x: desired.x + x * (size.width + padding),
          y: desired.y + y * (size.height + padding),
        });
      }
    candidates.sort(
      (a, b) =>
        Math.abs(a.x - desired.x) +
        Math.abs(a.y - desired.y) -
        Math.abs(b.x - desired.x) -
        Math.abs(b.y - desired.y),
    );
    const free = candidates.find(clear);
    if (free) return free;
  }
  throw new Error('No free space near this position. Pan to an empty area before adding a node.');
}

/** Recover spacing after a card grows, while retaining unaffected positions. */
export function spaceNodes(nodes: readonly RuleNode[]): RuleNode[] {
  const placed: RuleNode[] = [];
  const positions = new Map<string, Position>();
  for (const node of [...nodes].sort(
    (a, b) => a.position.x - b.position.x || a.position.y - b.position.y,
  )) {
    const position = clearNodePosition(placed, node.position, {
      width: node.measured?.width ?? node.width ?? 250,
      height: node.measured?.height ?? node.height ?? 230,
    });
    positions.set(node.id, position);
    placed.push({ ...node, position });
  }
  return nodes.map((node) => ({ ...node, position: positions.get(node.id)! }));
}
