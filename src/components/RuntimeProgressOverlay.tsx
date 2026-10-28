import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { runtimeProgress } from '../runtimeProgress';

export default function RuntimeProgressOverlay({
  progress,
  children,
}: {
  progress: ReturnType<typeof runtimeProgress>;
  children: ReactNode;
}) {
  const status = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const blocked = !!progress;
  useLayoutEffect(() => {
    if (!blocked) return;
    const previous = document.activeElement;
    const restore = previous instanceof HTMLElement && content.current?.contains(previous);
    const indicator = status.current;
    if (restore) indicator?.focus({ preventScroll: true });
    return () => {
      if (
        restore &&
        previous.isConnected &&
        (document.activeElement === indicator || document.activeElement === document.body)
      )
        previous.focus({ preventScroll: true });
    };
  }, [blocked]);
  return (
    <div className="workspace-area">
      <div className="workspace-body" ref={content} inert={blocked} aria-busy={blocked}>
        {children}
      </div>
      {progress && (
        <div className="runtime-progress-overlay">
          <div
            className="runtime-progress-card"
            ref={status}
            tabIndex={-1}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <strong>{progress.title}</strong>
            <span>
              {progress.stage}
              {'elapsedSeconds' in progress && typeof progress.elapsedSeconds === 'number' && (
                <span aria-hidden="true"> · {progress.elapsedSeconds} s</span>
              )}
            </span>
            <progress max={100} value={progress.percent ?? undefined} aria-label={progress.stage} />
          </div>
        </div>
      )}
    </div>
  );
}
