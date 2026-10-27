import WindowsCaptureSettings from './WindowsCaptureSettings';
import type { GraphState, GlobalDefaults, RuleNode } from '../graph/types';
export default function CaptureEditor({
  graph,
  onApply,
  onClose,
}: {
  node: RuleNode;
  graph: GraphState;
  defaults?: GlobalDefaults;
  onApply: (graph: GraphState) => void;
  onClose: () => void;
}) {
  return <WindowsCaptureSettings graph={graph} onApply={onApply} onClose={onClose} adaptersOnly />;
}
