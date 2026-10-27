import { useRef } from 'react';
import type { GraphState } from './graph/types';

// Canvas position, viewport and selection never change the executable config.
// Keep those frequent renderer updates out of compiler and diagnostic work.
export function sameExecutionGraph(a: GraphState, b: GraphState): boolean {
  return (
    a.defaults === b.defaults &&
    a.xray === b.xray &&
    a.captureOptions === b.captureOptions &&
    a.nodes.length === b.nodes.length &&
    a.nodes.every((node, i) => node.id === b.nodes[i].id && node.data === b.nodes[i].data) &&
    a.edges.length === b.edges.length &&
    a.edges.every((edge, i) => {
      const other = b.edges[i];
      return (
        edge.id === other.id &&
        edge.source === other.source &&
        edge.target === other.target &&
        edge.sourceHandle === other.sourceHandle &&
        edge.targetHandle === other.targetHandle
      );
    })
  );
}

export default function useExecutionGraph(graph: GraphState): GraphState {
  const previous = useRef(graph);
  if (!sameExecutionGraph(previous.current, graph)) previous.current = graph;
  return previous.current;
}
