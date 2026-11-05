import { useEffect, useRef, useState } from 'react';
import { jsonArray } from './graph/xrayJson';

export default function ListInput({
  value,
  numeric,
  trim = false,
  onChange,
  ...props
}: {
  value: unknown;
  numeric?: boolean;
  trim?: boolean;
  onChange: (value: unknown) => void;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const toText = (value: unknown) =>
    jsonArray(value) ? value.join('\n') : typeof value === 'string' ? value : '';
  const [text, setText] = useState(toText(value));
  const emitted = useRef(value);
  useEffect(() => {
    if (value !== emitted.current) setText(toText(value));
    emitted.current = value;
  }, [value]);
  return (
    <textarea
      {...props}
      className={['text-control', 'code-control', 'server-list-input', props.className]
        .filter(Boolean)
        .join(' ')}
      rows={3}
      value={text}
      onChange={(event) => {
        const text = event.target.value;
        setText(text);
        const values = text
          .split(numeric ? /[\s,]+/ : /\r?\n/)
          .map((line) => (trim ? line.trim() : line))
          .filter((line) => line.trim())
          .map((line) => (numeric && /^\d+$/.test(line) ? Number(line) : line));
        const next =
          text === ''
            ? undefined
            : !numeric && typeof value === 'string' && values.length === 1
              ? values[0]
              : values;
        emitted.current = next;
        onChange(next);
      }}
    />
  );
}
