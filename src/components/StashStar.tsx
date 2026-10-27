import { Star } from 'lucide-react';
import type { StashEntry } from '../profiles/import';

export default function StashStar({
  entry,
  disabled,
  onToggle,
}: {
  entry: StashEntry;
  disabled: boolean;
  onToggle: () => void;
}) {
  const label = `${entry.starred ? 'Unstar' : 'Star'} ${entry.name}`;
  return (
    <button
      type="button"
      className="icon-button stash-star"
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={!!entry.starred}
      onClick={onToggle}
    >
      <Star size={15} aria-hidden="true" fill={entry.starred ? 'currentColor' : 'none'} />
    </button>
  );
}
