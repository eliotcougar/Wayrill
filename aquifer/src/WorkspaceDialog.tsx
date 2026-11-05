import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { version } from '../package.json';

export default function WorkspaceDialog({
  mode,
  errors,
  notices,
  onValidate,
  onClose,
}: {
  mode: 'about' | 'help' | 'check';
  errors: string[];
  notices: string[];
  onValidate?: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const title =
    mode === 'check'
      ? 'Check graph'
      : mode === 'help'
        ? 'Keyboard & canvas'
        : 'About Wayrill Aquifer';
  return (
    <dialog
      ref={dialog}
      className="workspace-dialog"
      aria-labelledby="workspace-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="user-dialog-header">
        <h2 id="workspace-dialog-title">{title}</h2>
        <button className="icon-button" aria-label={`Close ${title}`} onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="workspace-dialog-body">
        {mode === 'check' ? (
          <>
            <strong>
              {errors.length
                ? `${errors.length} graph ${errors.length === 1 ? 'error' : 'errors'}`
                : 'No graph errors'}
            </strong>
            {errors.map((error, index) => (
              <p key={index} className="user-error">
                {error}
              </p>
            ))}
            {notices.length > 0 && (
              <section>
                <h3>Import notes</h3>
                {notices.map((notice, index) => (
                  <p key={index}>{notice}</p>
                ))}
              </section>
            )}
            <p className="muted">
              Checks the local graph. Server-side Xray validation is separate.
            </p>
          </>
        ) : mode === 'help' ? (
          <>
            <dl className="shortcut-list">
              {[
                ['Ctrl+N', 'New configuration'],
                ['Ctrl+O', 'Open Xray config'],
                ['Ctrl+S', 'Export Xray configuration'],
                ['Ctrl+R', 'Read server'],
                ['Ctrl+F', 'Search node library'],
                ['F', 'Fit graph'],
                ['Enter', 'Edit selected node'],
                ['Ctrl++ / Ctrl+−', 'Zoom in / out'],
              ].map(([key, value]) => (
                <div key={key}>
                  <dt>
                    <kbd>{key}</kbd>
                  </dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <p>
              Double-click a node to edit it. Right-click for node actions. Drag compatible User set
              outputs to an inbound’s Users input.
            </p>
          </>
        ) : (
          <>
            <strong>Wayrill Aquifer {version}</strong>
            <p>Configure Linux Xray servers as graphs using saved WinSCP sessions.</p>
            <p>
              Edit a local draft, then validate and apply it to its server, or export Xray JSON.
              Server status provides package and daemon actions.
            </p>
            <p className="muted">
              Discovery needs Python 3 and SSH shell access. Reading a known configuration path uses
              SFTP. Multiple configuration files are opened individually.
            </p>
          </>
        )}
      </div>
      <footer className="user-dialog-footer">
        <button onClick={onClose}>Close</button>
        {mode === 'check' && onValidate && (
          <button className="primary-button" disabled={!!errors.length} onClick={onValidate}>
            Validate on server…
          </button>
        )}
      </footer>
    </dialog>
  );
}
