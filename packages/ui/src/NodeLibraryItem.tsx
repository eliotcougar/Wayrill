import type { ButtonHTMLAttributes } from 'react';
import { GripVertical } from 'lucide-react';
import NodeIcon from './NodeIcon';

export default function NodeLibraryItem({
  kind,
  label,
  category,
  ...button
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> & {
  kind: string;
  label: string;
  category: string;
}) {
  return (
    <button type="button" {...button} className={`palette-item category-${category}`}>
      <span className="palette-icon">
        <NodeIcon kind={kind} size={17} />
      </span>
      <span className="palette-item-copy">
        <strong>{label}</strong>
      </span>
      <GripVertical className="palette-grip" size={14} aria-hidden="true" />
    </button>
  );
}
