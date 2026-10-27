import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import useModalDialog from './useModalDialog';

export default function DeleteGraphSelection({
  count,
  stashCount,
  onDelete,
  onClose,
}: {
  count: number;
  stashCount: number;
  onDelete: (deleteStash: boolean) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const graphOnly = useRef<HTMLButtonElement>(null);
  useModalDialog(dialog);
  useEffect(() => graphOnly.current?.focus({ preventScroll: true }), []);
  return (
    <dialog
      ref={dialog}
      className="app-dialog"
      aria-labelledby="delete-selection-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="dialog-header">
        <h2 id="delete-selection-title">Delete {count === 1 ? 'node' : 'selection'}?</h2>
        <button className="icon-button" aria-label="Cancel deletion" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <div className="dialog-body">
        <p>
          {stashCount === 1
            ? 'This outbound has a Stash entry.'
            : `${stashCount} outbounds have Stash entries.`}{' '}
          Delete {stashCount === 1 ? 'it' : 'them'} there too?
        </p>
        <p className="muted-note">
          Other graph nodes keep their current settings. Undo restores the deletion.
        </p>
      </div>
      <div className="dialog-footer">
        <button className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button className="secondary-button destructive" onClick={() => onDelete(true)}>
          Delete graph and Stash
        </button>
        <button
          ref={graphOnly}
          className="primary-button"
          autoFocus
          onClick={() => onDelete(false)}
        >
          Delete graph only
        </button>
      </div>
    </dialog>
  );
}
