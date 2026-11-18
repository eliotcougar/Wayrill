import { useId, useMemo, useState } from 'react';
import AdvancedSettings from './AdvancedSettings';
import {
  availableAutomaticTag,
  editableTag,
  occupiedTags,
  tagOverrideProblem,
} from '../graph/nodeTags';
import type { GraphState, RuleNode, RuleNodeData } from '../graph/types';

type Props = {
  graph: GraphState;
  node: RuleNode;
  tag: NonNullable<ReturnType<typeof editableTag>>;
  onUpdate: (id: string, update: Partial<RuleNodeData>) => void;
};

export default function NodeTagEditor(props: Props) {
  return (
    <AdvancedSettings title="Tag">
      <TagInput key={props.tag.value} {...props} />
    </AdvancedSettings>
  );
}

function TagInput({ graph, node, tag, onUpdate }: Props) {
  const [draft, setDraft] = useState(tag.value);
  const id = useId();
  const used = useMemo(
    () => occupiedTags(graph, tag.namespace, node.id),
    [graph, tag.namespace, node.id],
  );
  const automatic = availableAutomaticTag(tag.automatic, used);
  const value = draft.trim();
  const problem = value !== tag.value && tagOverrideProblem(value, automatic, used, tag.maxLength);
  const set = (value: string) => onUpdate(node.id, { settings: tag.settingsFor(value) });
  return (
    <div className="field">
      <label htmlFor={id}>Xray tag</label>
      <input
        id={id}
        value={draft}
        maxLength={tag.maxLength}
        autoComplete="off"
        aria-invalid={!!problem}
        aria-describedby={id + '-hint'}
        onChange={(event) => setDraft(event.target.value)}
      />
      <small className="field-help" id={id + '-hint'}>
        Automatic tag · {automatic}
      </small>
      {problem && (
        <small className="field-message error" role="alert">
          {problem}
        </small>
      )}
      <div className="action-row field-action-row">
        <button
          type="button"
          className="secondary-button button--small"
          disabled={!!problem || value === tag.value}
          onClick={() => set(value)}
        >
          Set tag
        </button>
        <button
          type="button"
          className="secondary-button button--small"
          disabled={tag.value === automatic && draft === automatic}
          onClick={() => {
            if (tag.value === automatic) setDraft(automatic);
            else set(automatic);
          }}
        >
          Reset to automatic
        </button>
      </div>
    </div>
  );
}
