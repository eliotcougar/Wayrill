import { jsonRecord, jsonText } from './graph/xrayJson';
import { inboundUserProtocol, inboundUsers } from './users/model';
import {
  fieldsForServer,
  get,
  inboundSchemas,
  objectAt,
  propertyKey,
  setProperty,
  transportFields,
  transportNames,
  transportOf,
  type InboundIssue,
  type ServerObject,
} from './inboundFields';
import ServerFields from './ServerFields';
import { useState } from 'react';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="server-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export default function RemoteInboundSettings({
  value,
  tab,
  issues,
  userCount,
  onManageUsers,
  onChange,
}: {
  value: ServerObject;
  tab: string;
  issues: InboundIssue[];
  userCount?: number;
  onManageUsers?: () => void;
  onChange: (value: ServerObject) => void;
}) {
  const [transportNotice, setTransportNotice] = useState('');
  const protocol = String(get(value, 'protocol')).toLowerCase();
  const settings = objectAt(value, 'settings'),
    stream = objectAt(value, 'streamSettings');
  const schema = inboundSchemas[protocol];
  const network = transportOf(stream),
    transport = transportFields(stream),
    security = jsonText(get(stream, 'security') ?? 'none').toLowerCase();
  const settingsChange = (next: ServerObject) => onChange(setProperty(value, 'settings', next));
  const streamChange = (next: ServerObject) => onChange(setProperty(value, 'streamSettings', next));
  const streamPart = (key: string, next: ServerObject) =>
    streamChange(setProperty(stream, key, next));
  const fields = (
    schema: string,
    object: ServerObject,
    path: string,
    onChange: (value: ServerObject) => void,
  ) => <ServerFields {...{ schema, object, path, onChange, issues }} root={value} />;
  const accounts = inboundUserProtocol(value);
  const count = userCount ?? inboundUsers(value).length;
  if (tab === 'Listener' || tab === 'Interface')
    return (
      <div className="server-inbound-editor">
        <Section title={protocol === 'tun' ? 'TUN interface on server' : 'Listener'}>
          {['mixed', 'socks', 'http'].includes(protocol) ? (
            <label className="editor-field server-choice">
              Proxy mode
              <select
                className="text-control"
                aria-label="Proxy mode"
                value={protocol}
                onChange={(event) => {
                  const mode = event.target.value;
                  let next = setProperty(value, 'protocol', mode);
                  if (mode !== 'http' && protocol === 'http' && count > 0)
                    next = setProperty(next, 'settings', setProperty(settings, 'auth', 'password'));
                  onChange(next);
                }}
              >
                <option value="mixed">SOCKS + HTTP</option>
                <option value="socks">SOCKS</option>
                <option value="http">HTTP</option>
              </select>
            </label>
          ) : (
            <span className="server-protocol">
              {protocol === 'hysteria'
                ? 'Hysteria 2'
                : protocol === 'mixed'
                  ? 'SOCKS + HTTP'
                  : protocol.toUpperCase()}
            </span>
          )}
          {fields(protocol === 'tun' ? 'Interface' : 'Listener', value, '', onChange)}
        </Section>
        {accounts && (
          <section className="editor-panel server-user-summary">
            <div>
              <strong>Users</strong>
              <span>
                {count} {count === 1 ? 'user' : 'users'} · connected User sets
              </span>
            </div>
            {onManageUsers ? (
              <button className="secondary-button" type="button" onClick={onManageUsers}>
                Manage users
              </button>
            ) : (
              <span>Manage credentials in User sets</span>
            )}
          </section>
        )}
        {schema && fieldsForServer(schema, settings, value).length > 0 && (
          <Section
            title={
              protocol === 'tun'
                ? 'Interface & routing'
                : protocol === 'wireguard'
                  ? 'Device & peers'
                  : protocol === 'tunnel' || protocol === 'dokodemo-door'
                    ? 'Forwarding'
                    : 'Protocol settings'
            }
          >
            {fields(schema, settings, 'settings.', settingsChange)}
          </Section>
        )}
        {protocol === 'http' && (
          <p className="field-help">
            {count
              ? 'HTTP authentication uses the connected User sets.'
              : 'No accounts: HTTP authentication is off.'}
          </p>
        )}
      </div>
    );
  if (tab === 'Transport & security')
    return (
      <div className="server-inbound-editor">
        <Section title="Transport">
          <div className="field-grid server-fields-grid">
            <label className="editor-field server-choice">
              Transport
              <select
                className="text-control"
                aria-label="Transport"
                value={network}
                onChange={(event) => {
                  // Preserve dormant transport blocks; switching back restores their values.
                  const key = get(stream, 'method') !== undefined ? 'method' : 'network';
                  const network = event.target.value;
                  let next = setProperty(stream, key, network);
                  const needsTls =
                    ['hysteria', 'masque'].includes(network) ||
                    (security === 'reality' && !['raw', 'grpc', 'xhttp'].includes(network));
                  if (needsTls) {
                    next = setProperty(next, 'security', 'tls');
                    if (get(next, 'tlsSettings') === undefined)
                      next = setProperty(next, 'tlsSettings', { certificates: [{}] });
                  }
                  if (network === 'hysteria' && get(next, 'hysteriaSettings') === undefined)
                    next = setProperty(next, 'hysteriaSettings', { version: 2 });
                  setTransportNotice(
                    needsTls && security !== 'tls'
                      ? 'TLS selected for this transport. Configure the server certificate below.'
                      : '',
                  );
                  streamChange(next);
                }}
              >
                {[
                  ...new Set([
                    network,
                    ...(['hysteria', 'masque'].includes(protocol) ? [protocol] : transportNames),
                  ]),
                ].map((name) => (
                  <option key={name} value={name}>
                    {(
                      {
                        raw: 'RAW (TCP)',
                        xhttp: 'XHTTP',
                        ws: 'WebSocket',
                        httpupgrade: 'HTTPUpgrade',
                        kcp: 'mKCP',
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
            <label className="editor-field server-choice">
              Security
              <select
                className="text-control"
                aria-label="Security"
                aria-invalid={issues.some((issue) => issue.path === 'streamSettings.security')}
                value={security}
                onChange={(event) => {
                  setTransportNotice('');
                  let next = setProperty(
                    stream,
                    'security',
                    event.target.value === 'none' ? undefined : event.target.value,
                  );
                  if (event.target.value === 'tls' && get(next, 'tlsSettings') === undefined)
                    next = setProperty(next, 'tlsSettings', { certificates: [{}] });
                  streamChange(next);
                }}
              >
                {[
                  ...new Set([
                    security,
                    ...(['hysteria', 'masque'].includes(network)
                      ? ['tls']
                      : [
                          'none',
                          'tls',
                          ...(['raw', 'xhttp', 'grpc'].includes(network) ? ['reality'] : []),
                        ]),
                  ]),
                ].map((name) => (
                  <option key={name} value={name}>
                    {name === 'none' ? 'None / TLS terminated upstream' : name.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {transportNotice && (
            <p className="field-help" role="status">
              {transportNotice}
            </p>
          )}
          {transport &&
            fields(
              transport.schema,
              objectAt(stream, transport.key),
              `streamSettings.${propertyKey(stream, transport.key)}.`,
              (next) => streamPart(transport.key, next),
            )}
        </Section>
        {security === 'tls' && (
          <Section title="TLS server">
            {fields(
              'TLSConfig',
              objectAt(stream, 'tlsSettings'),
              `streamSettings.${propertyKey(stream, 'tlsSettings')}.`,
              (next) => streamPart('tlsSettings', next),
            )}
          </Section>
        )}
        {security === 'reality' && (
          <Section title="REALITY server">
            {fields(
              'REALITYConfig',
              objectAt(stream, 'realitySettings'),
              `streamSettings.${propertyKey(stream, 'realitySettings')}.`,
              (next) => streamPart('realitySettings', next),
            )}
          </Section>
        )}
      </div>
    );
  if (tab === 'Sniffing') {
    const sniffing = objectAt(value, 'sniffing'),
      detected = get(sniffing, 'destOverride');
    const protocols = Array.isArray(detected)
      ? detected.map(String)
      : typeof detected === 'string'
        ? [detected]
        : [];
    const update = (next: ServerObject) => onChange(setProperty(value, 'sniffing', next));
    const aliases: Record<string, string[]> = {
      tls: ['tls', 'https', 'ssl'],
      fakedns: ['fakedns', 'fakedns+others'],
    };
    return (
      <Section title="Destination detection">
        {fields('SniffingToggle', sniffing, 'sniffing.', update)}
        <fieldset className="server-protocol-options">
          <legend>Detected protocols</legend>
          {['http', 'tls', 'quic', 'fakedns'].map((protocol) => (
            <label className="check-control" key={protocol}>
              <input
                type="checkbox"
                checked={protocols.some((name) => (aliases[protocol] ?? [protocol]).includes(name))}
                onChange={(event) => {
                  const remaining = protocols.filter(
                    (name) => !(aliases[protocol] ?? [protocol]).includes(name),
                  );
                  update(
                    setProperty(
                      sniffing,
                      'destOverride',
                      event.target.checked ? [...remaining, protocol] : remaining,
                    ),
                  );
                }}
              />
              {protocol === 'fakedns' ? 'FakeDNS' : protocol.toUpperCase()}
            </label>
          ))}
        </fieldset>
        {fields('SniffingConfig', sniffing, 'sniffing.', update)}
      </Section>
    );
  }
  const extras = Object.keys(value).filter(
    (key) =>
      !['tag', 'listen', 'port', 'protocol', 'settings', 'streamsettings', 'sniffing'].includes(
        key.toLowerCase(),
      ),
  );
  return (
    <div className="server-inbound-editor">
      {!['tun'].includes(protocol) && (
        <Section title="Listener socket">
          <ServerFields
            schema="SocketConfig"
            object={objectAt(stream, 'sockopt')}
            root={value}
            path="streamSettings.sockopt."
            onChange={(next) => streamPart('sockopt', next)}
            issues={issues}
            advancedOnly
          />
        </Section>
      )}
      <p className="field-help">
        {extras.length ? `${extras.length} additional listener settings are preserved. ` : ''}Use
        Edit JSON for fields specific to another Xray version.
      </p>
    </div>
  );
}

export function editableInbound(value: unknown): value is ServerObject {
  return (
    jsonRecord(value) &&
    typeof get(value, 'protocol') === 'string' &&
    !!inboundSchemas[String(get(value, 'protocol')).toLowerCase()]
  );
}
