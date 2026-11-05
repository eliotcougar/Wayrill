import { Plus, Trash2 } from 'lucide-react';
import { jsonRecord, jsonText } from './graph/xrayJson';
import ListInput from './ListInput';

export default function MapInput({
  value,
  lists,
  label,
  onChange,
}: {
  value: unknown;
  lists: boolean;
  label: string;
  onChange: (value: unknown) => void;
}) {
  const object = jsonRecord(value) ? value : {};
  const changeEntry = (key: string, next: unknown) =>
    onChange(
      Object.fromEntries(
        Object.entries({ ...object, [key]: next }).filter(([, value]) => value !== undefined),
      ),
    );
  return (
    <div className="server-map">
      {Object.entries(object).map(([key, entry], index) => (
        <div className="server-map-row" key={index}>
          <input
            aria-label={`${label} name ${index + 1}`}
            placeholder="Name"
            value={key}
            spellCheck={false}
            onChange={(event) => {
              const name = event.target.value;
              if (Object.hasOwn(object, name) && name !== key) return;
              onChange(
                Object.fromEntries(
                  Object.entries(object).map(([old, item]) => [old === key ? name : old, item]),
                ),
              );
            }}
          />
          {lists ? (
            <ListInput
              aria-label={`${label} value ${index + 1}`}
              value={entry}
              onChange={(next) => changeEntry(key, next)}
            />
          ) : (
            <input
              aria-label={`${label} value ${index + 1}`}
              placeholder="Value"
              value={jsonText(entry ?? '')}
              onChange={(event) => changeEntry(key, event.target.value)}
            />
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${label} entry ${index + 1}`}
            onClick={() =>
              onChange(Object.fromEntries(Object.entries(object).filter(([name]) => name !== key)))
            }
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={Object.hasOwn(object, '')}
        onClick={() => onChange({ ...object, '': lists ? [] : '' })}
      >
        <Plus size={15} /> Add entry
      </button>
    </div>
  );
}
