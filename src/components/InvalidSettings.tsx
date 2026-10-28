import type { NativeField } from '../graph/nativeFields';

/** Unfinished input stays local to its control, but remains discoverable when its group is closed. */
export default function InvalidSettings({
  invalid,
  fields = [],
  onReview,
}: {
  invalid: Record<string, boolean>;
  fields?: readonly Pick<NativeField, 'key' | 'label'>[];
  onReview: (id: string) => void;
}) {
  return Object.entries(invalid)
    .filter(([, bad]) => bad)
    .map(([id]) => {
      const key = id.split('-').at(-1) ?? 'setting';
      const label =
        fields.find((f) => f.key === key)?.label ??
        key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
      return (
        <button
          type="button"
          className="notice notice--error notice--compact diagnostic"
          key={id}
          onClick={() => onReview(id)}
        >
          Invalid value · {label} · Review
        </button>
      );
    });
}
