import { useEffect, useRef, useState } from 'react';
import { X, RefreshCw, Play, Square } from 'lucide-react';
import { EditorTabs, EditorTabPanels, useEditorTabs } from './EditorTabs';
import useModalDialog from './useModalDialog';
import WindowsCaptureSettings from './WindowsCaptureSettings';
import AppProtectionSettings from './AppProtectionSettings';
import WinHttpDiagnostics from './WinHttpDiagnostics';
import WindowsProxyScope from './WindowsProxyScope';
import {
  desktopServiceAvailable,
  errorText,
  mutationOutcomeUnknown,
  serviceCall,
} from '../serviceClient';
import {
  captureProxyInputs,
  initialCaptureRequest,
  requestIssue,
  environmentCommands,
  type CaptureChannel,
  type CaptureRequest,
  type CaptureSettingsRow,
  type ProxyInput,
  type SystemCaptureSnapshot,
} from '../systemCapture';
import type { GraphState } from '../graph/types';
import type { RuntimeCompilation } from '../graph/runtime';

type Tab = 'proxy' | 'environment' | 'winhttp' | 'windivert' | 'loopback' | 'protection';
type Run = (method: string, params?: Record<string, unknown>) => Promise<void>;
function ProxySection({
  channel,
  row,
  inputs,
  environmentRows,
  running,
  busy,
  run,
}: {
  channel: CaptureChannel;
  row?: CaptureSettingsRow;
  inputs: ProxyInput[];
  environmentRows: CaptureSettingsRow[];
  running: boolean;
  busy: boolean;
  run: Run;
}) {
  const [request, setRequest] = useState(() => initialCaptureRequest(channel, row, inputs));
  const environment = channel === 'envUser' || channel === 'envMachine';
  // A refreshed native version resets this channel to its accepted assignment.
  const oldVersion = useRef(row?.version);
  useEffect(() => {
    if (row && oldVersion.current !== row.version) {
      setRequest(initialCaptureRequest(channel, row, inputs));
      oldVersion.current = row.version;
    }
  }, [channel, inputs, row]);
  const field = <K extends keyof CaptureRequest>(key: K, value: CaptureRequest[K]) =>
    setRequest((r) => ({ ...r, [key]: value }));
  const commands = environmentCommands(environmentRows);
  const desktop = desktopServiceAvailable();
  const issue = requestIssue(request, inputs, running, !!row?.advancedSupported);
  const windowsScope =
    row?.scope === 'machine' ? 'All users · default LAN' : 'This user · default LAN';
  const canChange = desktop && !!row?.supported && !busy;
  const environmentValue = (name: string) => {
    const own = row?.values[name];
    const user = environmentRows.find((r) => r.channel === 'envUser');
    const machine = environmentRows.find((r) => r.channel === 'envMachine');
    const inherited =
      channel === 'envUser' &&
      own == null &&
      machine?.supported &&
      typeof machine.values[name] === 'string';
    const override =
      channel === 'envMachine' && user?.supported && typeof user.values[name] === 'string';
    return (
      <>
        {String(inherited ? machine.values[name] : (own ?? 'Not set'))}
        {inherited && <span className="field-help"> · inherited from system</span>}
        {override && (
          <span className="field-help"> · User override: {String(user.values[name])}</span>
        )}
      </>
    );
  };
  const choose = (all = false) => {
    const value = all ? request.allInputTag : request.inputTag;
    const choices = inputs.filter((i) =>
      all && request.allProtocol !== 'http' ? i.socks : i.http,
    );
    return (
      <label className="editor-field">
        <span>{all ? 'ALL_PROXY inbound' : 'Proxy inbound'}</span>
        <select
          aria-label={all ? 'ALL_PROXY inbound' : 'Proxy inbound'}
          value={value}
          disabled={busy || !desktop}
          onChange={(e) => field(all ? 'allInputTag' : 'inputTag', e.target.value)}
        >
          <option value="">Choose an input</option>
          {choices.map((i) => (
            <option key={i.tag} value={i.tag}>
              {i.label} · 127.0.0.1:{i.port}
              {i.applied ? '' : ' · draft'}
            </option>
          ))}
        </select>
      </label>
    );
  };
  return (
    <section className="capture-proxy-section" aria-label={channel}>
      {channel === 'wininet' && row?.scopeSwitchSupported && row.scope && (
        <WindowsProxyScope row={row} busy={busy || !desktop} run={run} />
      )}
      <div className="capture-current">
        <strong>
          {!row
            ? 'Not loaded'
            : !row.supported
              ? 'Unavailable'
              : row.conflict
                ? 'External changes'
                : row.managed
                  ? 'Managed by Wayrill'
                  : channel === 'wininet'
                    ? windowsScope
                    : 'Current Windows settings'}
        </strong>
        {channel === 'wininet' && row?.supported && (row.managed || row.conflict) && (
          <p className="field-help">{windowsScope}</p>
        )}
        {row?.supported &&
          (environment ? (
            <dl className="capture-values">
              {['http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'no_proxy'].map((name) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{environmentValue(name)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <dl className="capture-values">
              <div>
                <dt>Manual proxy</dt>
                <dd>{row.values.enabled ? String(row.values.server) : 'Off'}</dd>
              </div>
              <div>
                <dt>Bypass</dt>
                <dd>{String(row.values.bypass || 'None')}</dd>
              </div>
              <div>
                <dt>PAC</dt>
                <dd>{String(row.values.pacUrl || 'Off')}</dd>
              </div>
              <div>
                <dt>Automatic discovery</dt>
                <dd>{row.values.autoDetect ? 'On' : 'Off'}</dd>
              </div>
            </dl>
          ))}
        {row?.error && <p className="field-help">{row.error.message}</p>}
        {row?.conflict && (
          <p className="notice notice--error" role="alert">
            {row.scopeConflict
              ? 'Windows changed the proxy scope. Switch back to restore the previous assignment, or keep external settings to release it.'
              : 'Another application changed these settings. Restore owned values or keep external settings before setting a new proxy.'}
          </p>
        )}
      </div>
      {(channel === 'winhttpLegacy' ||
        channel === 'winhttpMachine' ||
        channel === 'winhttpUser') && (
        <WinHttpDiagnostics key={channel} channel={channel} disabled={!desktop || busy} />
      )}
      <fieldset disabled={busy || !desktop || !row?.supported} className="capture-settings-fields">
        {!environment && (
          <label className="editor-field">
            <span>Mode</span>
            <select
              aria-label="Proxy mode"
              value={request.mode}
              onChange={(e) =>
                setRequest((r) => ({
                  ...r,
                  mode: e.target.value as CaptureRequest['mode'],
                  pacUrl: '',
                  autoDetect: false,
                }))
              }
            >
              <option value="proxy">Graph input</option>
              <option value="automatic" disabled={!row?.advancedSupported}>
                PAC / automatic discovery
              </option>
            </select>
          </label>
        )}
        {request.mode === 'proxy' ? (
          <>
            {(!environment || request.http || request.https || request.ftp) && choose()}
            {environment && (
              <>
                <div className="capture-variable-switches">
                  {(['http', 'https', 'ftp', 'all'] as const).map((name) => (
                    <label key={name} className="check-control">
                      <input
                        type="checkbox"
                        checked={request[name]}
                        onChange={(e) => field(name, e.target.checked)}
                      />
                      {name === 'all' ? 'ALL_PROXY' : `${name.toUpperCase()}_PROXY`}
                    </label>
                  ))}
                </div>
                {request.all && (
                  <div className="capture-field-pair">
                    <label className="editor-field">
                      <span>ALL_PROXY protocol</span>
                      <select
                        aria-label="ALL_PROXY protocol"
                        value={request.allProtocol}
                        onChange={(e) =>
                          field('allProtocol', e.target.value as CaptureRequest['allProtocol'])
                        }
                      >
                        <option value="http">HTTP</option>
                        <option value="socks5h">SOCKS5 · proxy DNS</option>
                        <option value="socks5">SOCKS5 · local DNS</option>
                      </select>
                    </label>
                    {choose(true)}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <label className="editor-field">
              <span>PAC URL</span>
              <input
                aria-label="PAC URL"
                placeholder="https://example.org/proxy.pac"
                value={request.pacUrl}
                onChange={(e) => field('pacUrl', e.target.value)}
                maxLength={2000}
              />
            </label>
            <label className="check-control">
              <input
                type="checkbox"
                checked={request.autoDetect}
                onChange={(e) => field('autoDetect', e.target.checked)}
              />
              Automatic discovery (WPAD)
            </label>
          </>
        )}
        {request.mode === 'proxy' && (
          <label className="editor-field">
            <span>{environment ? 'NO_PROXY' : 'Bypass'}</span>
            <input
              aria-label={environment ? 'NO_PROXY' : 'Proxy bypass'}
              value={request.bypass}
              onChange={(e) => field('bypass', e.target.value)}
              maxLength={1000}
            />
            <small className="field-help">
              {environment
                ? 'Comma-separated hosts/IPs.'
                : 'Semicolon-separated hosts; <local> bypasses short names.'}
            </small>
          </label>
        )}
      </fieldset>
      {desktop && row?.supported && issue && <p className="field-help">{issue}</p>}
      <div className="action-row runtime-actions">
        <button
          className="primary-button"
          disabled={!canChange || !!issue || row?.conflict}
          onClick={() =>
            void run('system.capture.set', {
              ...request,
              expectedVersion: row!.version,
            })
          }
        >
          Set
        </button>
        <button
          className="secondary-button"
          disabled={!canChange || !!row?.scopeConflict}
          onClick={() =>
            void run('system.capture.clear', {
              channel,
              expectedVersion: row!.version,
            })
          }
        >
          Clear
        </button>
        <button
          className="secondary-button"
          disabled={!canChange || !row?.managed || !!row.scopeConflict}
          onClick={() =>
            void run('system.capture.restore', {
              channel,
              expectedVersion: row!.version,
            })
          }
        >
          Restore previous
        </button>
        {row?.conflict && (
          <button
            className="secondary-button"
            disabled={!canChange}
            onClick={() =>
              void run('system.capture.keepExternal', {
                channel,
                expectedVersion: row.version,
              })
            }
          >
            Keep external settings
          </button>
        )}
      </div>
      {environment && (
        <details className="capture-help">
          <summary>Apply environment changes</summary>
          <p>
            Restart the app and its parent terminal. Launch a new terminal from Start; new tabs in
            an existing terminal can inherit old values. If values remain stale, sign out and back
            in. Services can retain the old machine environment until Windows restarts.
          </p>
          <p>
            User values override system values. Remove the user value to inherit its system
            counterpart. Programs choose which variables they support; HTTPS_PROXY normally points
            to an HTTP CONNECT proxy.
          </p>
          {commands && (
            <>
              <p>For an existing PowerShell session (user overrides system):</p>
              <pre>{commands}</pre>
            </>
          )}
        </details>
      )}
    </section>
  );
}
export default function SystemCaptureSettings({
  graph,
  compiled,
  onApply,
  onClose,
  onRuntimeRefresh,
}: {
  graph: GraphState;
  compiled: RuntimeCompilation | null;
  onApply: (graph: GraphState) => void;
  onClose: () => void;
  onRuntimeRefresh: () => Promise<unknown>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    mounted = useRef(true),
    working = useRef(false);
  const [tab, setTab] = useState<Tab>('proxy'),
    [snapshot, setSnapshot] = useState<SystemCaptureSnapshot | null>(null),
    [pending, setPending] = useState<'load' | 'change' | null>(null),
    [childBusy, setChildBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState<{ scope: string; text: string } | null>(null);
  const [envScope, setEnvScope] = useState<CaptureChannel>('envUser'),
    [httpScope, setHttpScope] = useState<CaptureChannel>('winhttpLegacy'),
    [captureInput, setCaptureInput] = useState('*'),
    [confirmDriver, setConfirmDriver] = useState(false);
  const desktop = desktopServiceAvailable(),
    busy = pending !== null || childBusy,
    closeBlocked = pending === 'change' || childBusy;
  const noticeScope = tab === 'environment' ? envScope : tab === 'winhttp' ? httpScope : tab;
  useModalDialog(dialog);
  const tabs = useEditorTabs(
    [
      { key: 'proxy', label: 'Windows proxy' },
      { key: 'environment', label: 'Environment' },
      { key: 'winhttp', label: 'WinHTTP' },
      { key: 'windivert', label: 'WinDivert' },
      { key: 'loopback', label: 'Loopback' },
      { key: 'protection', label: 'App protection' },
    ] as const,
    tab,
    setTab,
  );
  useEffect(() => {
    mounted.current = true;
    if (desktop) void load();
    return () => {
      mounted.current = false;
    };
  }, [desktop]);
  async function load() {
    if (working.current) return;
    working.current = true;
    setPending('load');
    setError('');
    try {
      const value = await serviceCall<SystemCaptureSnapshot>('system.capture.get');
      if (mounted.current) setSnapshot(value);
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      working.current = false;
      if (mounted.current) setPending(null);
    }
  }
  const run: Run = async (method, params = {}) => {
    if (working.current || childBusy) return;
    working.current = true;
    setPending('change');
    setError('');
    setNotice(null);
    let confirmed = false;
    try {
      await serviceCall(method, params);
      confirmed = true;
      const value = await serviceCall<SystemCaptureSnapshot>('system.capture.get');
      if (mounted.current) {
        setSnapshot(value);
        setNotice({
          scope: noticeScope,
          text:
            method === 'system.capture.clear'
              ? 'Settings cleared.'
              : method === 'system.capture.restore'
                ? 'Previous settings restored.'
                : method === 'capture.stop'
                  ? 'Capture stopped.'
                  : 'Updated.',
        });
      }
      await onRuntimeRefresh();
    } catch (e) {
      if (mounted.current)
        setError(
          confirmed
            ? `Change applied; status refresh failed. ${errorText(e)}`
            : mutationOutcomeUnknown(e)
              ? `Could not confirm the change. Refresh before trying again. ${errorText(e)}`
              : errorText(e),
        );
      try {
        const value = await serviceCall<SystemCaptureSnapshot>('system.capture.get');
        if (mounted.current) setSnapshot(value);
      } catch {
        /* Keep the previous snapshot and show the original failure. */
      }
    } finally {
      working.current = false;
      if (mounted.current) setPending(null);
    }
  };
  const inputs = captureProxyInputs(compiled, snapshot?.inputs ?? []);
  const row = (channel: CaptureChannel) => snapshot?.rows.find((r) => r.channel === channel);
  const form = (channel: CaptureChannel) => (
    <ProxySection
      key={channel}
      channel={channel}
      row={row(channel)}
      inputs={inputs}
      environmentRows={snapshot?.rows ?? []}
      running={!!snapshot?.running}
      busy={busy}
      run={run}
    />
  );
  const captureRunning = snapshot?.capture.state === 'running';
  const available = snapshot?.capture.availability?.state === 'available';
  const captureNames = new Map(
    graph.nodes
      .filter((n) => n.data.kind === 'windivert-inbound')
      .map((n) => [String(n.data.settings.tag), n.data.label]),
  );
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window system-capture-window"
      aria-labelledby="system-capture-title"
      onClose={onClose}
      onCancel={(e) => {
        if (closeBlocked) e.preventDefault();
      }}
    >
      <div className="rule-editor-titlebar">
        <h2 id="system-capture-title">System traffic capture</h2>
        <button
          className="icon-button"
          aria-label="Close system traffic capture"
          disabled={closeBlocked}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <EditorTabs tabs={tabs} label="Traffic capture mechanisms" disabled={busy}>
        <button
          className="secondary-button icon-button"
          aria-label="Refresh system capture settings"
          disabled={!desktop || busy}
          onClick={() => void load()}
        >
          <RefreshCw size={15} />
        </button>
      </EditorTabs>
      {!desktop && (
        <p className="capture-desktop-notice">
          System controls are available in the Windows desktop app.
        </p>
      )}
      <EditorTabPanels
        tabs={tabs}
        className={(key) =>
          'system-capture-body' + (key === 'loopback' ? ' system-capture-loopback' : '')
        }
      >
        {(key) =>
          key === 'protection' ? (
            <AppProtectionSettings
              onBusyChange={setChildBusy}
              onRuntimeRefresh={onRuntimeRefresh}
            />
          ) : key === 'proxy' ? (
            form('wininet')
          ) : key === 'environment' ? (
            <>
              <label className="editor-field capture-scope-select">
                <span>Scope</span>
                <select
                  aria-label="Environment scope"
                  value={envScope}
                  disabled={busy}
                  onChange={(e) => setEnvScope(e.target.value as CaptureChannel)}
                >
                  <option value="envUser">This user</option>
                  <option value="envMachine">System</option>
                </select>
              </label>
              {form(envScope)}
            </>
          ) : key === 'winhttp' ? (
            <>
              <fieldset className="capture-http-scopes" disabled={busy}>
                <legend>Scope</legend>
                {(
                  [
                    ['winhttpLegacy', 'Legacy machine'],
                    ['winhttpMachine', 'Machine · advanced'],
                    ['winhttpUser', 'This user · advanced'],
                  ] as const
                ).map(([channel, label]) => {
                  const row = snapshot?.rows.find((r) => r.channel === channel);
                  const state = !row
                    ? 'Not loaded'
                    : !row.supported
                      ? 'Unavailable'
                      : row.values.enabled || row.values.pacUrl || row.values.autoDetect
                        ? 'On'
                        : 'Off';
                  return (
                    <label key={channel} className={httpScope === channel ? 'active' : undefined}>
                      <input
                        type="radio"
                        name="winhttp-scope"
                        value={channel}
                        checked={httpScope === channel}
                        onChange={() => setHttpScope(channel)}
                      />
                      <strong>{label}</strong>
                      <span>{state}</span>
                    </label>
                  );
                })}
              </fieldset>
              <p className="field-help">Clear changes only the selected scope.</p>
              {form(httpScope)}
            </>
          ) : key === 'windivert' ? (
            <>
              <div className="capture-current">
                <strong>Packet capture: {snapshot?.capture.state ?? 'Not loaded'}</strong>
                {snapshot?.capture.inputs.length ? (
                  <p>
                    {snapshot.capture.inputs.map((tag) => captureNames.get(tag) ?? tag).join(', ')}
                  </p>
                ) : null}
                {snapshot?.capture.availability?.message && (
                  <p className="notice notice--error" role="alert">
                    {snapshot.capture.availability.message}
                  </p>
                )}
              </div>
              <label className="editor-field">
                <span>WinDivert source</span>
                <select
                  aria-label="WinDivert source"
                  value={captureInput}
                  disabled={busy || !desktop}
                  onChange={(e) => setCaptureInput(e.target.value)}
                >
                  <option value="*">All applied WinDivert sources</option>
                  {snapshot?.captureInputs.map((tag) => (
                    <option key={tag} value={tag}>
                      {captureNames.get(tag) ?? tag}
                    </option>
                  ))}
                </select>
              </label>
              <div className="action-row runtime-actions">
                <button
                  className="primary-button"
                  disabled={
                    !desktop ||
                    busy ||
                    !snapshot?.running ||
                    !snapshot.captureInputs.length ||
                    !available
                  }
                  onClick={() =>
                    void run('capture.start', {
                      revision: snapshot!.revision,
                      inputTags: captureInput === '*' ? snapshot!.captureInputs : [captureInput],
                    })
                  }
                >
                  <Play size={14} />
                  {captureRunning ? 'Switch capture input' : 'Start capture'}
                </button>
                <button
                  className="secondary-button"
                  disabled={!desktop || busy || !captureRunning}
                  onClick={() => void run('capture.stop')}
                >
                  <Square size={14} />
                  Stop capture
                </button>
              </div>
              <p className="field-help">
                Uses the applied graph. Adapter changes below edit the draft; Apply activates them.
              </p>
              <details className="capture-help">
                <summary>Monitored adapters</summary>
                <WindowsCaptureSettings
                  graph={graph}
                  onApply={onApply}
                  onClose={() => {}}
                  adaptersOnly
                  embedded
                  onMutationChange={setChildBusy}
                />
              </details>
              <section className="capture-driver">
                <h3>WinDivert driver</h3>
                <p>
                  {!snapshot
                    ? 'Not loaded'
                    : snapshot.driver.registered
                      ? `${snapshot.driver.state}${snapshot.driver.owned ? ' · this installation' : ' · external registration'}`
                      : 'Not registered'}
                </p>
                <div className="action-row runtime-actions">
                  <button
                    className="secondary-button"
                    disabled={
                      !desktop ||
                      busy ||
                      snapshot?.driver.registered ||
                      !available ||
                      captureRunning
                    }
                    onClick={() =>
                      void run('windivert.driver.install', {
                        expectedVersion: snapshot!.driver.version,
                      })
                    }
                  >
                    Install driver
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      !desktop ||
                      busy ||
                      !snapshot?.driver.owned ||
                      captureRunning ||
                      !available ||
                      !confirmDriver
                    }
                    onClick={() =>
                      void run('windivert.driver.uninstall', {
                        expectedVersion: snapshot!.driver.version,
                      })
                    }
                  >
                    Uninstall driver
                  </button>
                </div>
                <label className="check-control">
                  <input
                    type="checkbox"
                    checked={confirmDriver}
                    disabled={busy}
                    onChange={(e) => setConfirmDriver(e.target.checked)}
                  />
                  Other WinDivert applications are stopped
                </label>
                <p className="field-help">
                  Uninstall removes this app’s driver registration, not the bundled files. Foreign
                  registrations and active captures are preserved.
                </p>
              </section>
            </>
          ) : (
            <WindowsCaptureSettings
              graph={graph}
              onApply={onApply}
              onClose={() => {}}
              embedded
              loopbackOnly
              initialTab="loopback"
              onMutationChange={setChildBusy}
            />
          )
        }
      </EditorTabPanels>
      <div className="system-capture-feedback" aria-live="polite">
        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
        {notice?.scope === noticeScope && !error && <p role="status">{notice.text}</p>}
        {pending && <p role="status">Working…</p>}
      </div>
      <div className="rule-editor-footer">
        <p className="field-help">Changes apply immediately. Stop restores owned settings.</p>
        <button className="secondary-button" disabled={closeBlocked} onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
