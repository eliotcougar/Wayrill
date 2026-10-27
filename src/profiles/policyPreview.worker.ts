import {
  calculatePolicyPreview,
  type PolicyPreviewInput,
  type PolicyPreviewResult,
} from './policyPreview';
import { policyPreviewView, type PolicyPreviewQuery } from './policyPreviewView';
import type { GraphState, RuleNode } from '../graph/types';
import type { Stash } from './import';
let context: { graph: GraphState; node: RuleNode; stash: Stash };
let input: PolicyPreviewInput,
  result: PolicyPreviewResult | undefined,
  currentId = 0;
let timer: ReturnType<typeof setTimeout>;
self.onmessage = (
  event: MessageEvent<{
    context?: typeof context;
    id: number;
    input?: PolicyPreviewInput;
    query: PolicyPreviewQuery;
    commit?: number;
  }>,
) => {
  const message = event.data;
  if (message.context) {
    clearTimeout(timer);
    context = message.context;
    result = undefined;
    return;
  }
  if (message.commit !== undefined) {
    self.postMessage(
      result && currentId === message.commit
        ? {
            commit: message.commit,
            snapshot: { sources: result.sources, serialized: result.serialized },
          }
        : { commit: message.commit, error: 'Policy draft changed before saving. Try again.' },
    );
    return;
  }
  if (message.input) {
    input = message.input;
    result = undefined;
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      result ??= calculatePolicyPreview(context.graph, context.node, context.stash, input);
      currentId = message.id;
      self.postMessage({
        id: message.id,
        result: policyPreviewView(context.graph, result, message.query),
      });
    } catch (error) {
      self.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : 'Unable to prepare the policy draft.',
      });
    }
  }, 40);
};
