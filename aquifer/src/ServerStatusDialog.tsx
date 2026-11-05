import { useEffect, useRef, useState } from 'react';
import { Download, Power, RefreshCw, RotateCw, Search, X } from 'lucide-react';
import {
  errorMessage,
  type ActionRequest,
  type RemoteClient,
  type ServerStatus,
  type UpgradePlan,
} from './remoteClient';
import { useServerJob } from './useServerJob';
import UpgradePlanPreview from './UpgradePlanPreview';
import JobOutput from './JobOutput';

const date = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const PAGE_SIZE = 100;
const actionNames = {
  refreshApt: 'APT package lists',
  upgradeAll: 'Package updates',
  distUpgrade: 'Full upgrade',
  upgradePackage: 'Package update',
  restartXray: 'Xray restart',
  reboot: 'Server reboot',
  applyConfig: 'Configuration apply',
};

export default function ServerStatusDialog({
  status,
  session,
  sessionId,
  client,
  busy,
  error,
  onRefresh,
  onCancel,
  onClose,
}: {
  status: ServerStatus | null;
  session: string;
  sessionId: string;
  client: RemoteClient;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    detail: string;
    request: Omit<ActionRequest, 'id'>;
    plan?: UpgradePlan;
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewRequest = useRef({ sequence: 0, pending: false });
  useEffect(
    () => () => {
      previewRequest.current.sequence++;
      if (previewRequest.current.pending) void client.cancel().catch(() => {});
    },
    [client],
  );
  const cancelPreview = () => {
    previewRequest.current.sequence++;
    previewRequest.current.pending = false;
    setPreviewing(false);
    void client.cancel().catch(() => {});
  };
  const previewUpgrade = async () => {
    const token = ++previewRequest.current.sequence;
    previewRequest.current.pending = true;
    setPreviewing(true);
    setPreviewError('');
    setConfirmation(null);
    try {
      const plan = await client.previewUpgrade(sessionId);
      if (token === previewRequest.current.sequence)
        setConfirmation({
          title: 'Review full upgrade (dist-upgrade)',
          detail:
            'Install the reviewed package changes. Listed removals will be performed. Package scripts may restart services.',
          request: { action: 'distUpgrade', planId: plan.id },
          plan,
        });
    } catch (reason) {
      if (token === previewRequest.current.sequence) setPreviewError(errorMessage(reason));
    } finally {
      if (token === previewRequest.current.sequence) {
        previewRequest.current.pending = false;
        setPreviewing(false);
      }
    }
  };
  const close = () => {
    if (previewing) cancelPreview();
    onClose();
  };
  const confirmFocus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirmation) return;
    const previous = document.activeElement;
    confirmFocus.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [confirmation]);
  const operation = useServerJob(client, sessionId, onRefresh);
  const locked = busy || operation.active || previewing;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const packages =
    status?.apt.packages.filter((item) =>
      item.name.toLowerCase().includes(query.trim().toLowerCase()),
    ) ?? [];
  const pages = Math.max(1, Math.ceil(packages.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const xray = status?.xray;
  const running = !!xray?.processes.length || xray?.services.some((s) => s.subState === 'running');
  const daemonState = running
    ? 'Running'
    : xray?.services.find((s) => s.activeState === 'failed')
      ? 'Failed'
      : xray?.services.find((s) => s.activeState === 'activating')
        ? 'Starting'
        : xray?.error
          ? 'Unavailable'
          : xray?.services.length
            ? 'Stopped'
            : 'Not detected';
  return (
    <dialog
      ref={dialog}
      className="server-status-dialog"
      aria-labelledby="server-status-title"
      onCancel={(event) => {
        if (confirmation) {
          event.preventDefault();
          setConfirmation(null);
        } else close();
      }}
    >
      <header>
        <div>
          <h2 id="server-status-title">Server status</h2>
          <p className="muted">{status?.hostname ?? session}</p>
        </div>
        <button disabled={locked || !!confirmation} onClick={onRefresh}>
          <RefreshCw size={16} className={busy ? 'spin' : undefined} />
          Refresh
        </button>
        <button className="icon-button" aria-label="Close server status" onClick={close}>
          <X size={18} />
        </button>
      </header>
      <div className="server-status-body" aria-busy={busy}>
        {error && (
          <p className="status-error" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p className="status-loading" role="status">
            Reading server status… <button onClick={onCancel}>Cancel</button>
          </p>
        )}
        {previewing && (
          <p className="status-loading" role="status">
            Reading full-upgrade plan… <button onClick={cancelPreview}>Cancel</button>
          </p>
        )}
        {previewError && (
          <p className="status-error" role="alert">
            {previewError}
          </p>
        )}
        {operation.request && (
          <div className="server-job" aria-live="polite">
            <p className="muted">
              {actionNames[operation.request.action]}
              {operation.request.package ? ` · ${operation.request.package}` : ''}
            </p>
            <div className="server-job-title">
              <strong>
                {operation.launching
                  ? 'Submitting server action…'
                  : (operation.job?.stage ?? 'Connecting to server job…')}
              </strong>
              {operation.job?.percent !== null && operation.job?.percent !== undefined && (
                <span>{operation.job.percent}%</span>
              )}
            </div>
            {operation.active && (
              <progress
                aria-label="Server action progress"
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
            {operation.error && (
              <p className="status-warning">
                {operation.error} {operation.retry ? '' : 'Reconnecting to check progress…'}
              </p>
            )}
            {operation.retry && (
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
            )}
            {['PLAN_CHANGED', 'PLAN_EXPIRED'].includes(operation.job?.errorCode ?? '') && (
              <button
                disabled={locked || !!confirmation}
                onClick={() => {
                  void previewUpgrade();
                }}
              >
                Preview full upgrade again
              </button>
            )}
            {operation.active && !operation.retry && (
              <p className="muted">Closing this window does not cancel a server job.</p>
            )}
            {!!operation.job?.logs.length && (
              <JobOutput key={operation.job.id} logs={operation.job.logs} />
            )}
          </div>
        )}
        {confirmation && (
          <div
            ref={confirmFocus}
            tabIndex={-1}
            className="server-confirm"
            role="alertdialog"
            aria-labelledby="server-confirm-title"
            aria-describedby="server-confirm-detail"
          >
            <strong id="server-confirm-title">{confirmation.title}</strong>
            <p id="server-confirm-detail">{confirmation.detail}</p>
            {confirmation.plan && <UpgradePlanPreview plan={confirmation.plan} />}
            <div className="server-actions">
              <button onClick={() => setConfirmation(null)}>Cancel</button>
              <button
                className="primary"
                disabled={
                  locked ||
                  (!!confirmation.plan &&
                    !confirmation.plan.installs.length &&
                    !confirmation.plan.upgrades.length &&
                    !confirmation.plan.removals.length)
                }
                onClick={() => {
                  void operation.start(confirmation.request);
                  setConfirmation(null);
                }}
              >
                {confirmation.plan ? 'Install full upgrade' : 'Confirm'}
              </button>
            </div>
          </div>
        )}
        {status && (
          <>
            <p className="status-timestamp">
              Checked {date(status.checkedAt)} · SSH user: {status.user} ·{' '}
              {status.uid === 0 ? 'Runs as root' : 'Actions use sudo (noninteractive)'}
            </p>
            <section>
              <h3>
                System restart{' '}
                <span className={status.reboot.required ? 'status-warning' : ''}>
                  {status.reboot.required === null
                    ? 'Unknown'
                    : status.reboot.required
                      ? 'Required'
                      : 'Not reported'}
                </span>
              </h3>
              <p className="muted">Reported by /run/reboot-required.</p>
              {status.reboot.packages.length > 0 && (
                <p className="status-package-names">{status.reboot.packages.join(', ')}</p>
              )}
              {status.reboot.error && <p className="status-warning">{status.reboot.error}</p>}
              <div className="server-actions">
                <button
                  disabled={locked || !!confirmation}
                  onClick={() =>
                    setConfirmation({
                      title: `Reboot ${status.hostname}?`,
                      detail:
                        'The server will disconnect until it finishes restarting. Xray will be interrupted. Progress reconnects automatically.',
                      request: { action: 'reboot' },
                    })
                  }
                >
                  <Power size={15} />
                  Reboot server
                </button>
              </div>
            </section>
            <section>
              <h3>
                Xray daemon{' '}
                <span className={running ? 'status-success' : 'status-warning'}>{daemonState}</span>
              </h3>
              <p className="xray-version">
                Installed Xray <strong>{xray?.installedVersion ?? 'Unknown'}</strong>
                {xray?.binary && <code>{xray.binary}</code>}
              </p>
              {xray?.versionError && <p className="status-warning">{xray.versionError}</p>}
              {xray?.error && <p className="status-warning">{xray.error}</p>}
              {!!xray?.services.length && (
                <table className="status-table">
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>State</th>
                      <th>PID</th>
                      <th>Active since</th>
                      <th>
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {xray.services.map((service) => (
                      <tr key={service.name}>
                        <td>
                          <strong>{service.name}</strong>
                          {service.unitFileState && <small>{service.unitFileState}</small>}
                          {service.needsDaemonReload && (
                            <small className="status-warning">Unit definition changed</small>
                          )}
                        </td>
                        <td>
                          {service.activeState} · {service.subState}
                        </td>
                        <td>{service.mainPid ?? '—'}</td>
                        <td>{service.startedAt ?? '—'}</td>
                        <td>
                          <button
                            disabled={locked || !!confirmation}
                            aria-label={`Restart ${service.name}`}
                            onClick={() =>
                              setConfirmation({
                                title: `Restart ${service.name}?`,
                                detail:
                                  'Existing Xray connections may close. The configuration file is left unchanged.',
                                request: { action: 'restartXray', service: service.name },
                              })
                            }
                          >
                            <RotateCw size={14} />
                            Restart
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!!xray?.processes.length && (
                <ul className="status-processes">
                  {xray.processes.map((process) => (
                    <li key={process.pid}>
                      PID {process.pid} · <code>{process.executable}</code>
                      {process.replacedExecutable && (
                        <span className="status-warning">
                          {' '}
                          · Executable replaced or deleted; restart recommended
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!xray?.processes.length && !xray?.error && (
                <p className="muted">No Xray process visible to this account.</p>
              )}
            </section>
            <section>
              <h3>
                APT updates{' '}
                <span>
                  {status.apt.error
                    ? 'Unavailable'
                    : `${status.apt.upgraded ?? 0} ${status.apt.upgraded === 1 ? 'upgrade' : 'upgrades'}`}
                </span>
              </h3>
              <p className="muted">
                Available updates from cached package lists.
                {status.apt.indexesUpdatedAt
                  ? ` Newest index: ${date(status.apt.indexesUpdatedAt)}.`
                  : ''}
              </p>
              <div className="server-actions">
                <button
                  disabled={locked || !!confirmation || !status.apt.available}
                  onClick={() => {
                    void operation.start({ action: 'refreshApt' });
                  }}
                >
                  <RefreshCw size={15} />
                  Refresh package lists
                </button>
                <button
                  disabled={locked || !!confirmation || !!status.apt.error || !status.apt.upgraded}
                  onClick={() =>
                    setConfirmation({
                      title: 'Install available updates?',
                      detail:
                        'Runs apt-get upgrade. Existing configuration files are preserved; packages requiring new dependencies remain held back. Package scripts may restart services.',
                      request: { action: 'upgradeAll' },
                    })
                  }
                >
                  <Download size={15} />
                  Install updates
                </button>
                <button
                  disabled={locked || !!confirmation || !status.apt.available}
                  onClick={() => {
                    void previewUpgrade();
                  }}
                >
                  Full upgrade…
                </button>
              </div>
              {status.apt.error ? (
                <p className="status-warning">{status.apt.error}</p>
              ) : (
                <>
                  {!!status.apt.heldBack && (
                    <p className="status-warning">
                      {status.apt.heldBack} packages kept back by apt-get upgrade.
                    </p>
                  )}
                  {status.apt.packages.length > 0 && (
                    <>
                      <div className="status-package-tools">
                        <div className="search-field">
                          <Search size={15} />
                          <input
                            aria-label="Search packages"
                            placeholder="Search packages"
                            value={query}
                            onChange={(event) => {
                              setQuery(event.target.value);
                              setPage(0);
                            }}
                          />
                        </div>
                        <span>{packages.length} packages</span>
                      </div>
                      <table className="status-table package-table">
                        <thead>
                          <tr>
                            <th>Package</th>
                            <th>Installed</th>
                            <th>Available</th>
                            <th>
                              <span className="visually-hidden">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {packages
                            .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
                            .map((item) => (
                              <tr key={item.name}>
                                <td title={item.source}>{item.name}</td>
                                <td>{item.installedVersion ?? '—'}</td>
                                <td>{item.candidateVersion}</td>
                                <td>
                                  <button
                                    disabled={locked || !!confirmation}
                                    aria-label={`Install update for ${item.name}`}
                                    onClick={() =>
                                      setConfirmation({
                                        title: `Update ${item.name}?`,
                                        detail: `Install ${item.candidateVersion}. Required dependencies may also be updated or installed. Existing configuration files are preserved.`,
                                        request: {
                                          action: 'upgradePackage',
                                          package: item.name,
                                          candidateVersion: item.candidateVersion,
                                        },
                                      })
                                    }
                                  >
                                    Install
                                  </button>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                      {packages.length === 0 && <p className="muted">No packages match.</p>}
                      {pages > 1 && (
                        <div className="status-pagination">
                          <button
                            disabled={currentPage === 0}
                            onClick={() => setPage(currentPage - 1)}
                          >
                            Previous
                          </button>
                          <span>
                            {currentPage + 1} / {pages}
                          </span>
                          <button
                            disabled={currentPage + 1 >= pages}
                            onClick={() => setPage(currentPage + 1)}
                          >
                            Next
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </section>
          </>
        )}
        {!status && !busy && !error && <p className="muted">Refresh to read server status.</p>}
      </div>
    </dialog>
  );
}
