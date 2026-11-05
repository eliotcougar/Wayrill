import { useEffect, useRef, useState } from 'react';
import { CheckCheck, Upload, X } from 'lucide-react';
import { errorMessage, type ConfigValidation, type RemoteClient } from './remoteClient';
import { useServerJob } from './useServerJob';
import JobOutput from './JobOutput';
import { restoreRemoteDocument } from './remoteDocument';

async function sha256(text: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default function ConfigDeploymentDialog({
  client,
  sessionId,
  server,
  path,
  expectedSha256,
  configText,
  wayrillText,
  wayrillPath,
  expectedWayrillSha256,
  companionAvailable = true,
  configChanged = true,
  services,
  changed,
  onApplied,
  onClose,
}: {
  client: RemoteClient;
  sessionId: string;
  server: string;
  path: string;
  expectedSha256: string;
  configText: string;
  wayrillText?: string;
  wayrillPath?: string;
  expectedWayrillSha256?: string | null;
  companionAvailable?: boolean;
  configChanged?: boolean;
  services: string[];
  changed: boolean;
  onApplied: (sha256: string, wayrillSha256: string | null) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [service, setService] = useState(
    services.includes('xray.service') ? 'xray.service' : (services[0] ?? 'xray.service'),
  );
  const [validation, setValidation] = useState<ConfigValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [expired, setExpired] = useState(false);
  const pending = useRef({ sequence: 0, active: false });
  const applied = useRef('');
  useEffect(() => {
    pending.current.sequence++;
    if (pending.current.active) {
      pending.current.active = false;
      void client.cancel().catch(() => {});
    }
    setValidating(false);
    setValidation(null);
    setConfirming(false);
  }, [client, configText, wayrillText, expectedSha256, expectedWayrillSha256]);
  const operation = useServerJob(client, sessionId, () => {});
  const job = operation.request?.action === 'applyConfig' ? operation.job : null;
  const locked = validating || operation.active;
  const ready =
    !!validation?.valid &&
    !!validation.id &&
    !expired &&
    changed &&
    companionAvailable &&
    !locked &&
    validation.service === service &&
    validation.sourceSha256 === expectedSha256;
  useEffect(() => {
    const element = dialog.current;
    const request = pending.current;
    element?.showModal();
    return () => {
      request.sequence++;
      if (request.active) void client.cancel().catch(() => {});
      element?.close();
    };
  }, [client]);
  useEffect(() => {
    setExpired(false);
    if (!validation) return;
    const timer = setTimeout(
      () => {
        setExpired(true);
        setConfirming(false);
      },
      Math.max(0, validation.expiresAt * 1000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [validation]);
  useEffect(() => {
    const result = job?.configResult;
    if (
      job?.state !== 'succeeded' ||
      !result ||
      applied.current === job.id ||
      result.path !== path ||
      result.originalSha256 !== expectedSha256 ||
      operation.request?.planId !== result.planId
    )
      return;
    let active = true;
    const reconcile = async () => {
      if (validation?.id !== result.planId) {
        // Progress can be closed while a job keeps running. Its receipt may
        // update this baseline only if both the config and layout still match.
        const [configHash, graphHash] = await Promise.all([
          sha256(configText),
          wayrillText === undefined ? Promise.resolve(null) : sha256(wayrillText),
        ]);
        if (configHash !== result.installedSha256 || graphHash !== (result.wayrillSha256 ?? null))
          return;
      }
      if (active && applied.current !== job.id) {
        applied.current = job.id;
        onApplied(result.installedSha256, result.wayrillSha256 ?? null);
      }
    };
    void reconcile().catch(() => {
      if (active)
        setError(
          'The completed deployment could not be verified. Refresh the configuration from the server.',
        );
    });
    return () => {
      active = false;
    };
  }, [
    configText,
    expectedSha256,
    job,
    onApplied,
    operation.request?.planId,
    path,
    validation?.id,
    wayrillText,
  ]);
  useEffect(() => {
    if (
      job &&
      ['failed', 'interrupted'].includes(job.state) &&
      operation.request?.planId === validation?.id
    ) {
      setValidation(null);
      setConfirming(false);
    }
  }, [job, operation.request, validation]);
  const validate = async () => {
    const sequence = ++pending.current.sequence;
    pending.current.active = true;
    setValidating(true);
    setValidation(null);
    setConfirming(false);
    setError('');
    try {
      if (wayrillText !== undefined) restoreRemoteDocument(configText, wayrillText);
      const result = await client.validateConfig(sessionId, {
        path,
        service,
        expectedSha256,
        configText,
        ...(wayrillText !== undefined
          ? { wayrillText, expectedWayrillSha256: expectedWayrillSha256 ?? null }
          : {}),
        stage: true,
      });
      if (sequence === pending.current.sequence) setValidation(result);
    } catch (reason) {
      if (sequence === pending.current.sequence) setError(errorMessage(reason));
    } finally {
      if (sequence === pending.current.sequence) {
        pending.current.active = false;
        setValidating(false);
      }
    }
  };
  return (
    <dialog
      ref={dialog}
      className="user-library-dialog config-deploy-dialog"
      aria-label="Validate and apply configuration"
      onCancel={(event) => {
        event.preventDefault();
        if (confirming) setConfirming(false);
        else onClose();
      }}
    >
      <header className="user-dialog-header">
        <h2>Validate and apply configuration</h2>
        <button
          className="icon-button"
          aria-label="Close configuration deployment"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="remote-settings-body config-deploy-body">
        <dl className="config-deploy-target">
          <div>
            <dt>Server</dt>
            <dd>{server}</dd>
          </div>
          <div>
            <dt>Configuration</dt>
            <dd>{path}</dd>
          </div>
          {wayrillPath && (
            <div>
              <dt>Wayrill file</dt>
              <dd>{wayrillPath}</dd>
            </div>
          )}
        </dl>
        <label>
          Xray service
          <input
            aria-label="Xray service"
            list="deployment-services"
            value={service}
            disabled={locked}
            onChange={(event) => {
              setService(event.target.value);
              setValidation(null);
              setConfirming(false);
              setError('');
            }}
          />
          <datalist id="deployment-services">
            {services.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        {!companionAvailable && (
          <p className="status-error">
            The Wayrill file could not be read. Resolve its access error and reconnect before
            applying.
          </p>
        )}
        {wayrillText !== undefined && (
          <p className="muted">
            Saves the graph and layout beside the Xray configuration.
            {!configChanged && ' Xray will keep running.'}
          </p>
        )}
        {!changed && <p className="muted">The draft matches the loaded configuration.</p>}
        {validating && (
          <div role="status">
            <strong>Validating with the server’s Xray…</strong>
            <progress aria-label="Configuration validation progress" />
          </div>
        )}
        {error && (
          <p className="status-error" role="alert">
            {error}
          </p>
        )}
        {validation && (
          <section className="config-validation-result" aria-label="Server validation result">
            <strong>
              {validation.valid ? 'Validation passed' : 'Validation failed'}
              {validation.coreVersion ? ` · Xray ${validation.coreVersion}` : ''}
            </strong>
            <p className={validation.valid ? 'muted' : 'status-error'}>{validation.message}</p>
            {expired && (
              <p className="status-warning">Validation expired. Validate again before applying.</p>
            )}
            {!!validation.logs.length && (
              <details>
                <summary>Validation output</summary>
                <pre tabIndex={0}>{validation.logs.join('\n')}</pre>
              </details>
            )}
          </section>
        )}
        {operation.request && (
          <section className="server-job" aria-label="Configuration deployment progress">
            {operation.request.action !== 'applyConfig' && (
              <p className="status-warning">
                Another server job is selected: {operation.request.action}.
              </p>
            )}
            <div className="server-job-title">
              <strong>
                {operation.launching
                  ? 'Submitting configuration…'
                  : (operation.job?.stage ?? 'Checking server job…')}
              </strong>
              {operation.job?.percent != null && <span>{operation.job.percent}%</span>}
            </div>
            {operation.active && (
              <progress
                aria-label="Configuration apply progress"
                max={100}
                value={operation.error ? undefined : (operation.job?.percent ?? undefined)}
              />
            )}
            {operation.job?.message && (
              <p
                className={
                  operation.job.state === 'failed' || operation.job.state === 'interrupted'
                    ? 'status-error'
                    : 'muted'
                }
              >
                {operation.job.message}
              </p>
            )}
            {job?.configResult && (
              <label>
                Backup on server
                <input aria-label="Backup on server" readOnly value={job.configResult.backupPath} />
              </label>
            )}
            {operation.error && (
              <p className="status-warning" role="alert">
                {operation.error}
              </p>
            )}
            {operation.retry ? (
              <div className="server-actions">
                <button
                  onClick={() => {
                    void operation.retryRequest();
                  }}
                >
                  Retry same request
                </button>
                <button onClick={operation.dismiss}>Dismiss</button>
              </div>
            ) : (
              operation.active && (
                <p className="muted">Closing this window does not cancel the server job.</p>
              )
            )}
            {!operation.active && <button onClick={operation.dismiss}>Dismiss result</button>}
            {!!operation.job?.logs.length && (
              <JobOutput key={operation.job.id} logs={operation.job.logs} />
            )}
          </section>
        )}
        {confirming && (
          <section
            className="server-confirm"
            role="alertdialog"
            aria-label="Confirm configuration apply"
          >
            <strong>
              {configChanged
                ? `Apply to ${server} and restart ${service}?`
                : `Save graph and layout on ${server}?`}
            </strong>
            <p>
              {configChanged
                ? 'Both files will be backed up. If Xray fails to start or remain running, Wayrill restores the backups and restarts the previous configuration.'
                : 'The Wayrill file will be backed up. No Xray restart is needed.'}
            </p>
            <div className="server-actions">
              <button onClick={() => setConfirming(false)}>Cancel apply</button>
              <button
                className="primary-button"
                disabled={!ready}
                onClick={() => {
                  if (!validation?.id || !ready) return;
                  setConfirming(false);
                  void operation.start({ action: 'applyConfig', planId: validation.id });
                }}
              >
                {configChanged ? 'Apply & restart' : 'Save graph'}
              </button>
            </div>
          </section>
        )}
      </div>
      <footer className="user-dialog-footer">
        <button
          disabled={
            !companionAvailable || locked || !/^[A-Za-z0-9_@.-]{1,180}\.service$/.test(service)
          }
          onClick={() => {
            void validate();
          }}
        >
          <CheckCheck size={16} />
          Validate on server
        </button>
        <span className="config-deploy-spacer" />
        <button onClick={onClose}>Close</button>
        <button
          className="primary-button"
          disabled={!ready || confirming}
          onClick={() => setConfirming(true)}
        >
          <Upload size={16} />
          Apply…
        </button>
      </footer>
    </dialog>
  );
}
