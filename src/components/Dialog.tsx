import useModalDialog from './useModalDialog';
import { X } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';

export default function Dialog({
  title,
  children,
  onClose,
  footer,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useModalDialog(ref);
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      className={`app-dialog ${className}`}
      onClose={onClose}
      aria-labelledby={titleId}
    >
      <div className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      <div className="dialog-footer">
        {footer ?? (
          <button className="primary-button" onClick={onClose}>
            Done
          </button>
        )}
      </div>
    </dialog>
  );
}
