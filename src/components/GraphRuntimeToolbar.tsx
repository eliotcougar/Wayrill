import { CheckCheck, Play, RefreshCw, Square } from 'lucide-react';
import type { GraphRuntimeActions } from '../createGraphRuntimeActions';

export default function GraphRuntimeToolbar({
  actions,
  onCheck,
  onResult,
  onError,
}: {
  actions: GraphRuntimeActions;
  onCheck: () => void;
  onResult: (message: string) => void;
  onError: () => void;
}) {
  const run = (action: () => Promise<boolean>, message: string) =>
    void action()
      .then((completed) => {
        if (completed) onResult(message);
      })
      .catch(onError);
  return (
    <div className="graph-runtime-actions" role="group" aria-label="Graph runtime actions">
      <button className="secondary-button" onClick={onCheck} title="Check the graph">
        <CheckCheck size={16} />
        Check
      </button>
      <button
        className="primary-button"
        disabled={!actions.canApply}
        title={actions.applyReason || actions.activationTitle}
        onClick={() => run(actions.activate, actions.activationMessage)}
      >
        {actions.activationLabel === 'Restart' ? <RefreshCw size={15} /> : <Play size={15} />}
        {actions.activationLabel}
      </button>
      <button
        className="secondary-button"
        disabled={!actions.canStop}
        title="Stop Wayrill networking"
        onClick={() => run(actions.stop, 'Wayrill networking stopped.')}
      >
        <Square size={14} />
        Stop
      </button>
    </div>
  );
}
