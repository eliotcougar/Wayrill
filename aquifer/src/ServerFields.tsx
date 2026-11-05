import MapInput from './MapInput';
import ListInput from './ListInput';
import { useEffect, useId, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { generateServerKeys, generateShortId, serverPublicKey } from './serverKeys';
import { jsonArray, jsonRecord, jsonText } from './graph/xrayJson';
import { coreDefaultHint } from './graph/coreDefaults';
import {
  fieldKey,
  fieldsForServer,
  setProperty,
  type InboundIssue,
  type ServerField,
  type ServerObject,
} from './inboundFields';

function Field({
  field,
  object,
  root,
  path,
  issues,
  onChange,
  fieldSets,
  direction,
}: {
  field: ServerField;
  object: ServerObject;
  root: ServerObject;
  path: string;
  issues: InboundIssue[];
  onChange: (value: ServerObject) => void;
  fieldSets?: Record<string, ServerField[]>;
  direction?: 'inbound' | 'outbound';
}) {
  const id = useId(),
    [reveal, setReveal] = useState(false);
  const [generated, setGenerated] = useState<{ privateKey: string; publicKey: string } | null>(
    null,
  );
  const [keyError, setKeyError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const generationTarget = useRef({ object, onChange, active: true });
  useEffect(() => {
    generationTarget.current = { object, onChange, active: true };
    return () => {
      generationTarget.current.active = false;
    };
  }, [object, onChange]);
  const key = fieldKey(object, field),
    value = object[key],
    at = path + key;
  const privateKeyField =
    field.type === 'secret' && ['privateKey', 'secretKey'].includes(field.key);
  useEffect(() => {
    let active = true;
    if (privateKeyField && typeof value === 'string') {
      void serverPublicKey(value, field.key === 'secretKey')
        .then((publicKey) => {
          if (active) setGenerated({ privateKey: value, publicKey });
        })
        .catch(() => {
          if (active) setGenerated(null);
        });
    } else setGenerated(null);
    setCopied(false);
    return () => {
      active = false;
    };
  }, [value, privateKeyField, field.key]);
  const error = issues.find((issue) => issue.path === at)?.message;
  const compound = ['collection', 'object', 'map'].includes(field.type ?? '');
  const change = (next: unknown) => onChange(setProperty(object, key, next));
  const inputProps = {
    id,
    'aria-label': field.label,
    'aria-required': field.required || undefined,
    'aria-invalid': !!error,
    'aria-describedby': error ? id + '-error' : field.hint ? id + '-hint' : undefined,
    spellCheck: false,
    autoComplete: 'off',
  };
  const reset = () => {
    let next = setProperty(object, key, undefined);
    for (const alias of [field.key, ...(field.aliases ?? [])])
      next = setProperty(next, alias, undefined);
    onChange(next);
  };
  return (
    <div
      data-setting-path={at}
      className={`server-field${field.wide || ['collection', 'object', 'map', 'lines', 'numbers'].includes(field.type ?? '') ? ' server-field-wide' : ''}`}
      role={compound ? 'group' : undefined}
      aria-labelledby={compound ? id + '-label' : undefined}
    >
      <div className="server-field-label">
        {compound ? (
          <span id={id + '-label'}>
            {field.label}
            {field.required && (
              <span className="required-mark" aria-hidden="true">
                {' '}
                *
              </span>
            )}
          </span>
        ) : (
          <label htmlFor={id}>
            {field.label}
            {field.required && (
              <span className="required-mark" aria-hidden="true">
                {' '}
                *
              </span>
            )}
          </label>
        )}
        {value !== undefined && !field.required && (
          <button
            type="button"
            className="icon-button server-reset"
            aria-label={`Use default for ${field.label}`}
            title="Use default"
            onClick={reset}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
      {field.type === 'object' ? (
        <ServerFields
          schema={field.schema!}
          object={jsonRecord(value) ? value : {}}
          root={root}
          path={at + '.'}
          issues={issues}
          onChange={change}
          fieldSets={fieldSets}
          direction={direction}
        />
      ) : field.type === 'collection' ? (
        <div className="server-collection">
          {(jsonArray(value) ? value : []).map((item, index) => (
            <section className="editor-panel server-collection-item" key={index}>
              <header>
                <strong>
                  {field.schema === 'ShortId'
                    ? `Short ID ${index + 1}`
                    : `${field.label} · ${index + 1}`}
                </strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${field.label} ${index + 1}`}
                  onClick={() => change((value as unknown[]).filter((_, i) => i !== index))}
                >
                  <Trash2 size={15} />
                </button>
              </header>
              {field.schema === 'ShortId' ? (
                <>
                  <input
                    className="text-control"
                    aria-label={`Short ID ${index + 1}`}
                    value={String(item)}
                    placeholder="Empty ID"
                    spellCheck={false}
                    aria-invalid={issues.some((issue) => issue.path === `${at}.${index}`)}
                    onChange={(event) =>
                      change(
                        (value as unknown[]).map((old, i) =>
                          i === index ? event.target.value : old,
                        ),
                      )
                    }
                  />
                  {issues
                    .filter((issue) => issue.path === `${at}.${index}`)
                    .map((issue) => (
                      <span className="field-message error" key={issue.path}>
                        {issue.message}
                      </span>
                    ))}
                </>
              ) : (
                <ServerFields
                  object={jsonRecord(item) ? item : {}}
                  schema={field.schema!}
                  root={root}
                  path={`${at}.${index}.`}
                  issues={issues}
                  fieldSets={fieldSets}
                  direction={direction}
                  onChange={(next) =>
                    change((value as unknown[]).map((old, i) => (i === index ? next : old)))
                  }
                />
              )}
            </section>
          ))}
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              change([
                ...(jsonArray(value) ? value : []),
                field.schema === 'ShortId' ? generateShortId() : {},
              ])
            }
          >
            <Plus size={15} /> Add{' '}
            {field.schema === 'ShortId'
              ? 'short ID'
              : field.itemName
                ? field.itemName
                : field.label === 'Certificates'
                  ? 'certificate'
                  : field.label === 'Peers'
                    ? 'peer'
                    : 'entry'}
          </button>
        </div>
      ) : field.type === 'map' ? (
        <MapInput
          value={value}
          lists={field.schema === 'lines'}
          label={field.label}
          onChange={change}
        />
      ) : field.type === 'lines' || field.type === 'numbers' ? (
        <ListInput
          {...inputProps}
          value={value}
          numeric={field.type === 'numbers'}
          placeholder={field.placeholder ?? 'One entry per line'}
          onChange={change}
        />
      ) : field.type === 'boolean' ? (
        <select
          className="text-control"
          {...inputProps}
          value={value === undefined ? '' : jsonText(value)}
          onChange={(event) =>
            change(event.target.value === '' ? undefined : event.target.value === 'true')
          }
        >
          <option value="">{field.placeholder ?? 'Default'}</option>
          <option value="true">On</option>
          <option value="false">Off</option>
        </select>
      ) : field.type === 'select' ? (
        <select
          className="text-control"
          {...inputProps}
          value={value === undefined ? '' : jsonText(value)}
          onChange={(event) =>
            change(
              event.target.value === ''
                ? undefined
                : field.key === 'xver'
                  ? Number(event.target.value)
                  : event.target.value,
            )
          }
        >
          <option value="">{field.placeholder ?? (field.required ? 'Choose…' : 'Default')}</option>
          {[
            ...new Set([
              ...(value !== undefined && value !== '' ? [jsonText(value)] : []),
              ...(field.choices ?? []),
            ]),
          ].map((option) => (
            <option key={option} value={option}>
              {field.optionLabels?.[option] ?? option}
            </option>
          ))}
        </select>
      ) : (
        <div className={field.type === 'secret' ? 'secret-setting' : undefined}>
          <input
            className="text-control"
            {...inputProps}
            type={field.type === 'secret' && !reveal ? 'password' : 'text'}
            inputMode={field.type === 'number' || field.type === 'port' ? 'numeric' : undefined}
            value={value === undefined ? '' : jsonText(value)}
            placeholder={field.placeholder ?? (field.required ? '' : 'Default')}
            onChange={(event) => {
              const text = event.target.value;
              const next =
                text === ''
                  ? undefined
                  : field.type === 'number' &&
                      (field.integer === false ? /^-?\d+(?:\.\d+)?$/ : /^-?\d+$/).test(text)
                    ? Number(text)
                    : (field.type === 'target' || field.type === 'port') && /^\d+$/.test(text)
                      ? Number(text)
                      : field.type === 'fastopen'
                        ? text === 'true'
                          ? true
                          : text === 'false'
                            ? false
                            : /^\d+$/.test(text)
                              ? Number(text)
                              : text
                        : text;
              change(next);
            }}
          />
          {field.type === 'secret' && (
            <button
              type="button"
              className="icon-button"
              aria-label={`${reveal ? 'Hide' : 'Show'} ${field.label}`}
              onClick={() => setReveal(!reveal)}
            >
              {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          )}
        </div>
      )}
      {field.hint && (
        <span className="field-help" id={id + '-hint'}>
          {field.hint}
        </span>
      )}
      {field.type === 'secret' && (field.key === 'privateKey' || field.key === 'secretKey') && (
        <div className="server-key-tools">
          <button
            className="secondary-button"
            type="button"
            disabled={generating}
            onClick={() => {
              setGenerating(true);
              setKeyError('');
              setCopied(false);
              void generateServerKeys(field.key === 'secretKey')
                .then((pair) => {
                  const target = generationTarget.current;
                  if (!target.active) return;
                  if (target.object !== object) {
                    setKeyError('Settings changed during generation. Generate the key again.');
                    return;
                  }
                  setGenerated(pair);
                  target.onChange(setProperty(target.object, key, pair.privateKey));
                })
                .catch(() =>
                  setKeyError(
                    'Key generation requires a WebView2 version with X25519 support. You can enter a key manually.',
                  ),
                )
                .finally(() => setGenerating(false));
            }}
          >
            {generating ? 'Generating…' : 'Generate key pair'}
          </button>
          {generated && value === generated.privateKey && (
            <div className="field-with-button">
              <input
                className="text-control"
                aria-label="Generated public key"
                readOnly
                value={generated.publicKey}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={copied ? 'Public key copied' : 'Copy public key'}
                title={copied ? 'Copied' : 'Copy public key'}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(generated.publicKey)
                    .then(() => setCopied(true))
                    .catch(() => setKeyError('Select the public key and copy it manually.'));
                }}
              >
                <Copy size={15} />
              </button>
            </div>
          )}
          {keyError && (
            <span className="field-message error" role="status">
              {keyError}
            </span>
          )}
        </div>
      )}
      {error && (
        <span className="field-message error" id={id + '-error'}>
          {error}
        </span>
      )}
    </div>
  );
}

export default function ServerFields({
  object,
  root,
  schema,
  path = '',
  issues = [],
  onChange,
  advancedOnly = false,
  fieldSets,
  direction = 'inbound',
}: {
  object: ServerObject;
  root: ServerObject;
  schema: string;
  path?: string;
  issues?: InboundIssue[];
  onChange: (value: ServerObject) => void;
  advancedOnly?: boolean;
  fieldSets?: Record<string, ServerField[]>;
  direction?: 'inbound' | 'outbound';
}) {
  const fields = fieldSets?.[schema] ?? fieldsForServer(schema, object, root);
  const regular = fields.filter((field) => !field.advanced),
    advanced = fields.filter((field) => field.advanced);
  const [openAdvanced, setOpenAdvanced] = useState(false);
  const advancedError = advanced.some((field) =>
    issues.some((issue) => issue.path.startsWith(path + fieldKey(object, field))),
  );
  useEffect(() => {
    if (advancedError) setOpenAdvanced(true);
  }, [advancedError]);
  const render = (fields: ServerField[]) => (
    <div className="field-grid server-fields-grid">
      {fields.map((source) => {
        const field = {
          ...source,
          placeholder:
            source.placeholder ??
            (source.required
              ? undefined
              : coreDefaultHint(`${schema}.${source.key}`, { object, root, direction }).text),
        };
        return (
          <Field
            key={field.key}
            {...{ field, object, root, path, issues, onChange, fieldSets, direction }}
          />
        );
      })}
    </div>
  );
  if (advancedOnly) return render(advanced);
  return (
    <>
      {render(regular)}
      {advanced.length > 0 && (
        <details
          className="editor-advanced server-advanced"
          open={openAdvanced}
          onToggle={(event) => setOpenAdvanced(event.currentTarget.open)}
        >
          <summary>
            Advanced
            {advanced.some((field) => object[fieldKey(object, field)] !== undefined) && (
              <span>Configured</span>
            )}
          </summary>
          {render(advanced)}
        </details>
      )}
    </>
  );
}
