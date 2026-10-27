import { useState } from 'react';

/** A rejected save must leave the editor's local draft available for inspection/retry. */
export default function useEditorSave(onClose: () => void) {
  const [saveError, setSaveError] = useState('');
  const save = (commit: () => void) => {
    try {
      commit();
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };
  return { save, saveError };
}
