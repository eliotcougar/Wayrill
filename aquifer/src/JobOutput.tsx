import { useLayoutEffect, useRef } from 'react';

export default function JobOutput({ logs }: { logs: string[] }) {
  const output = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const text = logs.join('\n');
  useLayoutEffect(() => {
    if (following.current && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [text]);
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open && output.current) {
          following.current = true;
          output.current.scrollTop = output.current.scrollHeight;
        }
      }}
    >
      <summary>Job output</summary>
      <pre
        className="code-block"
        ref={output}
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.clientHeight - element.scrollTop < 24;
        }}
      >
        {text}
      </pre>
    </details>
  );
}
