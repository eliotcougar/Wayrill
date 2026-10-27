import { BookOpen } from 'lucide-react';
import { useState, type RefObject } from 'react';
import type { ResourceKind, ResourceSet } from '../graph/resources';
import { geoExpressionAtCursor, insertAfterCursorLine } from '../geodata';
import GeodataBrowser from './GeodataBrowser';

export default function GeoBrowseButton({
  kind,
  label,
  resources,
  target,
  value,
  onChange,
  maxLength = 16384,
}: {
  kind: ResourceKind;
  label: string;
  resources: ResourceSet;
  target: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  const [position, setPosition] = useState<{
    value: string;
    cursor: number;
    scrollTop: number;
    scrollLeft: number;
  } | null>(null);
  const name = kind === 'geosite' ? 'GeoSite' : 'GeoIP';
  return (
    <>
      <button
        type="button"
        className="icon-button"
        title={`Browse ${name}`}
        aria-label={`Browse ${name} for ${label}`}
        onClick={() =>
          setPosition({
            value: target.current?.value ?? value,
            cursor: target.current?.selectionEnd ?? value.length,
            scrollTop: target.current?.scrollTop ?? 0,
            scrollLeft: target.current?.scrollLeft ?? 0,
          })
        }
      >
        <BookOpen size={14} />
      </button>
      {position && (
        <GeodataBrowser
          kind={kind}
          resources={resources}
          initialExpression={geoExpressionAtCursor(position.value, position.cursor, kind)}
          onClose={() => setPosition(null)}
          onInsert={(entry) => {
            const next = insertAfterCursorLine(position.value, position.cursor, entry);
            if (next.value.length > maxLength)
              return `This field is limited to ${maxLength.toLocaleString()} characters.`;
            onChange(next.value);
            setPosition(null);
            requestAnimationFrame(() => {
              const input = target.current;
              if (!input) return;
              input.focus();
              input.setSelectionRange(next.cursor, next.cursor);
              input.scrollTop = position.scrollTop;
              input.scrollLeft = position.scrollLeft;
            });
            return null;
          }}
        />
      )}
    </>
  );
}
