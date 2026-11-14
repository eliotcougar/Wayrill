import { useEffect, useId, useRef, useState } from 'react';

type Choice<Id extends string = string> = { id: Id; name: string };

export default function StashOutboundPicker<Kind extends string>({
  types,
  groups,
  preferredGroup,
  onContinue,
  onClose,
}: {
  types: readonly Choice<Kind>[];
  groups?: readonly Choice[];
  preferredGroup?: string;
  onContinue: (kind: Kind, group: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const typeField = useRef<HTMLSelectElement>(null);
  const titleId = useId();
  const [kind, setKind] = useState<Kind>();
  const [group, setGroup] = useState(preferredGroup ?? '');
  const [error, setError] = useState('');
  const groupExists = !groups || groups.some((item) => item.id === group);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const choice = types.find((item) => item.id === kind);
  useEffect(() => {
    dialog.current?.showModal();
    typeField.current?.focus();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="app-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!choice || !groupExists) return;
          try {
            onContinue(choice.id, group);
            dialog.current?.close();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        }}
      >
        <div className="dialog-header">
          <h2 id={titleId}>Add outbound</h2>
        </div>
        <div className="dialog-body">
          <label className="editor-field">
            <span>Outbound type</span>
            <select
              ref={typeField}
              value={kind ?? ''}
              onChange={(event) =>
                setKind(types.find((item) => item.id === event.currentTarget.value)?.id)
              }
            >
              <option value="" disabled>
                Choose a type
              </option>
              {types.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {groups && (
            <label className="editor-field">
              <span>Stash group</span>
              <select value={group} onChange={(event) => setGroup(event.currentTarget.value)}>
                {groups.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && (
            <p className="notice notice--error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="secondary-button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={!choice || !groupExists}>
            Continue
          </button>
        </div>
      </form>
    </dialog>
  );
}
