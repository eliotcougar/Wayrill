import InvalidSettings from './InvalidSettings';
import TunCaptureSetup from './TunCaptureSetup';
import AdvancedSettings from './AdvancedSettings';
import {
  basicGlobalSettings,
  configuredFieldLabels,
  isBasicSetting,
  securityFieldsForRole,
} from '../graph/settingsLayout';
import { EditorTabs, EditorTabPanel, useEditorTabs } from './EditorTabs';
import { useRequestedDiagnostic, focusDiagnostic } from './DiagnosticNavigation';
import useModalDialog from './useModalDialog';
import useFieldValidity from './useFieldValidity';
import useEditorSave from './useEditorSave';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  bindingFor,
  bindingsFor,
  defaultSections,
  globalFields,
  overrideSetting,
  resetNodeDefaults,
  resolveNodeData,
  settingDefaultHint,
} from '../graph/defaults';
import { getDefinition } from '../graph/catalog';
import { fieldsForStructure, settingsFields, type ProtocolField } from '../graph/protocolFields';
import {
  commonPath,
  captureNodeName,
  hydrateProtocolCommon,
  isProtocolKind,
  nativeValue,
  protocolConfig,
  protocolPreview,
  protocolProblems,
  setNative,
  specForKind,
  specForProtocol,
} from '../graph/protocols';
import { jsonDifferences, jsonRecord, parseXrayJson, jsonText, jsonArray } from '../graph/xrayJson';
import type { GlobalDefaults, RuleNode, RuleNodeData } from '../graph/types';
import { coreDefaultHint, formatDefault, valueAt, type DefaultHint } from '../graph/coreDefaults';
import NativeObjectFields from './NativeObjectFields';
import InboundSocketBuffers from './InboundSocketBuffers';
import InheritableSetting from './InheritableSetting';

type EffectiveProtocol = {
  raw: Record<string, unknown>;
  data: RuleNodeData;
  defaults?: GlobalDefaults;
};
function SourceFields({
  object,
  fields,
  id,
  onChange,
  onValidity,
  depth = 0,
  effective,
  path = [],
}: {
  object: Record<string, unknown>;
  fields: ProtocolField[];
  id: string;
  onChange: (o: Record<string, unknown>) => void;
  onValidity: (id: string, valid: boolean) => void;
  depth?: number;
  effective?: EffectiveProtocol;
  path?: string[];
}) {
  const hints: Record<string, DefaultHint> = {};
  for (const field of fields) {
    const nativePath = [...path, field.key],
      value = effective && valueAt(effective.raw, nativePath),
      binding =
        effective &&
        bindingsFor(effective.data.kind).find(
          (b) =>
            commonPath(
              b.nodeKey,
              effective.raw,
              getDefinition(effective.data.kind).category === 'inbound' ? 'inbound' : 'outbound',
            )?.join('/') === nativePath.join('/'),
        );
    hints[field.key] =
      value !== undefined && value !== null && value !== ''
        ? {
            text: formatDefault(value),
            source:
              binding && !effective.data.overrides?.includes(binding.nodeKey)
                ? (settingDefaultHint(
                    effective.data,
                    getDefinition(effective.data.kind).fields.find(
                      (f) => f.key === binding.nodeKey,
                    )!,
                    effective.defaults,
                    effective.raw,
                  )?.source ?? 'core')
                : 'native',
          }
        : coreDefaultHint(field.coreKey!, {
            object,
            root: effective?.raw,
            direction:
              effective && getDefinition(effective.data.kind).category === 'inbound'
                ? 'inbound'
                : 'outbound',
          });
  }
  const direction =
    effective && getDefinition(effective.data.kind).category === 'inbound' ? 'inbound' : 'outbound';
  const basic = fields.filter((f) => isBasicSetting(f.coreKey, direction)),
    advanced = fields.filter((f) => !basic.includes(f));
  const renderFields = (items: ProtocolField[]) => {
    const simple = items.filter((f) => !f.structure || depth >= 4),
      nested = items.filter((f) => f.structure && depth < 4);
    return (
      <>
        <NativeObjectFields
          plain
          object={object}
          fields={simple}
          hints={hints}
          idPrefix={id}
          onChange={onChange}
          onValidity={onValidity}
        />
        {nested.map((field) => (
          <details
            className="protocol-object"
            key={field.key}
            open={!!nativeValue(object, field.key)}
          >
            <summary>
              {field.label}
              {field.collection && jsonArray(nativeValue(object, field.key))
                ? ` (${(nativeValue(object, field.key) as unknown[]).length})`
                : ''}
            </summary>
            {field.collection ? (
              <SourceCollection
                object={object}
                field={field}
                id={`${id}-${field.key}`}
                onChange={onChange}
                onValidity={onValidity}
                effective={effective}
                path={[...path, field.key]}
                depth={depth + 1}
              />
            ) : (
              <SourceFields
                object={
                  jsonRecord(nativeValue(object, field.key))
                    ? (nativeValue(object, field.key) as Record<string, unknown>)
                    : {}
                }
                fields={fieldsForStructure(field.structure!)}
                id={`${id}-${field.key}`}
                effective={effective}
                path={[...path, field.key]}
                onChange={(value) =>
                  onChange(
                    setNative(object, field.key, Object.keys(value).length ? value : undefined),
                  )
                }
                onValidity={onValidity}
                depth={depth + 1}
              />
            )}
          </details>
        ))}
      </>
    );
  };
  return (
    <>
      {renderFields(basic)}
      {!!advanced.length && (
        <AdvancedSettings configured={configuredFieldLabels(object, advanced)}>
          {renderFields(advanced)}
        </AdvancedSettings>
      )}
    </>
  );
}
function SourceCollection({
  object,
  field,
  id,
  onChange,
  onValidity,
  depth,
  effective,
  path = [],
}: {
  object: Record<string, unknown>;
  field: ProtocolField;
  id: string;
  onChange: (o: Record<string, unknown>) => void;
  onValidity: (id: string, valid: boolean) => void;
  depth: number;
  effective?: EffectiveProtocol;
  path?: string[];
}) {
  const value = nativeValue(object, field.key),
    entries = jsonArray(value) ? value : [],
    [index, setIndex] = useState(0),
    active = Math.min(index, Math.max(0, entries.length - 1));
  const { report: validity, blocked: entryBlocked } = useFieldValidity(onValidity);
  // These identities belong to the editor, not the exported Xray array.
  const rowKeys = useRef<number[]>([]),
    nextKey = useRef(0);
  while (rowKeys.current.length < entries.length) rowKeys.current.push(nextKey.current++);
  rowKeys.current.length = entries.length;
  const update = (next: unknown[]) => onChange(setNative(object, field.key, next));
  const move = (delta: number) => {
    const next = [...entries],
      to = active + delta;
    [next[active], next[to]] = [next[to], next[active]];
    [rowKeys.current[active], rowKeys.current[to]] = [rowKeys.current[to], rowKeys.current[active]];
    update(next);
    setIndex(to);
  };
  return (
    <div className="protocol-collection">
      <div className="protocol-collection-tools">
        <select
          className="text-control"
          aria-label={`${field.label} entry`}
          value={active}
          disabled={entryBlocked}
          aria-describedby={entryBlocked ? `${id}-entry-error` : undefined}
          onChange={(e) => {
            if (!entryBlocked) setIndex(Number(e.target.value));
          }}
        >
          {entries.map((entry, i) => (
            <option key={i} value={i}>
              {i + 1}.{' '}
              {jsonRecord(entry)
                ? jsonText(
                    entry.email ??
                      entry.address ??
                      entry.endpoint ??
                      entry.name ??
                      `Entry ${i + 1}`,
                  )
                : 'Native value'}
            </option>
          ))}
        </select>
        <button
          className="secondary-button"
          disabled={entries.length >= 1024 || entryBlocked}
          onClick={() => {
            update([...entries, {}]);
            setIndex(entries.length);
          }}
        >
          <Plus size={14} />
          Add {field.label.toLowerCase()}
        </button>
        <button
          className="icon-button"
          aria-label={`Remove ${field.label} entry`}
          disabled={!entries.length}
          onClick={() => {
            rowKeys.current.splice(active, 1);
            update(entries.filter((_, i) => i !== active));
            setIndex(Math.max(0, active - 1));
          }}
        >
          <Trash2 size={14} />
        </button>
        <button
          className="icon-button"
          aria-label={`Move ${field.label} entry up`}
          disabled={!entries.length || active === 0 || entryBlocked}
          onClick={() => move(-1)}
        >
          <ArrowUp size={14} />
        </button>
        <button
          className="icon-button"
          aria-label={`Move ${field.label} entry down`}
          disabled={!entries.length || active === entries.length - 1 || entryBlocked}
          onClick={() => move(1)}
        >
          <ArrowDown size={14} />
        </button>
      </div>
      {entryBlocked && (
        <p className="field-message error" id={`${id}-entry-error`}>
          Correct invalid fields before changing entries.
        </p>
      )}
      {entries.length > 0 && jsonRecord(entries[active]) ? (
        <SourceFields
          key={`${id}-${rowKeys.current[active]}`}
          object={entries[active]}
          fields={fieldsForStructure(field.structure!)}
          id={`${id}-${active}`}
          effective={effective}
          path={[...path, String(active)]}
          depth={depth}
          onValidity={validity}
          onChange={(entry) => update(entries.map((e, i) => (i === active ? entry : e)))}
        />
      ) : (
        <p className="runtime-scope">
          Add an entry, or use Native JSON for extended layouts. Entry order is preserved.
        </p>
      )}
    </div>
  );
}
const pf = (
  key: string,
  label: string,
  type: ProtocolField['type'],
  extra: Partial<ProtocolField> = {},
): ProtocolField => ({ key, label, type, context: 'protocol', ...extra });
const listenerFields = [
  pf('listen', 'Listen address', 'text', {
    coreKey: 'Inbound.listen',
    help: 'IPv4 or IPv6 address, including 0.0.0.0 / :: for all interfaces, or localhost. Native Unix sockets can be exported.',
  }),
  pf('port', 'Listen port(s) (JSON)', 'json', {
    coreKey: 'Inbound.port',
    help: 'An integer from 1 to 65535. Native port range strings can be exported.',
  }),
];
const streamFields = [
  pf('network', 'Transport', 'select', {
    coreKey: 'StreamConfig.network',
    options: [
      'raw',
      'tcp',
      'xhttp',
      'splithttp',
      'ws',
      'httpupgrade',
      'grpc',
      'kcp',
      'hysteria',
      'masque',
      'xdrive',
    ],
  }),
  pf('security', 'Transport security', 'select', {
    coreKey: 'StreamConfig.security',
    options: ['none', 'tls', 'reality'],
  }),
  pf('address', 'Stream endpoint override', 'text', { coreKey: 'StreamConfig.address' }),
  pf('port', 'Stream port override', 'integer', {
    coreKey: 'StreamConfig.port',
    min: 0,
    max: 65535,
  }),
];
const transports: Record<string, [string, Parameters<typeof fieldsForStructure>[0]]> = {
  raw: ['rawSettings', 'TCPConfig'],
  tcp: ['tcpSettings', 'TCPConfig'],
  xhttp: ['xhttpSettings', 'SplitHTTPConfig'],
  splithttp: ['splithttpSettings', 'SplitHTTPConfig'],
  ws: ['wsSettings', 'WebSocketConfig'],
  httpupgrade: ['httpupgradeSettings', 'HttpUpgradeConfig'],
  grpc: ['grpcSettings', 'GRPCConfig'],
  kcp: ['kcpSettings', 'KCPConfig'],
  hysteria: ['hysteriaSettings', 'HysteriaConfig'],
  masque: ['masqueSettings', 'MasqueConfig'],
  xdrive: ['xdriveSettings', 'XDriveConfig'],
};
function initialDraft(node: RuleNode): { value: Record<string, unknown>; error: string } {
  try {
    const value = parseXrayJson(String(node.data.settings.json));
    if (!jsonRecord(value)) throw new Error('Use a JSON object.');
    return { value, error: '' };
  } catch (e) {
    return { value: {}, error: e instanceof Error ? e.message : 'Invalid JSON.' };
  }
}
export default function ProtocolEditor({
  node,
  defaults,
  automaticFakeDnsRecovery = false,
  onApply,
  onClose,
}: {
  node: RuleNode;
  defaults?: GlobalDefaults;
  automaticFakeDnsRecovery?: boolean;
  onApply: (id: string, data: Partial<RuleNodeData>) => void;
  onClose: () => void;
}) {
  const requested = useRequestedDiagnostic();
  const initial = useMemo(() => initialDraft(node), [node]),
    typed = isProtocolKind(node.data.kind),
    direction = getDefinition(node.data.kind).category === 'inbound' ? 'inbound' : 'outbound',
    dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState(node.data),
    [draft, setDraft] = useState(() => initial.value),
    [raw, setRaw] = useState(String(node.data.settings.json)),
    [rawError, setRawError] = useState(initial.error),
    [tab, setTab] = useState(requested?.fieldKey === 'json' ? 'json' : 'protocol'),
    [formRevision, setFormRevision] = useState(0);
  const { invalid, report: validity } = useFieldValidity();
  const { save, saveError } = useEditorSave(onClose);
  const spec = typed
    ? specForKind(node.data.kind)
    : specForProtocol(nativeValue(draft, 'protocol'), direction);

  const change = (next: Record<string, unknown>) => {
    if (typed) {
      const paths = jsonDifferences(draft, next).map((p) =>
        p
          .slice(1)
          .split('/')
          .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~')),
      );
      const keys = bindingsFor(data.kind)
        .filter((b) =>
          [commonPath(b.nodeKey, draft, direction), commonPath(b.nodeKey, next, direction)].some(
            (path) =>
              path &&
              paths.some((changed) =>
                changed
                  .slice(0, Math.min(path.length, changed.length))
                  .every(
                    (part, i) => path[i] === '*' || path[i].toLowerCase() === part.toLowerCase(),
                  ),
              ),
          ),
        )
        .map((b) => b.nodeKey);
      if (keys.length)
        setData((previous) => {
          const settings = hydrateProtocolCommon(next, previous.settings, direction),
            baseline = parseXrayJson(String(previous.settings.commonBaseline || '{}')) as Record<
              string,
              unknown
            >;
          for (const key of keys) baseline[key] = settings[key];
          return {
            ...previous,
            settings: { ...settings, commonBaseline: JSON.stringify(baseline) },
            overrides: [...new Set([...(previous.overrides ?? []), ...keys])],
            ...(previous.native
              ? {
                  native: {
                    ...previous.native,
                    editedKeys: previous.native.editedKeys?.filter((k) => !keys.includes(k)),
                  },
                }
              : {}),
          };
        });
    }
    setDraft(next);
    setRaw(JSON.stringify(next, null, 2));
    setRawError('');
  };
  const object = (key: string) =>
    jsonRecord(nativeValue(draft, key)) ? (nativeValue(draft, key) as Record<string, unknown>) : {};
  const section = (key: string, value: Record<string, unknown>) =>
    change(setNative(draft, key, Object.keys(value).length ? value : undefined));
  const stream = object('streamSettings'),
    transport =
      transports[
        jsonText(nativeValue(stream, 'method') ?? nativeValue(stream, 'network') ?? 'raw')
      ],
    security = jsonText(nativeValue(stream, 'security') ?? 'none');
  const current = resolveNodeData(
      { ...data, settings: { ...data.settings, json: JSON.stringify(draft, null, 2) } },
      defaults,
    ),
    issues = typed ? protocolProblems(current) : [],
    blocked =
      !!rawError ||
      Object.values(invalid).some(Boolean) ||
      issues.some((i) => i.severity === 'error');
  let effective: EffectiveProtocol = { raw: draft, data: current, defaults };
  try {
    if (typed) effective = { raw: protocolPreview(current), data: current, defaults };
  } catch {
    /* Invalid drafts keep the core-only hints. */
  }
  const tabs = useEditorTabs(
    [
      [
        'protocol',
        spec?.protocol === 'tun'
          ? 'Adapter'
          : direction === 'inbound'
            ? 'Listener & accounts'
            : 'Server & account',
      ],
      ...(spec?.protocol === 'tun' ? [] : [['transport', 'Transport & security']]),
      ['advanced', direction === 'inbound' ? 'Name detection' : 'Connections & mux'],
      ...(typed ? [['defaults', 'Global defaults']] : []),
      ['json', 'Native JSON'],
    ].map(([key, label]) => ({ key, label })),
    tab,
    setTab,
  );
  useModalDialog(dialog);
  const sharedChange = (next: RuleNodeData) => {
    setData(next);
    if (rawError) return;
    try {
      const value = setNative(protocolPreview(next), 'tag', undefined);
      setDraft(value);
      setRaw(JSON.stringify(value, null, 2));
    } catch {
      /* Retain invalid shared-field drafts until they are corrected. */
    }
  };
  const apply = () => {
    save(() => {
      const next = current;
      if (typed) protocolConfig(next);
      onApply(node.id, {
        ...(spec?.protocol === 'tun' ? { label: captureNodeName(next) } : {}),
        settings: next.settings,
        overrides: next.overrides,
        native: next.native,
      });
    });
  };
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window protocol-editor-window"
      aria-labelledby="protocol-editor-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <div className="rule-editor-titlebar">
        <div>
          <h2 id="protocol-editor-title">
            {spec?.protocol === 'tun'
              ? spec.title
              : `${spec?.title ?? 'Native Xray'} ${direction === 'inbound' ? 'inbound' : 'outbound'}`}
          </h2>
          {spec?.note && <p>{spec.note}</p>}
        </div>
        <button className="icon-button" aria-label="Close protocol editor" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <EditorTabs tabs={tabs} label="Protocol sections" />
      <EditorTabPanel
        key={`protocol-${formRevision}`}
        tabs={tabs}
        tab="protocol"
        className="runtime-body"
      >
        {direction === 'inbound' && spec?.protocol !== 'tun' && (
          <>
            <h3>Listener</h3>
            <NativeObjectFields
              object={draft}
              fields={listenerFields}
              idPrefix="protocol-listener"
              onChange={change}
              onValidity={validity}
            />
          </>
        )}
        {spec?.protocol === 'tun' && (
          <>
            <TunCaptureSetup
              settings={object('settings')}
              onChange={(o) => section('settings', o)}
            />
            <label className="check-control">
              <input
                type="checkbox"
                disabled={automaticFakeDnsRecovery}
                checked={
                  automaticFakeDnsRecovery ||
                  (object('sniffing').enabled === true &&
                    jsonArray(object('sniffing').destOverride) &&
                    (object('sniffing').destOverride as unknown[]).some(
                      (name) => name === 'fakedns' || name === 'fakedns+others',
                    ))
                }
                onChange={(event) => {
                  const sniffing = object('sniffing');
                  const names = jsonArray(sniffing.destOverride) ? sniffing.destOverride : [];
                  const recovery = (name: unknown) =>
                    name === 'fakedns' || name === 'fakedns+others';
                  section('sniffing', {
                    ...sniffing,
                    ...(event.target.checked ? { enabled: true } : {}),
                    destOverride: event.target.checked
                      ? names.some(recovery)
                        ? names
                        : [...names, 'fakedns']
                      : names.filter((name) => !recovery(name)),
                  });
                }}
              />
              Recover FakeDNS names{automaticFakeDnsRecovery ? ' · Automatic' : ''}
            </label>
          </>
        )}
        {data.kind === 'tun-inbound' && (
          <label className="check-control">
            <input
              type="checkbox"
              checked={data.settings.separateNatTraffic === true}
              onChange={(event) =>
                setData({
                  ...data,
                  settings: { ...data.settings, separateNatTraffic: event.target.checked },
                })
              }
            />
            Separate Windows NAT traffic
          </label>
        )}
        <h3>{spec?.protocol === 'tun' ? 'Adapter configuration' : 'Protocol settings'}</h3>
        {spec ? (
          <SourceFields
            key={spec.protocol}
            object={object('settings')}
            fields={settingsFields(spec, object('settings'))}
            id="protocol-settings"
            effective={effective}
            path={['settings']}
            onChange={(o) => section('settings', o)}
            onValidity={validity}
          />
        ) : (
          <p>Use Native JSON for this protocol.</p>
        )}
      </EditorTabPanel>
      <EditorTabPanel
        key={`transport-${formRevision}`}
        tabs={tabs}
        tab="transport"
        className="runtime-body"
      >
        <h3>Stream</h3>
        <NativeObjectFields
          object={stream}
          fields={streamFields.map((f) =>
            f.key === 'network' && nativeValue(stream, 'method') !== undefined
              ? { ...f, key: 'method', coreKey: 'StreamConfig.method' }
              : f,
          )}
          idPrefix="protocol-stream"
          onChange={(o) => section('streamSettings', o)}
          onValidity={validity}
        />
        {transport && (
          <>
            <h3>{transport[0]}</h3>
            <SourceFields
              object={
                jsonRecord(nativeValue(stream, transport[0]))
                  ? (nativeValue(stream, transport[0]) as Record<string, unknown>)
                  : {}
              }
              fields={fieldsForStructure(transport[1])}
              id="protocol-transport"
              effective={effective}
              path={['streamSettings', transport[0]]}
              onChange={(o) =>
                section(
                  'streamSettings',
                  setNative(stream, transport[0], Object.keys(o).length ? o : undefined),
                )
              }
              onValidity={validity}
            />
          </>
        )}
        {['tls', 'reality'].includes(security) && (
          <>
            <h3>
              {security.toUpperCase()} {direction === 'inbound' ? 'server' : 'client'}
            </h3>
            <SourceFields
              object={
                jsonRecord(nativeValue(stream, `${security}Settings`))
                  ? (nativeValue(stream, `${security}Settings`) as Record<string, unknown>)
                  : {}
              }
              fields={securityFieldsForRole(
                fieldsForStructure(security === 'tls' ? 'TLSConfig' : 'REALITYConfig'),
                security,
                direction,
                object(`${security}Settings`),
              )}
              id="protocol-security"
              effective={effective}
              path={['streamSettings', `${security}Settings`]}
              onChange={(o) =>
                section(
                  'streamSettings',
                  setNative(stream, `${security}Settings`, Object.keys(o).length ? o : undefined),
                )
              }
              onValidity={validity}
            />
          </>
        )}
        <h3>FinalMask</h3>
        <SourceFields
          object={
            jsonRecord(nativeValue(stream, 'finalmask'))
              ? (nativeValue(stream, 'finalmask') as Record<string, unknown>)
              : {}
          }
          fields={fieldsForStructure('FinalMask')}
          id="protocol-finalmask"
          effective={effective}
          path={['streamSettings', 'finalmask']}
          onChange={(o) =>
            section(
              'streamSettings',
              setNative(stream, 'finalmask', Object.keys(o).length ? o : undefined),
            )
          }
          onValidity={validity}
        />
      </EditorTabPanel>
      <EditorTabPanel
        key={`advanced-${formRevision}`}
        tabs={tabs}
        tab="advanced"
        className="runtime-body"
      >
        {direction === 'inbound' ? (
          <>
            <h3>Name detection</h3>
            <SourceFields
              object={object('sniffing')}
              fields={fieldsForStructure('SniffingConfig')}
              id="protocol-sniffing"
              effective={effective}
              path={['sniffing']}
              onChange={(o) => section('sniffing', o)}
              onValidity={validity}
            />
          </>
        ) : (
          <>
            <AdvancedSettings
              title="Local connection"
              configured={configuredFieldLabels(draft, [
                { key: 'sendThrough', label: 'Source IP / CIDR' },
                { key: 'targetStrategy', label: 'Target DNS strategy' },
              ])}
            >
              <NativeObjectFields
                object={draft}
                fields={[
                  pf('sendThrough', 'Source IP / CIDR', 'text', {
                    coreKey: 'Outbound.sendThrough',
                  }),
                  pf('targetStrategy', 'Target DNS strategy', 'text', {
                    coreKey: 'SocketConfig.domainStrategy',
                  }),
                ]}
                idPrefix="protocol-outbound-common"
                onChange={change}
                onValidity={validity}
              />
            </AdvancedSettings>
            <h3>Multiplexing</h3>
            {spec?.protocol === 'masque' ? (
              <p>MASQUE does not support mux.</p>
            ) : (
              <SourceFields
                object={object('mux')}
                fields={fieldsForStructure('MuxConfig')}
                id="protocol-mux"
                effective={effective}
                path={['mux']}
                onChange={(o) => section('mux', o)}
                onValidity={validity}
              />
            )}
          </>
        )}
        {direction === 'inbound' && (
          <InboundSocketBuffers
            input={draft}
            effective={effective.raw}
            globalDefaults={defaults}
            onValidity={validity}
            onChange={(sockopt) => {
              const inheritedStream = nativeValue(effective.raw, 'streamSettings');
              section(
                'streamSettings',
                setNative(
                  jsonRecord(inheritedStream) ? inheritedStream : stream,
                  'sockopt',
                  Object.keys(sockopt).length ? sockopt : undefined,
                ),
              );
            }}
          />
        )}
        <h3>Socket settings</h3>
        <SourceFields
          object={
            jsonRecord(nativeValue(stream, 'sockopt'))
              ? (nativeValue(stream, 'sockopt') as Record<string, unknown>)
              : {}
          }
          fields={fieldsForStructure('SocketConfig')}
          id="protocol-socket"
          effective={effective}
          path={['streamSettings', 'sockopt']}
          onChange={(o) =>
            section(
              'streamSettings',
              setNative(stream, 'sockopt', Object.keys(o).length ? o : undefined),
            )
          }
          onValidity={validity}
        />
      </EditorTabPanel>
      <EditorTabPanel
        key={`defaults-${formRevision}`}
        tabs={tabs}
        tab="defaults"
        className="runtime-body"
      >
        <p className="runtime-scope">
          Imported native values are retained until you edit an override or choose Use default.
          Defaults apply to active transports; server credentials and adapter settings remain
          specific to this node.
        </p>
        {typed &&
          defaultSections.map((group) => {
            const fields = getDefinition(data.kind).fields.filter((f) => {
              const binding = bindingFor(data.kind, f.key);
              return (
                binding && globalFields.find((g) => g.key === binding.key)?.section === group.id
              );
            });
            if (!fields.length) return null;
            const render = (items: typeof fields) => (
              <section className="protocol-defaults-group" aria-label={group.title}>
                <div className="defaults-field-grid">
                  {items.map((field) => (
                    <div
                      key={field.key}
                      className={
                        ['json', 'textarea'].includes(field.type) ? 'wide-option' : undefined
                      }
                    >
                      <InheritableSetting
                        data={current}
                        defaults={defaults}
                        preparedRoot={effective?.raw ?? null}
                        field={field}
                        value={current.settings[field.key]}
                        issues={[]}
                        idPrefix="protocol-default"
                        onValidity={validity}
                        onReset={
                          defaults
                            ? () => sharedChange(resetNodeDefaults(current, defaults, field.key))
                            : undefined
                        }
                        onOverride={() =>
                          sharedChange({
                            ...current,
                            ...overrideSetting(current, field.key, current.settings[field.key]),
                          })
                        }
                        onChange={(value) =>
                          sharedChange({
                            ...current,
                            ...overrideSetting(current, field.key, value),
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              </section>
            );
            const basic = fields.filter((f) =>
                basicGlobalSettings.has(bindingFor(data.kind, f.key)!.key),
              ),
              advanced = fields.filter((f) => !basic.includes(f));
            return (
              <section key={group.id}>
                <h3>{group.title}</h3>
                {!!basic.length && render(basic)}
                {!!advanced.length && (
                  <AdvancedSettings
                    configured={advanced
                      .filter((f) => current.overrides?.includes(f.key))
                      .map((f) => f.label)}
                  >
                    {render(advanced)}
                  </AdvancedSettings>
                )}
              </section>
            );
          })}
      </EditorTabPanel>
      <EditorTabPanel tabs={tabs} tab="json" className="runtime-body">
        <label className="editor-field">
          <span>Native protocol options</span>
          <textarea
            className="text-control"
            rows={21}
            spellCheck={false}
            data-diagnostic-field="json"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              try {
                const value = parseXrayJson(e.target.value);
                if (!jsonRecord(value)) throw new Error('Use a JSON object.');
                change(value);
                setFormRevision((revision) => revision + 1);
                setRaw(e.target.value);
              } catch (error) {
                setRawError(error instanceof Error ? error.message : 'Invalid JSON.');
              }
            }}
          />
        </label>
        <p className="runtime-scope">
          Unknown fields, aliases and ordered arrays are preserved. Keep the node tag in Properties.
          Configurations and previews include credentials.
        </p>
      </EditorTabPanel>
      <InvalidSettings
        invalid={invalid}
        fields={getDefinition(data.kind).fields}
        onReview={(id) => {
          setTab(
            id.startsWith('protocol-default-')
              ? 'defaults'
              : id.startsWith('protocol-settings-') || id.startsWith('protocol-listener-')
                ? 'protocol'
                : [
                      'protocol-stream-',
                      'protocol-transport-',
                      'protocol-security-',
                      'protocol-finalmask-',
                    ].some((prefix) => id.startsWith(prefix))
                  ? 'transport'
                  : 'advanced',
          );
          requestAnimationFrame(() => {
            if (dialog.current)
              focusDiagnostic(dialog.current, { severity: 'error', message: '', controlId: id });
          });
        }}
      />
      {(rawError || saveError || issues.length > 0) && (
        <div className="rule-editor-diagnostics" role="alert">
          {rawError && <p className="error">{rawError}</p>}
          {saveError && <p className="error">{saveError}</p>}
          {issues.map((issue, i) => (
            <p className={issue.severity} key={i}>
              {issue.message}
            </p>
          ))}
        </div>
      )}
      <div className="rule-editor-footer">
        <button className="secondary-button" onClick={onClose}>
          Cancel
        </button>
        <button className="primary-button" disabled={blocked} onClick={apply}>
          Apply protocol settings
        </button>
      </div>
    </dialog>
  );
}
