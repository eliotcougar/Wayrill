import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cloneJson, jsonEqual, jsonText } from './graph/xrayJson';
import { get } from './nativeProperties';
import { chainPath, primaryProxy, setNextProxy } from './remoteStashModel';

export default function RemoteChainSettings({
  outbounds,
  root,
  onSave,
  onClose,
}: {
  outbounds: Record<string, unknown>[];
  root: number;
  onSave: (value: Record<string, unknown>[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [draft, setDraft] = useState(() => cloneJson(outbounds));
  const path = chainPath(draft, root);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const close = () => {
    if (jsonEqual(draft, outbounds) || window.confirm('Discard unsaved proxy chain changes?'))
      onClose();
  };
  const title = jsonText(get(draft[root], 'tag'));
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window user-library-dialog remote-chain-dialog"
      aria-label="Edit proxy chain"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="dialog-header">
        <h2>Edit proxy chain · {title}</h2>
        <button className="icon-button" aria-label="Close proxy chain" onClick={close}>
          <X size={18} />
        </button>
      </header>
      <div className="dialog-body remote-settings-body server-inbound-editor">
        <ol className="chain-hops">
          {path.indices.map((index, position) => (
            <li key={index}>
              <strong>{jsonText(get(draft[index], 'tag')) || `Outbound ${index + 1}`}</strong>
              <label className="editor-field">
                Route through
                <select
                  className="text-control"
                  aria-label={`Next outbound for ${jsonText(get(draft[index], 'tag'))}`}
                  value={primaryProxy(draft[index])}
                  onChange={(event) =>
                    setDraft(
                      draft.map((item, i) =>
                        i === index ? setNextProxy(item, event.target.value) : item,
                      ),
                    )
                  }
                >
                  <option value="">None — end of chain</option>
                  {primaryProxy(draft[index]) &&
                    !draft.some((item) => get(item, 'tag') === primaryProxy(draft[index])) && (
                      <option value={primaryProxy(draft[index])}>
                        Unavailable: {primaryProxy(draft[index])}
                      </option>
                    )}
                  {draft.flatMap((item, candidate) => {
                    const tag = get(item, 'tag');
                    return candidate !== index &&
                      typeof tag === 'string' &&
                      !['block', 'blackhole'].includes(String(get(item, 'protocol')))
                      ? [
                          <option key={candidate} value={tag}>
                            {tag}
                            {path.indices.slice(0, position).includes(candidate)
                              ? ' (would create a loop)'
                              : ''}
                          </option>,
                        ]
                      : [];
                  })}
                </select>
              </label>
            </li>
          ))}
        </ol>
        <p className="muted">
          Outbounds are shared definitions. Changing a hop updates every route that uses it.
        </p>
        {path.error && (
          <p className="user-error" role="alert">
            {path.error}
          </p>
        )}
      </div>
      <footer className="dialog-footer">
        <button className="secondary-button" onClick={close}>
          Cancel
        </button>
        <button className="primary-button" disabled={!!path.error} onClick={() => onSave(draft)}>
          Apply changes
        </button>
      </footer>
    </dialog>
  );
}
