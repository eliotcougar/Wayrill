import { useEffect, useState } from 'react';
import { appVersion } from '../version';
import { checkForUpdates, openReleasePage, type ReleaseUpdates } from '../releaseUpdates';
import Dialog from './Dialog';

type Result = { updates: ReleaseUpdates } | { error: string } | null;

export default function UpdateDialog({ onClose }: { onClose: () => void }) {
  const [request, setRequest] = useState(0);
  const [result, setResult] = useState<Result>(null);
  const [linkError, setLinkError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    void checkForUpdates(appVersion, controller.signal)
      .then((updates) => {
        if (active) setResult({ updates });
      })
      .catch(() => {
        if (active)
          setResult({
            error: controller.signal.aborted
              ? 'The update check timed out.'
              : 'Could not check GitHub for updates.',
          });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [request]);

  function openPage(tag?: string) {
    setLinkError(false);
    void openReleasePage(tag).catch(() => setLinkError(true));
  }

  return (
    <Dialog
      title="Check for updates"
      onClose={onClose}
      footer={
        <>
          <button className="secondary-button" onClick={() => openPage()}>
            All releases on GitHub
          </button>
          <button
            className="secondary-button"
            disabled={!result}
            onClick={() => {
              setLinkError(false);
              setResult(null);
              setRequest((value) => value + 1);
            }}
          >
            {result && 'error' in result ? 'Retry' : 'Check again'}
          </button>
          <button className="primary-button" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <p>Installed version {appVersion}</p>
      <div role="status" aria-live="polite">
        {!result && <p className="dialog-note">Checking GitHub for updates…</p>}
        {result && 'error' in result && <p className="notice notice--error">{result.error}</p>}
        {result && 'updates' in result && (
          <div className="item-list">
            {(['stable', 'prerelease'] as const).map((channel) => {
              const release = result.updates[channel];
              const label = channel === 'stable' ? 'Stable release' : 'Prerelease';
              return (
                <div className="item-row" key={channel}>
                  <div className="item-content">
                    <strong>{label}</strong>
                    <small>
                      {release
                        ? `${release.version} · ${release.comparison > 0 ? 'Update available' : release.comparison < 0 ? 'Older than installed' : 'Installed version'}`
                        : 'None published'}
                    </small>
                  </div>
                  {release && (
                    <button
                      className="secondary-button"
                      aria-label={`View ${label.toLowerCase()} ${release.version} on GitHub`}
                      onClick={() => openPage(release.tag)}
                    >
                      View on GitHub
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {linkError && (
        <p className="notice notice--error" role="alert">
          Could not open the GitHub page.
        </p>
      )}
    </Dialog>
  );
}
