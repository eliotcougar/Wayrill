import { useState } from 'react';

/** A rejected save must leave the editor's local draft available for inspection/retry. */
export default function useEditorSave(onClose: () => void) {
  const [saveError, setSaveError] = useState('');
  const showError = (error: unknown) =>
    setSaveError(error instanceof Error ? error.message : String(error));
  const save = (commit: () => void | Promise<void>) => {
    setSaveError('');
    try {
      const pending = commit();
      if (pending) void pending.then(onClose, showError);
      else onClose();
    } catch (error) {
      showError(error);
    }
  };
  return { save, saveError };
}
