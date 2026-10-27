import { it, expect } from 'vitest';
it('spaces enlarged overlapping cards without changing distant positions or identifiers', async () => {
  const { spaceNodes } = await import('./placement');
  const { makeNode } = await import('./catalog');
  const first = makeNode('direct-outbound', { x: 0, y: 0 }),
    second = makeNode('block-outbound', { x: 280, y: 0 }),
    distant = makeNode('direct-outbound', { x: 4000, y: 4000 });
  const firstSize = { width: 400, height: 300 },
    secondSize = { width: 250, height: 230 };
  first.measured = firstSize;
  second.measured = secondSize;
  const result = spaceNodes([first, second, distant]);
  expect(result.map((n) => n.id)).toEqual([first.id, second.id, distant.id]);
  expect(result[0].position).toEqual(first.position);
  expect(result[1].position).not.toEqual(second.position);
  const [a, b] = result;
  expect(
    a.position.x + firstSize.width <= b.position.x ||
      b.position.x + secondSize.width <= a.position.x ||
      a.position.y + firstSize.height <= b.position.y ||
      b.position.y + secondSize.height <= a.position.y,
  ).toBe(true);
  expect(result[2].position).toEqual(distant.position);
  expect(second.position).toEqual({ x: 280, y: 0 });
});
