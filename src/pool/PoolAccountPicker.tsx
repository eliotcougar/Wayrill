import { useState } from 'react';
import { errorText } from '../serviceClient';
import { accountKey, normalizePublicHost, type AccountRef, type ObservedServer } from './accounts';

function endpointValues(host: string, port: string) {
  const number = port ? Number(port) : undefined;
  if (number !== undefined && (!Number.isInteger(number) || number < 1 || number > 65535))
    throw new Error('Enter a public port from 1 to 65535.');
  return { host: host.trim() ? normalizePublicHost(host) : undefined, port: number };
}

function EndpointFields({
  host,
  port,
  setHost,
  setPort,
}: {
  host: string;
  port: string;
  setHost: (value: string) => void;
  setPort: (value: string) => void;
}) {
  return (
    <div className="editor-two-fields">
      <label className="editor-field">
        <span>Public host override</span>
        <input value={host} onChange={(event) => setHost(event.currentTarget.value)} />
      </label>
      <label className="editor-field">
        <span>Public port override</span>
        <input
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(event) => setPort(event.currentTarget.value)}
        />
      </label>
    </div>
  );
}

export function EditAccountEndpoint({
  refValue,
  onSave,
  onClose,
}: {
  refValue: AccountRef;
  onSave: (ref: AccountRef) => void;
  onClose: () => void;
}) {
  const [host, setHost] = useState(refValue.host ?? '');
  const [port, setPort] = useState(refValue.port?.toString() ?? '');
  const [problem, setProblem] = useState('');
  return (
    <div className="pool-assignment">
      <EndpointFields host={host} port={port} setHost={setHost} setPort={setPort} />
      <small className="field-help">
        Leave a field empty to use the endpoint observed by Aquifer.
      </small>
      <div className="pool-row-actions">
        <button className="secondary-button" onClick={onClose}>
          Cancel endpoint edit
        </button>
        <button
          className="secondary-button"
          onClick={() => {
            try {
              onSave({ ...refValue, ...endpointValues(host, port) });
            } catch (reason) {
              setProblem(errorText(reason));
            }
          }}
        >
          Save endpoint
        </button>
      </div>
      {problem && (
        <p className="field-message error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

export default function PoolAccountPicker({
  servers,
  assigned,
  replacement,
  onAdd,
}: {
  servers: ObservedServer[];
  assigned: AccountRef[];
  replacement?: AccountRef;
  onAdd: (ref: AccountRef) => void;
}) {
  const [serverId, setServer] = useState(replacement?.server ?? '');
  const [query, setQuery] = useState('');
  const [account, setAccount] = useState('');
  const [host, setHost] = useState(replacement?.host ?? '');
  const [port, setPort] = useState(replacement?.port?.toString() ?? '');
  const [problem, setProblem] = useState('');
  const choose = (id: string) => {
    setAccount(id);
    setProblem('');
    setHost(replacement?.host ?? '');
    setPort(replacement?.port?.toString() ?? '');
  };
  const server = servers.find((item) => item.id === serverId);
  const existing = new Set(assigned.map(accountKey));
  const term = query.trim().toLowerCase();
  const matches =
    server?.accounts.filter(
      (item) =>
        !existing.has(accountKey({ server: server.id, account: item.id })) &&
        `${item.name} ${item.inbound}`.toLowerCase().includes(term),
    ) ?? [];
  const shown = matches.slice(0, 100);
  const selected = shown.find((item) => item.id === account);

  if (!servers.length)
    return (
      <p className="field-help">
        Read a server configuration in Aquifer to make its accounts available here.
      </p>
    );
  return (
    <>
      <label className="editor-field">
        <span>Observed server</span>
        <select
          value={server?.id ?? ''}
          onChange={(event) => {
            setServer(event.currentTarget.value);
            setQuery('');
            choose('');
          }}
        >
          <option value="">Choose a server configuration</option>
          {servers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.path} ({item.accounts.length})
            </option>
          ))}
        </select>
      </label>
      {server && (
        <>
          {server.accounts.length > 30 && (
            <label className="editor-field">
              <span>Find an account</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
          )}
          <label className="editor-field">
            <span>Account and inbound</span>
            <select
              value={selected?.id ?? ''}
              onChange={(event) => choose(event.currentTarget.value)}
            >
              <option value="">Choose an account</option>
              {shown.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.inbound}
                </option>
              ))}
            </select>
          </label>
          {matches.length > 100 && <p className="field-help">Search to narrow the account list.</p>}
          {!!server.skipped.length && (
            <p className="field-help">
              Client settings could not be derived for {server.skipped.join(', ')}.
            </p>
          )}
          {selected && (
            <details>
              <summary>Use a different public endpoint</summary>
              <EndpointFields host={host} port={port} setHost={setHost} setPort={setPort} />
            </details>
          )}
          <button
            className="secondary-button"
            disabled={!selected}
            onClick={() => {
              if (!selected) return;
              try {
                onAdd({ server: server.id, account: selected.id, ...endpointValues(host, port) });
                choose('');
              } catch (reason) {
                setProblem(errorText(reason));
              }
            }}
          >
            {replacement ? 'Replace assigned account' : 'Add server to this user’s Stash'}
          </button>
          {problem && (
            <p className="field-message error" role="alert">
              {problem}
            </p>
          )}
        </>
      )}
    </>
  );
}
