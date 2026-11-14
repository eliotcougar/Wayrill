import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import Dialog from '../components/Dialog';
import { jsonRecord, parseJson } from '../graph/xrayJson';
import { layerNames } from './layers';

type Entry = { id: string; name: string; kind: string };
export default function PoolInbox({
  ids,
  busy,
  onClose,
  onReview,
}: {
  ids: readonly string[];
  busy: boolean;
  onClose: () => void;
  onReview: (id: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    let active = true;
    void (async () => {
      for (const id of ids) {
        let entry = { id, name: 'Unreadable export', kind: '' };
        try {
          const data = parseJson(await invoke<string>('pool_import', { id }));
          if (
            jsonRecord(data) &&
            typeof data.name === 'string' &&
            typeof data.kind === 'string' &&
            Object.hasOwn(layerNames, data.kind)
          ) {
            entry = {
              id,
              name: data.name.slice(0, 128),
              kind: layerNames[data.kind as keyof typeof layerNames],
            };
          }
        } catch {
          // Keep invalid entries visible so the manager can discard them.
        }
        if (!active) return;
        setEntries((current) => [...current.filter((item) => item.id !== id), entry]);
      }
    })();
    return () => {
      active = false;
    };
  }, [ids]);
  return (
    <Dialog title="Incoming Wayrill exports" busy={busy} onClose={onClose}>
      <p>Review an export to add it to this Pool or replace a saved layer.</p>
      <div className="item-list">
        {ids.map((id) => {
          const entry = entries.find((item) => item.id === id);
          return (
            <div className="item-row" key={id}>
              <div className="item-content">
                <strong>{entry?.name ?? 'Reading export…'}</strong>
                <small>{entry?.kind}</small>
              </div>
              <button
                className="secondary-button"
                disabled={busy || !entry}
                onClick={() => onReview(id)}
              >
                Review
              </button>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
