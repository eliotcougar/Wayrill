import { useEffect, useRef, type ReactNode } from 'react';

/** Native disclosure keeps controls mounted, including their unfinished drafts and validity. */
export default function AdvancedSettings({
  children,
  configured = [],
  title,
  reveal = false,
  hidden = false,
}: {
  children: ReactNode;
  configured?: readonly string[];
  title?: string;
  reveal?: boolean;
  hidden?: boolean;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (reveal && details.current) details.current.open = true;
  }, [reveal]);
  return (
    <details ref={details} className="editor-advanced settings-advanced" hidden={hidden}>
      <summary>
        <span>Advanced{title ? ` · ${title}` : ''}</span>
        {configured.length > 0 && (
          <small title={configured.join(', ')}>{configured.length} configured</small>
        )}
      </summary>
      {children}
    </details>
  );
}
