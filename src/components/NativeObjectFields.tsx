import AdvancedSettings from './AdvancedSettings';
import InterfaceSelect from './InterfaceSelect';
import { configuredFieldLabels, isBasicSetting } from '../graph/settingsLayout';
import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { coreDefaultHint, defaultSourceLabel, type DefaultHint } from '../graph/coreDefaults';
import {
  editNativeField,
  nativeFieldText,
  nativeFieldValue,
  type NativeField,
} from '../graph/nativeFields';

function NativeControl({
  object,
  field,
  id,
  onChange,
  onValidity,
  hint,
  parent,
}: {
  object: Record<string, unknown>;
  field: NativeField;
  id: string;
  hint?: DefaultHint;
  parent?: Record<string, unknown>;
  onChange: (o: Record<string, unknown>) => void;
  onValidity: (id: string, valid: boolean) => void;
}) {
  hint = hint ?? coreDefaultHint(field.coreKey ?? '', { object, parent });
  const text = nativeFieldText(object, field),
    [draft, setDraft] = useState(text),
    [showSecret, setShowSecret] = useState(false);
  useEffect(() => setDraft(text), [text]);
  let error = '';
  try {
    nativeFieldValue(field, draft);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Invalid value.';
  }
  useEffect(() => {
    onValidity(id, !error);
  }, [id, error, onValidity]);
  useEffect(() => () => onValidity(id, true), [id, onValidity]);
  const change = (value: string) => {
    setDraft(value);
    try {
      onChange(editNativeField(object, field, value));
    } catch {
      /* Keep the invalid input visible; Apply remains disabled. */
    }
  };
  const describedBy =
    [!draft && `${id}-default`, field.help && `${id}-help`, error && `${id}-error`]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <label className="editor-field" htmlFor={id}>
      <span id={`${id}-label`}>{field.label}</span>
      {field.key === 'interface' ? (
        <InterfaceSelect
          id={id}
          value={draft}
          onChange={change}
          preferUpstream={parent?.protocol === 'freedom'}
          aria-labelledby={`${id}-label`}
          aria-invalid={!!error}
          aria-describedby={describedBy}
        />
      ) : field.type === 'boolean' || field.type === 'select' ? (
        <select
          id={id}
          className={!draft ? 'default-hint-select' : undefined}
          title={hint.detail}
          aria-labelledby={`${id}-label`}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          value={draft}
          onChange={(e) => change(e.target.value)}
        >
          <option value="">Default: {hint.text}</option>
          {field.type === 'select' && draft && !field.options?.includes(draft) && (
            <option value={draft}>{draft} (native value)</option>
          )}
          {field.type === 'boolean' ? (
            <>
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </>
          ) : (
            field.options!.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))
          )}
        </select>
      ) : field.type === 'list' || field.type === 'json' ? (
        <textarea
          id={id}
          aria-labelledby={`${id}-label`}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          rows={field.type === 'json' ? 5 : 3}
          placeholder={hint.text}
          title={hint.detail}
          spellCheck={false}
          maxLength={131072}
          value={draft}
          onChange={(e) => change(e.target.value)}
        />
      ) : (
        <div className={field.type === 'password' ? 'secret-setting' : undefined}>
          <input
            id={id}
            aria-labelledby={`${id}-label`}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            type={
              field.type === 'integer'
                ? 'number'
                : field.type === 'password' && !showSecret
                  ? 'password'
                  : 'text'
            }
            autoComplete={field.type === 'password' ? 'off' : undefined}
            min={field.min}
            max={field.max}
            step={1}
            spellCheck={false}
            placeholder={hint.text}
            title={hint.detail}
            value={draft}
            onChange={(e) => change(e.target.value)}
          />
          {field.type === 'password' && (
            <button
              type="button"
              className="icon-button"
              aria-label={`${showSecret ? 'Hide' : 'Show'} ${field.label}`}
              onClick={() => setShowSecret((v) => !v)}
            >
              {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          )}
        </div>
      )}
      {!draft && (
        <small className="resolved-default-hint" id={`${id}-default`}>
          {defaultSourceLabel(hint)} · {hint.text}
        </small>
      )}
      {field.help && <small id={`${id}-help`}>{field.help}</small>}
      {error && (
        <small className="error" role="alert" id={`${id}-error`}>
          {error}
        </small>
      )}
    </label>
  );
}
export default function NativeObjectFields({
  object,
  fields,
  onChange,
  onValidity,
  idPrefix,
  hints,
  parent,
  structure,
  plain = false,
}: {
  object: Record<string, unknown>;
  fields: NativeField[];
  structure?: string;
  plain?: boolean;
  hints?: Record<string, DefaultHint>;
  parent?: Record<string, unknown>;
  onChange: (o: Record<string, unknown>) => void;
  onValidity: (id: string, valid: boolean) => void;
  idPrefix: string;
}) {
  const basic = fields.filter(
    (f) => plain || isBasicSetting(structure ? `${structure}.${f.key}` : f.coreKey),
  );
  const advanced = fields.filter((f) => !basic.includes(f));
  const controls = (items: NativeField[]) => (
    <div className="field-grid editor-field-grid">
      {items.map((field) => (
        <NativeControl
          key={field.key}
          id={`${idPrefix}-${field.key}`}
          object={object}
          field={field}
          hint={hints?.[field.key]}
          parent={parent}
          onChange={onChange}
          onValidity={onValidity}
        />
      ))}
    </div>
  );
  return (
    <>
      {!!basic.length && controls(basic)}
      {!!advanced.length && (
        <AdvancedSettings configured={configuredFieldLabels(object, advanced)}>
          {controls(advanced)}
        </AdvancedSettings>
      )}
    </>
  );
}
