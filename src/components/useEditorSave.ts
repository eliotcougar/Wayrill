import { useRef, useState } from 'react';

type SaveState = { phase: 'editing'; error: string } | { phase: 'saving' };

/** A rejected save leaves the editor's local draft available for retry. */
export default function useEditorSave(onClose: () => void) {
  const [state, setState] = useState<SaveState>({ phase: 'editing', error: '' });
  const pending = useRef(false);
  const close = () => {
    if (!pending.current) onClose();
  };
  const save = (commit: () => void | Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setState({ phase: 'saving' });
    const finish = () => {
      pending.current = false;
      setState({ phase: 'editing', error: '' });
      onClose();
    };
    const fail = (error: unknown) => {
      pending.current = false;
      setState({ phase: 'editing', error: error instanceof Error ? error.message : String(error) });
    };
    try {
      const result = commit();
      if (result) void result.then(finish, fail);
      else finish();
    } catch (error) {
      fail(error);
    }
  };
  return {
    save,
    close,
    saving: state.phase === 'saving',
    saveError: state.phase === 'editing' ? state.error : '',
  };
}
