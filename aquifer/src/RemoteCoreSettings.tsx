import { useEffect, useRef, useState, type ReactNode } from 'react';
import { jsonArray, jsonRecord, jsonText } from './graph/xrayJson';
import { ipProblem } from './graph/addressValidation';
import { get, objectAt, propertyKey, setProperty } from './nativeProperties';
import type { InboundIssue, ServerObject } from './inboundFields';
import ServerFields from './ServerFields';
import MapInput from './MapInput';
import { fieldsIssues, settingsStructures } from './settingsFields';
import type { RouteDestination } from './routingEditor';
import type { ApiListener } from './apiPlumbing';

export const coreTabs = [
  'Logging',
  'Routing',
  'Connections',
  'Statistics & API',
  'Resources',
  'Advanced',
];
export const apiServices: Record<string, string> = {
  StatsService: 'Traffic statistics',
  HandlerService: 'Manage inbounds and outbounds',
  RoutingService: 'Manage routing',
  LoggerService: 'Restart logging',
  ObservatoryService: 'Observatory results',
  ReflectionService: 'API reflection',
};
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="server-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
export function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check-label">
      <input
        aria-label={label}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

/** Immutable native-property update; opening the form never materializes defaults. */
export function setCoreProperty(value: ServerObject, path: string[], entry: unknown): ServerObject {
  const [key, ...rest] = path;
  if (!rest.length) {
    if (
      key.toLowerCase() === 'log' &&
      get(value, key) == null &&
      jsonRecord(entry) &&
      get(entry, 'access') === undefined
    )
      entry = { ...entry, access: 'none' };
    return setProperty(value, key, entry);
  }
  let parent = objectAt(value, key);
  // An absent log block disables access logging, whereas an empty block enables it.
  if (key.toLowerCase() === 'log' && get(value, key) == null && rest[0].toLowerCase() !== 'access')
    parent = { access: 'none' };
  return setProperty(value, key, setCoreProperty(parent, rest, entry));
}

export function ApiFields({
  value,
  onChange,
  issues = [],
  path = '',
  existingListeners = false,
}: {
  value: ServerObject;
  onChange: (value: ServerObject) => void;
  issues?: InboundIssue[];
  path?: string;
  existingListeners?: boolean;
}) {
  const services = get(value, 'services'),
    names = jsonArray(services) ? services.map(String) : [];
  return (
    <div className="server-inbound-editor">
      <ServerFields
        object={value}
        root={value}
        schema="APIConfig"
        fieldSets={{
          ...settingsStructures,
          APIConfig: settingsStructures.APIConfig.map((field) =>
            existingListeners && field.key === 'listen'
              ? {
                  ...field,
                  label: 'Additional API listen address',
                  placeholder: 'No additional listener',
                }
              : field,
          ),
        }}
        issues={issues}
        path={path}
        onChange={onChange}
      />
      <fieldset className="settings-checkboxes">
        <legend>API services</legend>
        {[
          ...Object.keys(apiServices),
          ...names.filter(
            (name) =>
              !Object.keys(apiServices).some((key) => key.toLowerCase() === name.toLowerCase()),
          ),
        ].map((name) => (
          <Toggle
            key={name}
            label={apiServices[name] ?? name}
            checked={names.some((key) => key.toLowerCase() === name.toLowerCase())}
            onChange={(checked) =>
              onChange(
                setProperty(
                  value,
                  'services',
                  checked
                    ? [...names, name]
                    : names.filter((key) => key.toLowerCase() !== name.toLowerCase()),
                ),
              )
            }
          />
        ))}
      </fieldset>
    </div>
  );
}

export default function RemoteCoreSettings({
  value,
  tab,
  issues,
  focusPath,
  destinations,
  onChange,
  apiListeners = [],
  onApiListenersChange,
}: {
  value: ServerObject;
  tab: string;
  issues: InboundIssue[];
  focusPath: string;
  destinations: RouteDestination[];
  onChange: (value: ServerObject) => void;
  apiListeners?: ApiListener[];
  onApiListenersChange?: (value: ApiListener[]) => void;
}) {
  const [level, setLevel] = useState('0'),
    [newLevel, setNewLevel] = useState(''),
    [levelError, setLevelError] = useState('');
  const [customSchedule, setCustomSchedule] = useState(false);
  const retained = useRef<ServerObject>({});
  const originalNames = useRef(value);
  useEffect(() => {
    const match = /^policy\.levels\.(\d+)\./.exec(focusPath);
    if (match) setLevel(match[1]);
  }, [focusPath]);
  const object = (name: string) => objectAt(value, name);
  const change = (path: string[], entry: unknown) =>
    onChange(
      setCoreProperty(
        value,
        [propertyKey(originalNames.current, path[0]), ...path.slice(1)],
        entry,
      ),
    );
  const fields = (
    schema: string,
    entry: ServerObject,
    path: string[],
    update?: (next: ServerObject) => void,
  ) => (
    <ServerFields
      schema={schema}
      object={entry}
      root={value}
      path={path.length ? path.join('.') + '.' : ''}
      fieldSets={settingsStructures}
      issues={issues}
      onChange={update ?? ((next) => change(path, next))}
    />
  );
  const enabled = (name: string) => jsonRecord(get(value, name));
  const toggle = (name: string, checked: boolean, initial: unknown) => {
    if (!checked) retained.current[name] = get(value, name);
    change([name], checked ? (retained.current[name] ?? initial) : undefined);
  };
  if (tab === 'Logging') {
    const log = object('log'),
      off = String(get(log, 'loglevel')).toLowerCase() === 'none';
    const level = jsonText(get(log, 'loglevel') ?? '');
    return (
      <div className="server-inbound-editor">
        <label className="server-choice">
          Log level
          <select
            aria-label="Log level"
            value={level}
            onChange={(event) => change(['log', 'loglevel'], event.target.value || undefined)}
          >
            <option value="">Default (Warning)</option>
            {[
              ...new Set(['debug', 'info', 'warning', 'error', 'none', ...(level ? [level] : [])]),
            ].map((item) => (
              <option key={item} value={item}>
                {(
                  {
                    debug: 'Debug',
                    info: 'Information',
                    warning: 'Warning',
                    error: 'Error',
                    none: 'Off',
                  } as Record<string, string>
                )[item] ?? item}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="settings-unboxed" disabled={off}>
          <div className="server-fields-grid">
            {(['access', 'error'] as const).map((key) => {
              const entry = get(log, key),
                name = key === 'access' ? 'Access log' : 'Error log';
              const mode =
                entry === undefined
                  ? 'default'
                  : entry === 'none'
                    ? 'off'
                    : entry === ''
                      ? 'console'
                      : 'file';
              return (
                <div className="server-choice" key={key}>
                  <label>
                    {name}
                    <select
                      aria-label={name}
                      value={mode}
                      onChange={(event) =>
                        change(
                          ['log', key],
                          (
                            {
                              default: undefined,
                              off: 'none',
                              console: '',
                              file: `/var/log/xray/${key}.log`,
                            } as Record<string, unknown>
                          )[event.target.value],
                        )
                      }
                    >
                      <option value="default">
                        Default ({key === 'access' && !enabled('log') ? 'off' : 'console'})
                      </option>
                      <option value="off">Off</option>
                      <option value="console">Console / journal</option>
                      <option value="file">File on server</option>
                    </select>
                  </label>
                  {mode === 'file' && (
                    <label>
                      Path on server
                      <input
                        aria-label={`${name} path on server`}
                        value={jsonText(entry)}
                        onChange={(event) => change(['log', key], event.target.value || null)}
                        spellCheck={false}
                      />
                    </label>
                  )}
                </div>
              );
            })}
          </div>
          <Toggle
            label="Log DNS queries"
            checked={get(log, 'dnsLog') === true}
            onChange={(checked) => change(['log', 'dnsLog'], checked)}
          />
        </fieldset>
        {off && (
          <p className="server-field-hint">
            All logging is disabled. Destination settings are retained.
          </p>
        )}
        <ServerFields
          object={log}
          root={value}
          schema="LogPrivacy"
          fieldSets={{
            LogPrivacy: [
              {
                key: 'maskAddress',
                label: 'Mask IP addresses in logs',
                type: 'select',
                choices: ['quarter', 'half', 'full'],
                placeholder: 'Off',
                optionLabels: {
                  quarter: 'Strong masking (IPv4 /8, IPv6 /16)',
                  half: 'Partial masking (IPv4 /16, IPv6 /32)',
                  full: 'Mask entire address',
                },
              },
            ],
          }}
          onChange={(next) => change(['log'], next)}
        />
      </div>
    );
  }
  if (tab === 'Routing') return fields('RoutingOptions', object('routing'), ['routing']);
  if (tab === 'Connections') {
    const policy = object('policy'),
      levels = objectAt(policy, 'levels'),
      selected = jsonRecord(levels[level]) ? levels[level] : {};
    const options = [...new Set(['0', ...Object.keys(levels), level])].sort(
      (a, b) => Number(a) - Number(b),
    );
    const updateLevel = (next: ServerObject) =>
      change(['policy', 'levels'], { ...levels, [level]: next });
    return (
      <div className="server-inbound-editor">
        <p className="server-field-hint">Each user’s policy level selects its connection limits.</p>
        <div className="settings-inline-row">
          <label>
            User policy level
            <select
              aria-label="User policy level"
              value={level}
              onChange={(event) => setLevel(event.target.value)}
            >
              {options.map((key) => (
                <option key={key} value={key}>
                  Level {key}
                  {!Object.hasOwn(levels, key) ? ' (Xray defaults)' : ''}
                </option>
              ))}
            </select>
          </label>
          {Object.hasOwn(levels, level) && (
            <button
              type="button"
              onClick={() => {
                const next = { ...levels };
                delete next[level];
                change(['policy', 'levels'], next);
                setLevel('0');
              }}
            >
              Remove level
            </button>
          )}
        </div>
        {fields('ConnectionPolicy', selected, ['policy', 'levels', level], updateLevel)}
        <p className="server-field-hint">
          Buffer default depends on the server platform and XRAY_BUFFER_SIZE.
        </p>
        <fieldset className="settings-checkboxes">
          <legend>Per-user counters</legend>
          {!enabled('stats') && (
            <button type="button" onClick={() => toggle('stats', true, {})}>
              Enable traffic statistics
            </button>
          )}
          {(
            [
              ['statsUserUplink', 'Uploaded bytes'],
              ['statsUserDownlink', 'Downloaded bytes'],
              ['statsUserOnline', 'Online users'],
            ] as const
          ).map(([key, label]) => (
            <Toggle
              key={key}
              label={label}
              checked={get(selected, key) === true}
              onChange={(checked) => updateLevel(setProperty(selected, key, checked))}
            />
          ))}
        </fieldset>
        <div className="settings-inline-row">
          <label>
            New policy level
            <input
              aria-label="New policy level"
              inputMode="numeric"
              value={newLevel}
              onChange={(event) => {
                setNewLevel(event.target.value);
                setLevelError('');
              }}
            />
          </label>
          <button
            type="button"
            disabled={!newLevel}
            onClick={() => {
              if (!/^\d+$/.test(newLevel) || Number(newLevel) > 4294967295) {
                setLevelError('Enter a whole number from 0 to 4294967295.');
                return;
              }
              const key = String(Number(newLevel));
              if (Object.hasOwn(levels, key)) {
                setLevelError('This policy level already exists.');
                return;
              }
              change(['policy', 'levels'], { ...levels, [key]: {} });
              setLevel(key);
              setNewLevel('');
              setLevelError('');
            }}
          >
            Add level
          </button>
        </div>
        {levelError && (
          <p role="alert" className="server-field-error">
            {levelError}
          </p>
        )}
      </div>
    );
  }
  if (tab === 'Statistics & API') {
    const system = objectAt(object('policy'), 'system');
    return (
      <div className="server-inbound-editor">
        <Section title="Traffic statistics">
          <Toggle
            label="Enable traffic statistics"
            checked={enabled('stats')}
            onChange={(checked) => toggle('stats', checked, {})}
          />
          <fieldset className="settings-checkboxes" disabled={!enabled('stats')}>
            <legend>System counters</legend>
            {(
              [
                ['statsInboundUplink', 'Inbound upload'],
                ['statsInboundDownlink', 'Inbound download'],
                ['statsOutboundUplink', 'Outbound upload'],
                ['statsOutboundDownlink', 'Outbound download'],
              ] as const
            ).map(([key, label]) => (
              <Toggle
                key={key}
                label={label}
                checked={get(system, key) === true}
                onChange={(checked) => change(['policy', 'system', key], checked)}
              />
            ))}
          </fieldset>
        </Section>
        <Section title="Management API">
          <Toggle
            label="Enable management API"
            checked={enabled('api')}
            onChange={(checked) => toggle('api', checked, { tag: 'api', services: [] })}
          />
          {enabled('api') && (
            <>
              <ApiFields
                value={object('api')}
                onChange={(next) => change(['api'], next)}
                issues={issues}
                path="api."
                existingListeners={apiListeners.length > 0}
              />
              {apiListeners.map((listener) => (
                <section key={listener.index} className="server-collection-item">
                  <header>
                    <strong>
                      API listener
                      {apiListeners.length > 1 ? ` ${apiListeners.indexOf(listener) + 1}` : ''}
                    </strong>
                    <button
                      type="button"
                      onClick={() =>
                        onApiListenersChange?.(
                          apiListeners.filter((item) => item.index !== listener.index),
                        )
                      }
                    >
                      Remove listener
                    </button>
                  </header>
                  <ServerFields
                    object={listener.value}
                    root={listener.value}
                    schema="ApiListener"
                    path={`apiListeners.${listener.index}.`}
                    issues={issues}
                    fieldSets={{
                      ApiListener: [
                        { key: 'listen', label: 'Bind address', placeholder: 'All addresses' },
                        { key: 'port', label: 'Listen port', type: 'port', required: true },
                      ],
                    }}
                    onChange={(next) =>
                      onApiListenersChange?.(
                        apiListeners.map((item) =>
                          item.index === listener.index ? { ...item, value: next } : item,
                        ),
                      )
                    }
                  />
                </section>
              ))}
            </>
          )}
        </Section>
        <Section title="Metrics endpoint">
          <Toggle
            label="Enable metrics endpoint"
            checked={enabled('metrics')}
            onChange={(checked) => toggle('metrics', checked, { listen: '127.0.0.1:11111' })}
          />
          {enabled('metrics') && fields('MetricsConfig', object('metrics'), ['metrics'])}
        </Section>
      </div>
    );
  }
  if (tab === 'Resources') {
    const geodata = object('geodata'),
      cron = get(geodata, 'cron'),
      schedules: Record<string, string> = {
        '@hourly': 'Hourly',
        '@daily': 'Daily',
        '@weekly': 'Weekly',
      };
    const custom =
      customSchedule || (cron !== undefined && !Object.hasOwn(schedules, jsonText(cron)));
    const fake = get(value, 'fakedns'),
      pools = jsonArray(fake) ? fake : jsonRecord(fake) ? [fake] : [];
    return (
      <div className="server-inbound-editor">
        <Section title="Geosite / GeoIP updates">
          <Toggle
            label="Automatically update resource files"
            checked={cron !== undefined && cron !== null}
            onChange={(checked) => {
              change(['geodata', 'cron'], checked ? '@daily' : undefined);
              setCustomSchedule(false);
            }}
          />
          {cron != null && (
            <div className="server-fields-grid">
              <label>
                Update schedule
                <select
                  aria-label="Update schedule"
                  value={custom ? 'custom' : jsonText(cron)}
                  onChange={(event) => {
                    const custom = event.target.value === 'custom';
                    setCustomSchedule(custom);
                    change(['geodata', 'cron'], custom ? '0 3 * * *' : event.target.value);
                  }}
                >
                  {Object.entries(schedules).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                  <option value="custom">Custom schedule</option>
                </select>
              </label>
              {custom && (
                <label data-setting-path="geodata.cron">
                  Cron schedule
                  <input
                    aria-label="Cron schedule"
                    value={jsonText(cron)}
                    onChange={(event) => change(['geodata', 'cron'], event.target.value)}
                  />
                  <span className="server-field-hint">
                    Minute hour day month weekday · server time zone.
                  </span>
                </label>
              )}
            </div>
          )}
          <ServerFields
            object={geodata}
            root={value}
            schema="ResourceUpdates"
            path="geodata."
            fieldSets={{
              ...settingsStructures,
              ResourceUpdates: [
                {
                  key: 'outbound',
                  label: 'Download through outbound',
                  type: 'select',
                  choices: destinations
                    .filter((item) => !item.group && !item.internal)
                    .map((item) => item.tag),
                  placeholder: 'Core routing',
                },
                {
                  key: 'assets',
                  label: 'Resource files',
                  type: 'collection',
                  schema: 'ResourceFile',
                  itemName: 'resource file',
                },
              ],
            }}
            issues={issues}
            onChange={(next) => change(['geodata'], next)}
          />
        </Section>
        <Section title="FakeDNS pools">
          <Toggle
            label="Use custom FakeDNS pools"
            checked={fake != null}
            onChange={(checked) =>
              toggle('fakedns', checked, [{ ipPool: '198.18.0.0/15', poolSize: 32768 }])
            }
          />
          {fake != null && (
            <>
              <p className="server-field-hint">Requires a DNS server entry using fakedns.</p>
              <ServerFields
                schema="FakeDNSPools"
                object={{ pools }}
                root={value}
                fieldSets={{
                  ...settingsStructures,
                  FakeDNSPools: [
                    {
                      key: 'pools',
                      label: 'Address pools',
                      type: 'collection',
                      schema: 'FakeDNSPool',
                      itemName: 'pool',
                    },
                  ],
                }}
                issues={issues.map((issue) => ({
                  ...issue,
                  path: issue.path.replace(
                    /^fakedns(?:\.(\d+))?/,
                    (_match, index) => `pools.${index ?? '0'}`,
                  ),
                }))}
                onChange={(next) => {
                  const pools = next.pools as unknown[];
                  change(
                    ['fakedns'],
                    !pools.length
                      ? undefined
                      : jsonRecord(fake) && pools.length === 1
                        ? pools[0]
                        : pools,
                  );
                }}
              />
            </>
          )}
        </Section>
      </div>
    );
  }
  return (
    <div className="server-inbound-editor">
      <Section title="Version requirements">
        {fields('VersionConfig', object('version'), ['version'])}
      </Section>
      <Section title="Reverse tunnels">
        {fields('ReverseConfig', object('reverse'), ['reverse'])}
      </Section>
      <Section title="Xray environment">
        <MapInput
          lists={false}
          value={get(value, 'env')}
          label="Environment variables"
          onChange={(next) => change(['env'], next)}
        />
      </Section>
    </div>
  );
}

export function coreIssues(value: ServerObject): InboundIssue[] {
  const issues: InboundIssue[] = [];
  if (get(value, 'api') != null && !jsonRecord(get(value, 'api')))
    issues.push({
      path: 'api',
      message: 'Management API settings must be an object.',
      tab: 'Statistics & API',
    });
  const log = objectAt(value, 'log');
  for (const key of ['access', 'error'])
    if (get(log, key) !== undefined && typeof get(log, key) !== 'string')
      issues.push({
        path: `log.${key}`,
        message: 'Enter a log file path, or choose another destination.',
        tab: 'Logging',
      });
  const check = (key: string, schema: string, tab: string) => {
    if (jsonRecord(get(value, key)))
      issues.push(
        ...fieldsIssues(objectAt(value, key), settingsStructures[schema] ?? [], tab, key + '.'),
      );
  };
  const levels = objectAt(objectAt(value, 'policy'), 'levels');
  for (const [level, entry] of Object.entries(levels))
    if (jsonRecord(entry))
      issues.push(
        ...fieldsIssues(
          entry,
          settingsStructures.ConnectionPolicy,
          'Connections',
          `policy.levels.${level}.`,
        ),
      );
  check('api', 'APIConfig', 'Statistics & API');
  check('metrics', 'MetricsConfig', 'Statistics & API');
  check('version', 'VersionConfig', 'Advanced');
  check('reverse', 'ReverseConfig', 'Advanced');
  const metrics = objectAt(value, 'metrics');
  if (jsonRecord(get(value, 'metrics')) && !get(metrics, 'tag') && !get(metrics, 'listen'))
    issues.push({
      path: 'metrics.listen',
      message: 'Enter a metrics listen address or routing tag.',
      tab: 'Statistics & API',
    });
  const geodata = objectAt(value, 'geodata'),
    assets = get(geodata, 'assets');
  if (Array.isArray(assets)) {
    if (assets.length > 100)
      issues.push({
        path: 'geodata.assets',
        message: 'Xray supports at most 100 resource files.',
        tab: 'Resources',
      });
    assets.forEach((asset, index) => {
      if (!jsonRecord(asset)) return;
      issues.push(
        ...fieldsIssues(
          asset,
          settingsStructures.ResourceFile,
          'Resources',
          `geodata.assets.${index}.`,
        ),
      );
      try {
        const url = new URL(jsonText(get(asset, 'url')));
        if (url.protocol !== 'https:' || !url.hostname) throw new Error();
      } catch {
        issues.push({
          path: `geodata.assets.${index}.url`,
          message: 'Enter an HTTPS resource URL.',
          tab: 'Resources',
        });
      }
      if (!jsonText(get(asset, 'file')).endsWith('.dat'))
        issues.push({
          path: `geodata.assets.${index}.file`,
          message: 'Resource file names must end in .dat.',
          tab: 'Resources',
        });
    });
  }
  if (get(geodata, 'cron') === '')
    issues.push({ path: 'geodata.cron', message: 'Enter an update schedule.', tab: 'Resources' });
  const fake = get(value, 'fakedns'),
    pools = jsonArray(fake) ? fake : jsonRecord(fake) ? [fake] : [];
  pools.forEach((pool, index) => {
    if (!jsonRecord(pool)) return;
    const path = 'fakedns' + (jsonArray(fake) ? `.${index}` : '');
    issues.push(...fieldsIssues(pool, settingsStructures.FakeDNSPool, 'Resources', path + '.'));
    const range = jsonText(get(pool, 'ipPool'));
    if (!range.includes('/') || /^(?:!|geoip:|ext:)/i.test(range) || ipProblem(range))
      issues.push({
        path: path + '.ipPool',
        message: 'Enter an IPv4 or IPv6 network in CIDR notation.',
        tab: 'Resources',
      });
  });
  return issues;
}
