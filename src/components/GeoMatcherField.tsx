import { useContext, useId, useRef, useState } from 'react';
import { Expand, X } from 'lucide-react';
import { GeoResourcesContext } from '../geodata';
import type { ResourceKind, ResourceSet } from '../graph/resources';
import GeoBrowseButton from './GeoBrowseButton';
import useModalDialog from './useModalDialog';

function Expanded({
  label,
  kind,
  resources,
  initial,
  onDone,
  onClose,
}: {
  label: string;
  kind: ResourceKind;
  resources: ResourceSet;
  initial: string;
  onDone: (value: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(dialog);
  const input = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initial);
  const titleId = useId();
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window geo-expanded"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onClose={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="rule-editor-titlebar">
        <h2 id={titleId}>{label}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close expanded field"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <div className="expanded-rule-field">
        <div className="rule-field-heading">
          <span />
          <GeoBrowseButton
            resources={resources}
            kind={kind}
            label={label}
            value={value}
            target={input}
            onChange={setValue}
            maxLength={131072}
          />
        </div>
        <textarea
          className="text-control"
          ref={input}
          autoFocus
          aria-label={`Expanded ${label}`}
          spellCheck={false}
          maxLength={131072}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className="rule-editor-footer">
        <button type="button" className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary-button" onClick={() => onDone(value)}>
          OK
        </button>
      </div>
    </dialog>
  );
}
export default function GeoMatcherField({
  label,
  diagnosticKey,
  kind,
  value,
  onChange,
  hint,
  help,
}: {
  label: string;
  diagnosticKey?: string;
  kind: ResourceKind;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  help?: string;
}) {
  const resources = useContext(GeoResourcesContext);
  const input = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return (
    <div className="editor-field" data-diagnostic-field={diagnosticKey}>
      <div className="rule-field-heading">
        <label htmlFor={id}>{label}</label>
        <div className="rule-field-actions">
          <GeoBrowseButton
            kind={kind}
            label={label}
            resources={resources}
            value={value}
            target={input}
            onChange={onChange}
            maxLength={131072}
          />
          <button
            type="button"
            ref={trigger}
            className="icon-button"
            aria-label={`Expand ${label}`}
            title={`Expand ${label}`}
            onClick={() => setExpanded(true)}
          >
            <Expand size={14} />
          </button>
        </div>
      </div>
      <textarea
        className="text-control"
        ref={input}
        id={id}
        aria-label={label}
        rows={3}
        placeholder={hint}
        spellCheck={false}
        maxLength={131072}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {help && <small>{help}</small>}
      {expanded && (
        <Expanded
          label={label}
          kind={kind}
          resources={resources}
          initial={value}
          onClose={() => {
            setExpanded(false);
            requestAnimationFrame(() => trigger.current?.focus());
          }}
          onDone={(v) => {
            onChange(v);
            setExpanded(false);
            requestAnimationFrame(() => input.current?.focus());
          }}
        />
      )}
    </div>
  );
}
