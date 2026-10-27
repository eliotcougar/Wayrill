import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import useModalDialog from './useModalDialog';
import type { StashGroup } from '../profiles/import';
import {
  maintenanceDefaults,
  validMaintenance,
  type SubscriptionMaintenance,
} from '../profiles/subscriptionState';
import { jsonArray, parseJson } from '../graph/xrayJson';
import { boundedText } from '../text';
import { appVersion } from '../version';
import { subscriptionUrlKey } from '../profiles/subscriptionManagement';

export type SubscriptionSettings = Pick<
  StashGroup,
  'name' | 'url' | 'userAgent' | 'headers' | 'allowHttp'
> & {
  maintenance: SubscriptionMaintenance;
};
export type SubscriptionSubmission =
  | { kind: 'subscription'; settings: SubscriptionSettings; refresh?: boolean }
  | { kind: 'paste'; name: string; content: string };

/** One draft for source, download and maintenance settings; only Save commits it. */
export default function SubscriptionSettingsForm({
  group,
  groups,
  busy,
  error: operationError,
  onSubmit,
  onCancel,
}: {
  group?: StashGroup;
  groups: StashGroup[];
  busy: boolean;
  error: string;
  onSubmit: (value: SubscriptionSubmission) => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  useModalDialog(dialog);
  useEffect(() => {
    nameInput.current?.focus();
  }, []);
  const [mode, setMode] = useState<'url' | 'paste'>('url');
  const [name, setName] = useState(group?.name ?? 'Imported configurations');
  const [url, setUrl] = useState(group?.url ?? '');
  const [acknowledgedUrl, setAcknowledgedUrl] = useState('');
  const duplicate =
    url.trim() &&
    (!group || subscriptionUrlKey(group.url ?? '') !== subscriptionUrlKey(url)) &&
    groups.find(
      (value) =>
        value.id !== group?.id &&
        value.url &&
        subscriptionUrlKey(value.url) === subscriptionUrlKey(url),
    );
  const duplicatePending = !!duplicate && acknowledgedUrl !== subscriptionUrlKey(url);
  const [urlFocused, setUrlFocused] = useState(false);
  const [agent, setAgent] = useState(group?.userAgent ?? '');
  const [headers, setHeaders] = useState(JSON.stringify(group?.headers ?? {}, null, 2));
  const [allowHttp, setAllowHttp] = useState(group?.allowHttp ?? false);
  const [content, setContent] = useState('');
  const [maintenance, setMaintenance] = useState(
    group?.maintenance ??
      (group
        ? maintenanceDefaults
        : { ...maintenanceDefaults, autoRefresh: true, removeUnreachable: true }),
  );
  const [error, setError] = useState('');
  const advanced = useRef<HTMLDetailsElement>(null);
  const hasUrl = !!url.trim();
  const set = (patch: Partial<SubscriptionMaintenance>) => {
    const next = { ...maintenance, ...patch };
    const interval = (n: number) => Number.isInteger(n) && n >= 1 && n <= 10080;
    // Hidden options must never leave an invalid draft that cannot be saved.
    if (!next.autoRefresh && !interval(next.refreshMinutes))
      next.refreshMinutes = maintenanceDefaults.refreshMinutes;
    if (
      !next.removeUnreachable &&
      (!Number.isInteger(next.maxRetries) || next.maxRetries < 0 || next.maxRetries > 5)
    )
      next.maxRetries = maintenanceDefaults.maxRetries;
    setMaintenance(next);
  };
  const effectiveMaintenance = hasUrl
    ? maintenance
    : { ...maintenance, autoRefresh: false, refreshMinutes: maintenanceDefaults.refreshMinutes };
  const submit = (refresh = false) => {
    if (
      busy ||
      !name.trim() ||
      (mode === 'url' && (duplicatePending || !validMaintenance(effectiveMaintenance)))
    )
      return;
    setError('');
    if (mode === 'paste') {
      onSubmit({ kind: 'paste', name: name.trim(), content });
      return;
    }
    try {
      const address = url.trim();
      if (address || !group) {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(address);
        } catch {
          throw new Error('Enter a valid subscription URL.');
        }
        if (
          !['https:', 'http:'].includes(parsedUrl.protocol) ||
          parsedUrl.username ||
          parsedUrl.password ||
          parsedUrl.hash
        )
          throw new Error(
            'Use an HTTP(S) subscription URL without login credentials or a fragment.',
          );
        if (parsedUrl.protocol === 'http:' && !allowHttp) {
          if (advanced.current) advanced.current.open = true;
          throw new Error('Enable Allow unencrypted HTTP, or use HTTPS.');
        }
      }
      let parsed: unknown = group?.headers ?? {};
      if (hasUrl) {
        try {
          parsed = parseJson(headers);
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            jsonArray(parsed) ||
            !Object.values(parsed).every((value) => typeof value === 'string')
          )
            throw new Error('Expected text values.');
        } catch {
          if (advanced.current) advanced.current.open = true;
          throw new Error('Request headers must be a JSON object with text values.');
        }
      }
      onSubmit({
        kind: 'subscription',
        ...(refresh ? { refresh: true } : {}),
        settings: {
          name: name.trim(),
          url: address,
          userAgent: agent,
          headers: parsed as Record<string, string>,
          allowHttp,
          maintenance: effectiveMaintenance,
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window subscription-settings-window"
      aria-labelledby="subscription-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
      onClose={onCancel}
    >
      <div className="rule-editor-titlebar">
        <h2 id="subscription-settings-title">
          {group ? (
            <>
              Edit <bdi>{group.name}</bdi>
            </>
          ) : (
            'Import configurations'
          )}
        </h2>
        <button className="icon-button" aria-label="Close subscription settings" onClick={onCancel}>
          <X size={18} />
        </button>
      </div>
      <form
        className="stash-import subscription-settings-form"
        aria-label={group ? 'Subscription settings' : 'Import configurations'}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) submit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        {(error || operationError) && (
          <div className="runtime-error" role="alert">
            {error || operationError}
          </div>
        )}
        <fieldset className="stash-settings-fields" disabled={busy}>
          {!group && (
            <div className="stash-import-modes" role="group" aria-label="Import source">
              <button
                type="button"
                className="secondary-button"
                aria-pressed={mode === 'url'}
                onClick={() => {
                  setMode('url');
                  setError('');
                }}
              >
                Subscription URL
              </button>
              <button
                type="button"
                className="secondary-button"
                aria-pressed={mode === 'paste'}
                onClick={() => {
                  setMode('paste');
                  setError('');
                }}
              >
                Paste configurations
              </button>
            </div>
          )}
          <label>
            Group name
            <input
              autoComplete="off"
              ref={nameInput}
              aria-label="Group name"
              value={name}
              onChange={(event) => setName(boundedText(event.target.value, 128))}
            />
          </label>
          {mode === 'paste' ? (
            <label>
              Configurations / subscription content
              <textarea
                aria-label="Configurations / subscription content"
                spellCheck={false}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="Paste links, a plain/Base64 subscription, Xray JSON, or subscription-group JSON."
              />
            </label>
          ) : (
            <>
              <div className="stash-subscription">
                <label>
                  Subscription URL{group && !group.url ? ' (optional)' : ''}
                  <input
                    autoComplete="off"
                    type={urlFocused ? 'text' : 'password'}
                    spellCheck={false}
                    autoCapitalize="off"
                    onFocus={() => setUrlFocused(true)}
                    onBlur={() => setUrlFocused(false)}
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://…"
                  />
                </label>
                {hasUrl && (
                  <label>
                    Download via
                    <select
                      value={maintenance.viaProxy ? 'proxy' : 'direct'}
                      onChange={(event) => set({ viaProxy: event.target.value === 'proxy' })}
                    >
                      <option value="direct">Direct connection</option>
                      <option value="proxy">Running Wayrill proxy</option>
                    </select>
                  </label>
                )}
              </div>
              {duplicate && (
                <div className="subscription-duplicate runtime-note">
                  <span>
                    This URL is already used by <bdi>{duplicate.name}</bdi>.
                  </span>
                  <label className="stash-checkbox">
                    <input
                      type="checkbox"
                      checked={!duplicatePending}
                      onChange={(event) =>
                        setAcknowledgedUrl(event.target.checked ? subscriptionUrlKey(url) : '')
                      }
                    />
                    Use it in a separate group
                  </label>
                </div>
              )}
              {hasUrl && (
                <>
                  <div className="subscription-refresh-fields">
                    <label className="stash-checkbox">
                      <input
                        type="checkbox"
                        checked={maintenance.autoRefresh}
                        onChange={(event) => set({ autoRefresh: event.target.checked })}
                      />
                      Refresh automatically
                    </label>
                    {hasUrl && (
                      <label>
                        Update interval (minutes)
                        <input
                          type="number"
                          min="1"
                          max="10080"
                          disabled={!maintenance.autoRefresh}
                          value={
                            Number.isNaN(maintenance.refreshMinutes)
                              ? ''
                              : maintenance.refreshMinutes
                          }
                          onChange={(event) =>
                            set({ refreshMinutes: event.currentTarget.valueAsNumber })
                          }
                        />
                      </label>
                    )}
                  </div>
                  <details ref={advanced} className="subscription-request-settings">
                    <summary>Advanced request settings</summary>
                    <label>
                      User-Agent
                      <input
                        autoComplete="off"
                        value={agent}
                        maxLength={512}
                        onChange={(event) => setAgent(event.target.value)}
                        placeholder={`Wayrill/${appVersion}`}
                      />
                    </label>
                    <label>
                      Request headers (JSON)
                      <textarea
                        spellCheck={false}
                        value={headers}
                        onChange={(event) => setHeaders(event.target.value)}
                      />
                    </label>
                    <label className="stash-checkbox">
                      <input
                        type="checkbox"
                        checked={allowHttp}
                        onChange={(event) => setAllowHttp(event.target.checked)}
                      />
                      Allow unencrypted HTTP
                    </label>
                  </details>
                </>
              )}
              <fieldset className="subscription-health-fields">
                <legend>Server health</legend>
                <label className="stash-checkbox">
                  <input
                    type="checkbox"
                    checked={maintenance.removeUnreachable}
                    onChange={(event) => set({ removeUnreachable: event.target.checked })}
                  />
                  Remove unreachable servers
                </label>
                {maintenance.removeUnreachable && (
                  <div className="subscription-health-intervals">
                    <label>
                      Max retries after the first attempt
                      <input
                        type="number"
                        min="0"
                        max="5"
                        value={Number.isNaN(maintenance.maxRetries) ? '' : maintenance.maxRetries}
                        onChange={(event) => set({ maxRetries: event.currentTarget.valueAsNumber })}
                      />
                    </label>
                  </div>
                )}
                {maintenance.removeUnreachable && (
                  <p className="field-help">Used and locked entries are kept.</p>
                )}
              </fieldset>
              <p className="field-help">
                {group?.maintenancePaused
                  ? 'Automatic maintenance is paused. Manual refresh remains available.'
                  : 'The networking service runs automatic maintenance.'}
              </p>
            </>
          )}
        </fieldset>
        <div className="subscription-settings-actions">
          <button
            type="submit"
            className="primary-button"
            disabled={
              busy ||
              !name.trim() ||
              (mode === 'paste'
                ? !content.trim()
                : (!group && !hasUrl) ||
                  duplicatePending ||
                  !validMaintenance(effectiveMaintenance))
            }
          >
            {group ? 'Save settings' : mode === 'paste' ? 'Import into stash' : 'Add & download'}
          </button>
          {group && hasUrl && (
            <button
              type="button"
              className="secondary-button"
              disabled={
                busy || !name.trim() || duplicatePending || !validMaintenance(effectiveMaintenance)
              }
              onClick={() => submit(true)}
            >
              Save & refresh
            </button>
          )}
          <button type="button" className="secondary-button" onClick={onCancel}>
            {busy ? 'Cancel operation' : 'Cancel'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
