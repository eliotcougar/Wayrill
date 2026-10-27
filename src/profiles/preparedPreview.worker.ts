import { preparedPreview } from './preparedPreview';
import type { GraphState, RuleNode } from '../graph/types';
self.onmessage = (
  event: MessageEvent<{ graph: GraphState; node: RuleNode; validationOnly?: boolean }>,
) => {
  try {
    const result = preparedPreview(event.data.graph, event.data.node);
    self.postMessage(event.data.validationOnly ? { valid: true } : { result });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Invalid prepared outbound.',
    });
  }
};
