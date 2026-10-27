import { policySetSummary } from '../components/editorSummaries';
import { isExecutableOutboundKind, outboundBundle } from '../graph/outbounds';
import { fieldProblem } from '../graph/settingValidation';
import { editPolicyGraph, policyDefinitions, policyProblems } from '../graph/policies';
import { compilePolicies } from '../graph/policyCompilation';
import { outboundNeedsObservation } from '../graph/composites';
import {
  policySourceProblems,
  refreshPolicySources,
  type PolicySources,
} from '../graph/policySources';
import { compileXrayGraph } from '../graph/xrayCompiler';
import type { GraphState, RuleNode, RuleNodeData } from '../graph/types';
import type { Stash } from './import';

export interface PolicyPreviewInput {
  settings: RuleNodeData['settings'];
  sources: PolicySources;
  observer: RuleNode;
  corePreview: boolean;
}
export function calculatePolicyPreview(
  graph: GraphState,
  node: RuleNode,
  stash: Stash,
  input: PolicyPreviewInput,
) {
  const sources = refreshPolicySources(input.sources, stash),
    serialized = JSON.stringify(sources);
  const data = { ...node.data, settings: { ...input.settings, sources: serialized } },
    candidate = { ...node, data };
  const candidateGraph = {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === node.id ? candidate : n)),
  };
  const summary = policySetSummary(candidateGraph, candidate, sources);
  const issues = [
    ...policyProblems(data),
    ...policySourceProblems(candidateGraph, candidate, sources),
    ...policyDefinitions
      .find((d) => d.kind === data.kind)!
      .fields.flatMap((field) => {
        const message = fieldProblem(field, data.settings);
        return message
          ? [
              {
                severity: 'error' as const,
                fieldKey: field.key,
                message: `${field.label}: ${message}`,
              },
            ]
          : [];
      }),
  ];
  const observed = outboundNeedsObservation(candidateGraph, candidate);
  let corePreview = '';
  if (input.corePreview) {
    try {
      const next = editPolicyGraph(
        graph,
        node.id,
        data.settings,
        observed ? input.observer.id : undefined,
        observed ? input.observer : undefined,
      );
      corePreview = JSON.stringify(
        graph.xray
          ? compileXrayGraph(next).config
          : compilePolicies(next, [
              { tag: 'wayrill-runtime-unmatched' },
              ...graph.nodes
                .filter((n) => isExecutableOutboundKind(n.data.kind))
                .flatMap((n) => outboundBundle(n.data)),
            ]),
        null,
        2,
      );
    } catch (error) {
      corePreview = error instanceof Error ? error.message : String(error);
    }
  }
  return { sources, serialized, summary, issues, corePreview, observed };
}
export type PolicyPreviewResult = ReturnType<typeof calculatePolicyPreview>;
