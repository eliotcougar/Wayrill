import { useState } from 'react';
import { jsonArray, jsonRecord, jsonText } from './graph/xrayJson';
import { get, objectAt, setProperty } from './nativeProperties';
import {
  transportFields,
  transportNames,
  transportOf,
  type InboundIssue,
  type ServerObject,
} from './inboundFields';
import ServerFields from './ServerFields';
import { outboundFields, settingsStructures } from './settingsFields';
import { ApiFields, Section } from './RemoteCoreSettings';
import { policyCandidates } from './RemotePolicySettings';
import type { RouteDestination } from './routingEditor';
import ListInput from './ListInput';

export const nodeSettingsTabs: Record<string, string[]> = {
  OutboundDetourConfig: ['Server', 'Transport & security', 'Advanced'],
  DNSConfig: ['General', 'Servers', 'Hosts', 'Advanced'],
  NameServerConfig: ['Server'],
  ObservatoryConfig: ['Probes', 'Candidates'],
  BurstObservatoryConfig: ['Probes', 'Candidates'],
  APIConfig: ['API'],
};

export default function RemoteNodeSettings({
  schema,
  value,
  tab,
  issues,
  destinations,
  onChange,
  showProtocolAdvanced = true,
}: {
  schema: string;
  value: ServerObject;
  tab: string;
  issues: InboundIssue[];
  destinations: RouteDestination[];
  onChange: (next: ServerObject) => void;
  showProtocolAdvanced?: boolean;
}) {
  const [query, setQuery] = useState('');
  const fields = (
    schema: string,
    entry = value,
    path = '',
    update = onChange,
    fieldSets = settingsStructures,
  ) => (
    <ServerFields
      schema={schema}
      object={entry}
      root={value}
      path={path}
      fieldSets={fieldSets}
      direction="outbound"
      issues={issues}
      onChange={update}
    />
  );
  if (schema === 'APIConfig')
    return <ApiFields value={value} onChange={onChange} issues={issues} />;
  if (schema === 'DNSConfig' && tab === 'Servers') {
    const servers = get(value, 'servers'),
      entries = jsonArray(servers) ? servers : [];
    const update = (next: unknown[]) => onChange(setProperty(value, 'servers', next));
    return (
      <div className="server-inbound-editor">
        {entries.map((entry, index) => (
          <section className="editor-panel server-collection-item" key={index}>
            <header>
              <strong>DNS server {index + 1}</strong>
              <button
                className="secondary-button"
                type="button"
                onClick={() => update(entries.filter((_, i) => i !== index))}
              >
                Remove server
              </button>
            </header>
            {fields(
              'NameServerConfig',
              jsonRecord(entry) ? entry : { address: entry },
              `servers.${index}.`,
              (next) =>
                update(
                  entries.map((old, i) =>
                    i !== index
                      ? old
                      : typeof entry === 'string' &&
                          Object.keys(next).length === 1 &&
                          typeof next.address === 'string'
                        ? next.address
                        : next,
                  ),
                ),
            )}
          </section>
        ))}
        <button className="secondary-button" type="button" onClick={() => update([...entries, ''])}>
          Add DNS server
        </button>
      </div>
    );
  }
  if (schema === 'DNSConfig')
    return tab === 'Hosts' ? (
      fields('DNSHosts')
    ) : tab === 'Advanced' ? (
      <>
        <ServerFields
          schema="DNSConfig"
          object={value}
          root={value}
          fieldSets={settingsStructures}
          issues={issues}
          onChange={onChange}
          advancedOnly
        />
      </>
    ) : (
      fields('DNSConfig', value, '', onChange, {
        ...settingsStructures,
        DNSConfig: settingsStructures.DNSConfig.filter((field) => !field.advanced),
      })
    );
  if (schema === 'NameServerConfig') return fields(schema);
  if (schema === 'ObservatoryConfig' || schema === 'BurstObservatoryConfig') {
    if (tab === 'Probes')
      return schema === 'ObservatoryConfig'
        ? fields(schema)
        : fields('HealthCheckSettings', objectAt(value, 'pingConfig'), 'pingConfig.', (next) =>
            onChange(setProperty(value, 'pingConfig', next)),
          );
    const selectors = get(value, 'subjectSelector'),
      all = Array.isArray(selectors) && selectors.includes('');
    const matches = policyCandidates({ selector: selectors }, destinations).filter((item) =>
      item.tag.toLowerCase().includes(query.toLowerCase()),
    );
    return (
      <div className="server-inbound-editor">
        <label className="editor-field">
          Observed outbounds
          <select
            className="text-control"
            aria-label="Observed outbounds"
            value={all ? 'all' : 'prefixes'}
            onChange={(event) =>
              onChange(
                setProperty(value, 'subjectSelector', event.target.value === 'all' ? [''] : []),
              )
            }
          >
            <option value="all">All outbounds</option>
            <option value="prefixes">Match outbound tag prefixes</option>
          </select>
        </label>
        {!all && (
          <label className="editor-field">
            Outbound tag prefixes
            <ListInput
              aria-label="Observed outbound tag prefixes"
              value={selectors}
              trim
              onChange={(next) => onChange(setProperty(value, 'subjectSelector', next))}
            />
            <span className="field-help">Case-sensitive prefixes, one per line.</span>
          </label>
        )}
        <section className="editor-panel policy-preview">
          <header>
            <strong>Matching outbounds</strong>
            <input
              className="text-control"
              aria-label="Find observed outbounds"
              placeholder="Find in matches"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </header>
          <ul>
            {matches.slice(0, 100).map(({ tag }) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
          {!matches.length && <p className="field-help">No matching outbounds</p>}
          {matches.length > 100 && (
            <p className="field-help">
              Showing 100 of {matches.length}. Use search to narrow the list.
            </p>
          )}
        </section>
      </div>
    );
  }
  const settings = objectAt(value, 'settings'),
    stream = objectAt(value, 'streamSettings'),
    { schema: protocolSchema, fieldSets } = outboundFields(value);
  const update = (key: string, next: unknown) => onChange(setProperty(value, key, next));
  if (tab === 'Server')
    return (
      <div className="server-inbound-editor">
        <Section title="Outbound">
          {fields('OutboundGeneral', value, '', onChange, {
            ...fieldSets,
            OutboundGeneral: settingsStructures.OutboundGeneral.filter(
              (field) => field.key === 'tag',
            ),
          })}
          <span className="server-protocol">
            {(
              {
                freedom: 'Direct',
                direct: 'Direct',
                blackhole: 'Block',
                block: 'Block',
                wireguard: 'WireGuard',
              } as Record<string, string>
            )[String(get(value, 'protocol'))] ?? String(get(value, 'protocol')).toUpperCase()}
          </span>
        </Section>
        <Section
          title={
            ['FreedomConfig', 'BlackholeConfig', 'LoopbackConfig', 'DNSOutboundConfig'].includes(
              protocolSchema,
            )
              ? 'Routing'
              : 'Server & credentials'
          }
        >
          {fields(
            protocolSchema,
            settings,
            'settings.',
            (next) => update('settings', next),
            showProtocolAdvanced
              ? fieldSets
              : {
                  ...fieldSets,
                  [protocolSchema]: (fieldSets[protocolSchema] ?? []).filter(
                    (field) => !field.advanced,
                  ),
                },
          )}
        </Section>
      </div>
    );
  if (tab === 'Transport & security') {
    const network = transportOf(stream),
      transport = transportFields(stream),
      security = jsonText(get(stream, 'security') ?? 'none').toLowerCase();
    const streamPart = (key: string, next: unknown) =>
      update('streamSettings', setProperty(stream, key, next));
    return (
      <div className="server-inbound-editor">
        <Section title="Transport">
          <div className="field-grid server-fields-grid">
            <label className="editor-field">
              Transport
              <select
                className="text-control"
                aria-label="Transport"
                value={network}
                onChange={(event) =>
                  streamPart(
                    get(stream, 'method') !== undefined ? 'method' : 'network',
                    event.target.value,
                  )
                }
              >
                {[...new Set([network, ...transportNames])].map((name) => (
                  <option key={name} value={name}>
                    {(
                      {
                        raw: 'RAW (TCP)',
                        ws: 'WebSocket',
                        xhttp: 'XHTTP',
                        kcp: 'mKCP',
                        httpupgrade: 'HTTPUpgrade',
                        grpc: 'gRPC',
                        hysteria: 'Hysteria 2',
                        masque: 'MASQUE',
                        xdrive: 'XDRIVE',
                      } as Record<string, string>
                    )[name] ?? name}
                  </option>
                ))}
              </select>
            </label>
            <label className="editor-field">
              Security
              <select
                className="text-control"
                aria-label="Security"
                value={security}
                onChange={(event) =>
                  streamPart(
                    'security',
                    event.target.value === 'none' ? undefined : event.target.value,
                  )
                }
              >
                {[...new Set([security, 'none', 'tls', 'reality'])].map((name) => (
                  <option key={name} value={name}>
                    {name === 'none' ? 'None' : name.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {transport &&
            fields(
              transport.schema,
              objectAt(stream, transport.key),
              `streamSettings.${transport.key}.`,
              (next) => streamPart(transport.key, next),
              fieldSets,
            )}
        </Section>
        {security !== 'none' && (
          <Section title={security === 'reality' ? 'REALITY client' : 'TLS client'}>
            {fields(
              security === 'reality' ? 'ClientREALITY' : 'ClientTLS',
              objectAt(stream, security === 'reality' ? 'realitySettings' : 'tlsSettings'),
              `streamSettings.${security === 'reality' ? 'realitySettings' : 'tlsSettings'}.`,
              (next) =>
                streamPart(security === 'reality' ? 'realitySettings' : 'tlsSettings', next),
              fieldSets,
            )}
          </Section>
        )}
      </div>
    );
  }
  return (
    <div className="server-inbound-editor">
      <Section title="Connection settings">
        {fields('OutboundGeneral', value, '', onChange, {
          ...fieldSets,
          OutboundGeneral: settingsStructures.OutboundGeneral.filter(
            (field) => field.key !== 'tag',
          ),
        })}
      </Section>
      <Section title="Proxy chain">
        {fields(
          'ProxyChain',
          objectAt(value, 'proxySettings'),
          'proxySettings.',
          (next) => update('proxySettings', next),
          {
            ...settingsStructures,
            ProxyChain: settingsStructures.ProxyChain.map((field) =>
              field.key === 'tag'
                ? {
                    ...field,
                    label: 'Next outbound',
                    type: 'select' as const,
                    placeholder: 'No chained outbound',
                    choices: destinations
                      .filter(
                        (item) => !item.group && !item.internal && item.tag !== get(value, 'tag'),
                      )
                      .map((item) => item.tag),
                  }
                : field,
            ),
          },
        )}
      </Section>
      <Section title="Multiplexing">
        {fields('MuxConfig', objectAt(value, 'mux'), 'mux.', (next) => update('mux', next))}
      </Section>
      <Section title="Socket options">
        <ServerFields
          schema="SocketConfig"
          object={objectAt(stream, 'sockopt')}
          root={value}
          direction="outbound"
          path="streamSettings.sockopt."
          onChange={(next) => update('streamSettings', setProperty(stream, 'sockopt', next))}
          advancedOnly
        />
      </Section>
    </div>
  );
}
