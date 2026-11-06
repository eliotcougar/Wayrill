import { useEffect, useRef, useState } from 'react';
import { Expand, X } from 'lucide-react';
import ListInput from './ListInput';

function ExpandedListDialog({
  label,
  value,
  onSave,
  onClose,
}: {
  label: string;
  value: unknown;
  onSave: (value: unknown) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector('textarea')?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window expanded-list-dialog"
      aria-label={`Edit ${label}`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="dialog-header">
        <h2>{label}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={`Close expanded ${label}`}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="dialog-body">
        <ListInput
          aria-label={`Expanded ${label}`}
          value={draft}
          trim
          onChange={setDraft}
          spellCheck={false}
        />
      </div>
      <footer className="dialog-footer">
        <button type="button" className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary-button" onClick={() => onSave(draft)}>
          OK
        </button>
      </footer>
    </dialog>
  );
}

export default function ExpandedListField({
  label,
  id,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  id: string;
  value: unknown;
  placeholder?: string;
  onChange: (value: unknown) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setExpanded(false);
    trigger.current?.focus();
  };
  return (
    <>
      <div className="rule-field-heading">
        <label htmlFor={id}>{label}</label>
        <button
          ref={trigger}
          type="button"
          className="icon-button"
          aria-label={`Expand ${label}`}
          title={`Expand ${label}`}
          onClick={() => setExpanded(true)}
        >
          <Expand size={14} />
        </button>
      </div>
      <ListInput
        id={id}
        aria-label={label}
        value={value}
        placeholder={placeholder}
        trim
        spellCheck={false}
        onChange={onChange}
      />
      {expanded && (
        <ExpandedListDialog
          label={label}
          value={value}
          onSave={(value) => {
            onChange(value);
            close();
          }}
          onClose={close}
        />
      )}
    </>
  );
}
