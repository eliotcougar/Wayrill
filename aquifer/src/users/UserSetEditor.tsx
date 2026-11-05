import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { cloneJson, jsonRecord, parseXrayJson } from '../graph/xrayJson';
import {
  accountProblem,
  newUser,
  userProtocols,
  scalarText,
  USER_LIMITS,
  type CredentialUser,
  type UserSet,
} from './model';

const PAGE = 100;
export default function UserSetEditor({
  value,
  isNew,
  onChange,
  onPendingJson,
}: {
  value: UserSet;
  isNew: boolean;
  onChange: (set: UserSet) => void;
  onPendingJson: (pending: boolean) => void;
}) {
  const [selected, setSelected] = useState(value.users[0]?.id ?? '');
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(0),
    [reveal, setReveal] = useState(false);
  const [advanced, setAdvanced] = useState<string | null>(null),
    [jsonError, setJsonError] = useState('');
  const user = value.users.find((u) => u.id === selected);
  const modifiedUsers = useRef(false);
  const invalidJson = advanced !== null && !!jsonError;
  useEffect(() => {
    onPendingJson(invalidJson);
    return () => onPendingJson(false);
  }, [invalidJson, onPendingJson]);
  const matching = value.users.filter((u) =>
    `${u.name} ${scalarText(u.account.email ?? '')} ${scalarText(u.account.user ?? '')}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matching.length / PAGE) - 1));
  const visible = matching.slice(currentPage * PAGE, (currentPage + 1) * PAGE);
  const update = (next: CredentialUser) => {
    modifiedUsers.current = true;
    onChange({ ...value, users: value.users.map((u) => (u.id === next.id ? next : u)) });
  };
  const accountField = (field: string, fieldValue: unknown) => {
    if (!user) return;
    const account = { ...user.account };
    if (fieldValue === '' || fieldValue === undefined) delete account[field];
    else account[field] = fieldValue;
    update({ ...user, account });
  };
  const changeSelection = (id: string) => {
    setSelected(id);
    setAdvanced(null);
    setJsonError('');
    setReveal(false);
  };
  const secretField =
    value.protocol === 'password' || value.protocol === 'masque'
      ? 'pass'
      : value.protocol === 'vless' || value.protocol === 'vmess'
        ? 'id'
        : value.protocol === 'hysteria'
          ? 'auth'
          : 'password';
  return (
    <div className="user-set-editor">
      <div className="user-set-heading">
        <label>
          Set name
          <input
            aria-label="Set name"
            value={value.name}
            maxLength={128}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </label>
        <label>
          Credential type
          <select
            aria-label="Credential type"
            value={value.protocol}
            disabled={!isNew || invalidJson}
            onChange={(e) => {
              if (
                modifiedUsers.current &&
                !window.confirm(
                  'Changing credential type replaces the users in this draft. Continue?',
                )
              )
                return;
              modifiedUsers.current = false;
              const protocol = e.target.value as UserSet['protocol'];
              const replacement = newUser(protocol, 1);
              onChange({ ...value, protocol, users: [replacement] });
              changeSelection(replacement.id);
            }}
          >
            {Object.entries(userProtocols).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="users-editor-columns">
        <div className="users-editor-list">
          <div className="user-list-tools">
            <input
              aria-label="Find users"
              placeholder="Find users"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
            <button
              aria-label="Add user"
              title="Add user"
              disabled={invalidJson || value.users.length >= USER_LIMITS.users}
              onClick={() => {
                modifiedUsers.current = true;
                const next = newUser(value.protocol, value.users.length + 1);
                onChange({ ...value, users: [...value.users, next] });
                setQuery('');
                setPage(Math.floor(value.users.length / PAGE));
                changeSelection(next.id);
              }}
            >
              <Plus size={17} />
            </button>
          </div>
          <p className="muted user-count">
            {value.users.filter((u) => u.enabled).length} enabled · {value.users.length} total
          </p>
          <div className="user-rows" aria-label="Users in set">
            {visible.map((item) => (
              <button
                key={item.id}
                disabled={invalidJson}
                aria-pressed={item.id === selected}
                className={item.id === selected ? 'active' : ''}
                onClick={() => changeSelection(item.id)}
              >
                <strong>{item.name}</strong>
                <span>
                  {!item.enabled
                    ? 'Disabled'
                    : scalarText(item.account.email || item.account.user || 'Enabled')}
                </span>
              </button>
            ))}
            {!matching.length && <p className="muted">No users found.</p>}
          </div>
          {matching.length > PAGE && (
            <div className="user-pagination">
              <button disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>
                Previous
              </button>
              <span>
                {currentPage + 1} / {Math.ceil(matching.length / PAGE)}
              </span>
              <button
                disabled={(currentPage + 1) * PAGE >= matching.length}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
        {user ? (
          <div className="user-account-form">
            <div className="user-account-title">
              <strong>{user.name || 'User'}</strong>
              <button
                className="icon-button"
                aria-label="Remove user"
                disabled={invalidJson}
                title="Remove user"
                onClick={() => {
                  modifiedUsers.current = true;
                  const users = value.users.filter((u) => u.id !== user.id);
                  onChange({ ...value, users });
                  changeSelection(users[0]?.id ?? '');
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <label>
              Display name
              <input
                aria-label="User display name"
                value={user.name}
                maxLength={128}
                onChange={(e) => update({ ...user, name: e.target.value })}
              />
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={user.enabled}
                onChange={(e) => update({ ...user, enabled: e.target.checked })}
              />
              Enabled
            </label>
            {advanced === null && (
              <>
                {value.protocol === 'password' && (
                  <label>
                    Username
                    <input
                      aria-label="Username"
                      autoComplete="off"
                      value={scalarText(user.account.user ?? '')}
                      onChange={(e) => accountField('user', e.target.value)}
                    />
                  </label>
                )}
                <label>
                  {secretField === 'id'
                    ? 'UUID / user ID'
                    : secretField === 'auth'
                      ? 'Authentication token'
                      : value.protocol.startsWith('ss2022')
                        ? 'Client key'
                        : 'Password'}
                  <div className="field-with-button">
                    <input
                      aria-label="User credential"
                      type={reveal ? 'text' : 'password'}
                      autoComplete="new-password"
                      spellCheck={false}
                      value={scalarText(user.account[secretField] ?? '')}
                      onChange={(e) => accountField(secretField, e.target.value)}
                    />
                    <button
                      aria-label={reveal ? 'Hide user credential' : 'Reveal user credential'}
                      title={reveal ? 'Hide credential' : 'Reveal credential'}
                      onClick={() => setReveal(!reveal)}
                    >
                      {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                    <button
                      aria-label="Generate credential"
                      title="Generate credential"
                      onClick={() =>
                        accountField(secretField, newUser(value.protocol, 1).account[secretField])
                      }
                    >
                      <RefreshCw size={16} />
                    </button>
                  </div>
                </label>
                {value.protocol !== 'password' && (
                  <>
                    <label>
                      Email / Xray user label
                      <input
                        aria-label="User email"
                        value={scalarText(user.account.email ?? '')}
                        onChange={(e) => accountField('email', e.target.value)}
                      />
                    </label>
                    <label>
                      User level
                      <input
                        aria-label="User level"
                        type="number"
                        min={0}
                        max={4294967295}
                        step={1}
                        placeholder="0"
                        value={
                          user.account.level === undefined ? '' : scalarText(user.account.level)
                        }
                        onChange={(e) =>
                          accountField('level', e.target.value === '' ? '' : Number(e.target.value))
                        }
                      />
                    </label>
                  </>
                )}
                {value.protocol === 'vless' && (
                  <label>
                    Flow
                    <select
                      aria-label="User flow"
                      value={scalarText(user.account.flow ?? '')}
                      onChange={(e) => accountField('flow', e.target.value)}
                    >
                      <option value="">Inbound default</option>
                      {typeof user.account.flow === 'string' &&
                        user.account.flow &&
                        user.account.flow !== 'xtls-rprx-vision' && (
                          <option value={user.account.flow}>{user.account.flow}</option>
                        )}
                      <option value="xtls-rprx-vision">xtls-rprx-vision</option>
                    </select>
                  </label>
                )}
                {value.protocol === 'shadowsocks' && (
                  <label>
                    Cipher
                    <select
                      aria-label="User cipher"
                      value={scalarText(user.account.method ?? '')}
                      onChange={(e) => accountField('method', e.target.value)}
                    >
                      {[
                        ...new Set([
                          scalarText(user.account.method ?? ''),
                          'aes-128-gcm',
                          'aes-256-gcm',
                          'chacha20-ietf-poly1305',
                          'xchacha20-ietf-poly1305',
                        ]),
                      ].map((method) => (
                        <option key={method} value={method}>
                          {method || 'Select cipher'}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
            <button
              type="button"
              onClick={() => {
                if (advanced !== null && invalidJson) return;
                setAdvanced(advanced === null ? JSON.stringify(user.account, null, 2) : null);
                setJsonError('');
              }}
              disabled={invalidJson}
            >
              {advanced === null ? 'Edit account JSON' : 'Show fields'}
            </button>
            {advanced !== null && (
              <>
                <textarea
                  aria-label="Account JSON"
                  spellCheck={false}
                  value={advanced}
                  onChange={(event) => {
                    const text = event.target.value;
                    setAdvanced(text);
                    try {
                      const account = parseXrayJson(text);
                      if (!jsonRecord(account)) throw new Error('Enter an account object.');
                      const problem = accountProblem(value.protocol, account);
                      if (problem) throw new Error(problem);
                      update({ ...user, account: cloneJson(account) });
                      setJsonError('');
                    } catch (reason) {
                      setJsonError(
                        reason instanceof Error ? reason.message : 'Invalid account JSON.',
                      );
                    }
                  }}
                />
                {jsonError && (
                  <>
                    <p className="user-error" role="alert">
                      {jsonError}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setAdvanced(JSON.stringify(user.account, null, 2));
                        setJsonError('');
                      }}
                    >
                      Restore last valid JSON
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="user-account-form">
            <p className="muted">Add a user to this set.</p>
          </div>
        )}
      </div>
    </div>
  );
}
