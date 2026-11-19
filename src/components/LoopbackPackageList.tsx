export default function LoopbackPackageList({
  rows,
  disabled,
  onChange,
}: {
  rows: { family: string; name: string; enabled: boolean }[];
  disabled?: boolean;
  onChange: (family: string, enabled: boolean) => void;
}) {
  return (
    <div
      className="choice-list capture-picker-list capture-system-list"
      role="region"
      aria-label="Windows app loopback permissions"
      tabIndex={0}
    >
      {rows.map(({ family, name, enabled }) => (
        <label key={family} className="check-control choice-row choice-row--compact">
          <input
            type="checkbox"
            disabled={disabled}
            checked={enabled}
            onChange={(event) => onChange(family, event.currentTarget.checked)}
          />
          <span className="item-content item-content--inline">
            {name !== family && <strong>{name}</strong>}
            <small title={family}>{family}</small>
          </span>
        </label>
      ))}
    </div>
  );
}
