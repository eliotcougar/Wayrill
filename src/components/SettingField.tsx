import { AlertCircle, Eye, EyeOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import EditableSelect from './EditableSelect';
import InterfaceSelect from './InterfaceSelect';
import { defaultSourceLabel, type DefaultHint } from '../graph/coreDefaults';
import type { Diagnostic, SettingDefinition, SettingValue } from '../graph/types';

function NumberSetting({
  field,
  value,
  id,
  onChange,
  onInherit,
  inherited,
  hint,
  onValidity,
  invalid,
  describedBy,
}: {
  field: SettingDefinition;
  value: SettingValue | undefined;
  id: string;
  onChange: (value: number) => void;
  onInherit?: () => void;
  inherited?: boolean;
  hint?: DefaultHint;
  onValidity?: (id: string, valid: boolean) => void;
  invalid: boolean;
  describedBy?: string;
}) {
  const shown = inherited ? '' : String(value ?? ''),
    [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const valid = !draft.trim()
    ? !!onInherit
    : Number.isSafeInteger(Number(draft)) &&
      Number(draft) >= (field.min ?? -Infinity) &&
      Number(draft) <= (field.max ?? Infinity);
  useEffect(() => {
    onValidity?.(id, valid);
  }, [id, valid, onValidity]);
  useEffect(() => () => onValidity?.(id, true), [id, onValidity]);
  return (
    <>
      <input
        id={id}
        type="number"
        step={1}
        min={field.min}
        max={field.max}
        placeholder={hint?.text ?? field.placeholder}
        title={hint?.detail}
        aria-invalid={!valid || invalid}
        aria-describedby={
          [describedBy, !valid ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
        }
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (!next.trim()) {
            onInherit?.();
            return;
          }
          const numeric = Number(next);
          if (
            Number.isSafeInteger(numeric) &&
            numeric >= (field.min ?? -Infinity) &&
            numeric <= (field.max ?? Infinity) &&
            (inherited || numeric !== value)
          )
            onChange(numeric);
        }}
      />
      {!valid && (
        <p className="field-message error" id={`${id}-error`}>
          Enter a whole number
          {field.min !== undefined ? ` from ${field.min}` : ''}
          {field.max !== undefined ? ` to ${field.max}` : ''}. This value has not been applied.
        </p>
      )}
    </>
  );
}
function SecretSetting({
  field,
  value,
  id,
  onChange,
  hint,
  invalid,
  describedBy,
}: {
  field: SettingDefinition;
  value: SettingValue | undefined;
  id: string;
  onChange: (value: string) => void;
  hint?: DefaultHint;
  invalid: boolean;
  describedBy?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="secret-setting">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        maxLength={field.maxLength ?? 4096}
        placeholder={hint?.text ?? field.placeholder}
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="icon-button"
        aria-label={`${visible ? 'Hide' : 'Show'} ${field.label}`}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}
export function SettingField({
  field,
  value,
  issues,
  onChange,
  idPrefix = 'setting',
  hint,
  inherited = false,
  onInherit,
  onValidity,
  effectiveText,
  inheritHint,
  omitted = false,
  describedBy: extraDescription,
  messagePrefix,
  suggestions,
  directInterface = false,
  automaticInterface,
}: {
  field: SettingDefinition;
  value: SettingValue | undefined;
  issues: Diagnostic[];
  idPrefix?: string;
  onChange: (value: SettingValue) => void;
  hint?: DefaultHint;
  inherited?: boolean;
  onInherit?: () => void;
  onValidity?: (id: string, valid: boolean) => void;
  effectiveText?: string;
  inheritHint?: DefaultHint;
  omitted?: boolean;
  describedBy?: string;
  messagePrefix?: string;
  suggestions?: readonly string[];
  directInterface?: boolean;
  automaticInterface?: string;
}) {
  const id = `${idPrefix}-${field.key}`,
    shown = inherited ? '' : String(value ?? ''),
    placeholder = hint?.text ?? field.placeholder;
  const invalid = issues.some((i) => i.severity === 'error');
  const describedBy =
    [
      field.help && `${id}-help`,
      extraDescription,
      effectiveText && `${id}-effective`,
      hint && (inherited || shown === '') && `${id}-default`,
      issues.length > 0 && `${id}-messages`,
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  const choose = (v: string) =>
    v === '__wayrill_inherit__'
      ? onInherit?.()
      : onChange(field.type === 'boolean' ? v === 'true' : v);
  return (
    <div className="field" data-setting-key={field.key}>
      {(field.type !== 'boolean' || onInherit) && (
        <label htmlFor={id}>
          {field.label}
          {field.required && <span>required</span>}
        </label>
      )}
      {field.key === 'interface' ? (
        <InterfaceSelect
          id={id}
          value={shown}
          onChange={onChange}
          preferUpstream={directInterface}
          automaticName={automaticInterface}
          aria-invalid={invalid}
          aria-describedby={describedBy}
        />
      ) : field.type === 'select' || (field.type === 'boolean' && onInherit) ? (
        <select
          id={id}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={inherited || shown === '' ? 'default-hint-select' : undefined}
          value={
            omitted
              ? '__wayrill_omitted__'
              : inherited
                ? '__wayrill_inherit__'
                : String(value ?? '')
          }
          title={hint?.detail}
          onChange={(event) => choose(event.target.value)}
        >
          {omitted && (
            <option value="__wayrill_omitted__" disabled>
              {hint ? defaultSourceLabel(hint) : 'Omitted'}: {placeholder}
            </option>
          )}
          {onInherit && (
            <option value="__wayrill_inherit__">Default: {inheritHint?.text ?? placeholder}</option>
          )}
          {field.type === 'boolean' ? (
            <>
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </>
          ) : (
            field.options!.map((option) => (
              <option key={option} value={option}>
                {option === '' && hint
                  ? onInherit
                    ? 'Xray default'
                    : `Default: ${hint.text}`
                  : (field.optionLabels?.[option] ?? option)}
              </option>
            ))
          )}
        </select>
      ) : field.type === 'boolean' ? (
        <label className="toggle-field">
          <span>{field.label}</span>
          <input
            id={id}
            type="checkbox"
            aria-invalid={invalid}
            aria-describedby={describedBy}
            checked={!!value}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="toggle-switch" aria-hidden="true" />
        </label>
      ) : field.type === 'number' ? (
        <NumberSetting
          id={id}
          field={field}
          value={value}
          inherited={inherited}
          hint={hint}
          onInherit={onInherit}
          onChange={onChange}
          onValidity={onValidity}
          invalid={invalid}
          describedBy={describedBy}
        />
      ) : field.type === 'password' ? (
        <SecretSetting
          id={id}
          field={field}
          value={inherited ? '' : value}
          hint={hint}
          onChange={onChange}
          invalid={invalid}
          describedBy={describedBy}
        />
      ) : field.type === 'textarea' || field.type === 'json' ? (
        <textarea
          id={id}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={field.type === 'json' ? 'code-control' : undefined}
          spellCheck={false}
          rows={field.type === 'json' ? 4 : 2}
          maxLength={field.maxLength ?? 4096}
          placeholder={placeholder}
          title={hint?.detail}
          value={shown}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : suggestions?.length ? (
        <EditableSelect
          id={id}
          label={field.label}
          options={suggestions}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          maxLength={field.maxLength ?? 4096}
          placeholder={placeholder}
          title={hint?.detail}
          spellCheck={false}
          value={shown}
          onChange={onChange}
        />
      ) : (
        <input
          id={id}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          maxLength={field.maxLength ?? 4096}
          placeholder={placeholder}
          title={hint?.detail}
          spellCheck={false}
          value={shown}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint && (inherited || shown === '') && (
        <p className="resolved-default-hint" id={`${id}-default`}>
          {defaultSourceLabel(hint)} · {hint.text}
        </p>
      )}
      {effectiveText && (
        <p className="resolved-default-hint" id={`${id}-effective`}>
          Effective · {effectiveText}
        </p>
      )}
      {field.help && (
        <p className="field-help" id={`${id}-help`}>
          {field.help}
        </p>
      )}
      {issues.length > 0 && (
        <div id={`${id}-messages`}>
          {issues.map((issue, index) => (
            <p key={index} className={`field-message ${issue.severity}`}>
              <AlertCircle size={12} aria-hidden="true" />
              <span>
                {messagePrefix && issue.message.startsWith(messagePrefix)
                  ? issue.message.slice(messagePrefix.length)
                  : issue.message}
              </span>
            </p>
          ))}
        </div>
      )}
      {field.key === 'id' && (
        <>
          <button
            className="secondary-button button--small"
            type="button"
            onClick={() => onChange(crypto.randomUUID())}
          >
            Generate UUID
          </button>
          <p className="field-help">A generated ID must also be configured on your server.</p>
        </>
      )}
    </div>
  );
}
