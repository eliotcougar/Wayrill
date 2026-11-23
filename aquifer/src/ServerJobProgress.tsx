import type { ReactNode } from 'react';
import JobOutput from './JobOutput';
import type { useServerJob } from './useServerJob';

type Operation = ReturnType<typeof useServerJob>;
const phaseLabels: Partial<Record<Operation['phase'], string>> = {
  checking: 'Checking whether the server accepted the action…',
  paused: 'Monitoring paused',
  rejected: 'Action rejected',
};

export default function ServerJobProgress({
  operation,
  progressLabel,
  children,
  dismissDisabled = false,
}: {
  operation: Operation;
  progressLabel: string;
  children?: ReactNode;
  dismissDisabled?: boolean;
}) {
  const { phase, job, error } = operation;
  const monitoring = phase === 'checking' || phase === 'observing';
  const title =
    phase === 'submitting'
      ? operation.request?.action === 'applyConfig'
        ? 'Submitting configuration…'
        : 'Submitting server action…'
      : (phaseLabels[phase] ?? job?.stage ?? 'Connecting to server job…');
  return (
    <>
      <div className="server-job-title">
        <strong>{title}</strong>
        {job?.percent != null && <span>{job.percent}%</span>}
      </div>
      {(monitoring || phase === 'submitting') && (
        <progress
          aria-label={progressLabel}
          max={100}
          value={error ? undefined : (job?.percent ?? undefined)}
        />
      )}
      {job?.message && (
        <p
          className={
            job.state === 'failed' || job.state === 'interrupted' ? 'status-error' : 'muted'
          }
        >
          {job.message}
        </p>
      )}
      {error && (
        <p className="status-warning" role="alert">
          {error} {monitoring ? 'Reconnecting to check progress…' : ''}
        </p>
      )}
      {(phase === 'rejected' || phase === 'paused' || phase === 'completed') && (
        <div className="server-actions">
          {operation.retry && (
            <button className="secondary-button" onClick={() => void operation.retryRequest()}>
              Retry same request
            </button>
          )}
          {phase === 'paused' && (
            <button className="secondary-button" onClick={operation.checkProgress}>
              Check progress
            </button>
          )}
          <button
            className="secondary-button"
            onClick={operation.dismiss}
            disabled={dismissDisabled}
          >
            {phase === 'paused'
              ? 'Stop monitoring'
              : phase === 'completed'
                ? 'Dismiss result'
                : 'Dismiss'}
          </button>
        </div>
      )}
      {children}
      {operation.active && (
        <p className="muted">Closing this window does not cancel a server job.</p>
      )}
      {!!job?.logs.length && <JobOutput key={job.id} logs={job.logs} />}
    </>
  );
}
