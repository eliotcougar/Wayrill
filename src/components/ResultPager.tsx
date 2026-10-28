import { useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowRight } from 'lucide-react';

export default function ResultPager({
  count,
  size,
  page,
  label,
  disabled = false,
  compact = false,
  onPage,
}: {
  count: number;
  size: number;
  page: number;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(count / size)),
    current = Math.min(page, pages - 1);
  const [jump, setJump] = useState('');
  const number = Number(jump),
    valid = /^\d+$/.test(jump) && number >= 1 && number <= pages;
  if (pages === 1)
    return (
      <p className="result-pager" role="status" aria-label={`${label} results`}>
        {count.toLocaleString()} {count === 1 ? 'result' : 'results'}
      </p>
    );
  return (
    <nav
      className={`result-pager${compact ? ' result-pager-compact' : ''}`}
      aria-label={`${label} pages`}
    >
      <span role="status" title={`Page ${current + 1} of ${pages.toLocaleString()}`}>
        {count
          ? `${(current * size + 1).toLocaleString()}–${Math.min((current + 1) * size, count).toLocaleString()}`
          : '0'}{' '}
        of {count.toLocaleString()}
        {!compact && ` · Page ${current + 1} of ${pages.toLocaleString()}`}
      </span>
      <div>
        <button
          className="secondary-button"
          aria-label={`${label}: first page`}
          disabled={disabled || !current}
          onClick={() => onPage(0)}
        >
          {compact ? <ChevronsLeft size={14} aria-hidden="true" /> : 'First'}
        </button>
        <button
          className="secondary-button"
          aria-label={`${label}: previous page`}
          disabled={disabled || !current}
          onClick={() => onPage(current - 1)}
        >
          {compact ? <ChevronLeft size={14} aria-hidden="true" /> : 'Previous'}
        </button>
        <button
          className="secondary-button"
          aria-label={`${label}: next page`}
          disabled={disabled || current + 1 >= pages}
          onClick={() => onPage(current + 1)}
        >
          {compact ? <ChevronRight size={14} aria-hidden="true" /> : 'Next'}
        </button>
        <button
          className="secondary-button"
          aria-label={`${label}: last page`}
          disabled={disabled || current + 1 >= pages}
          onClick={() => onPage(pages - 1)}
        >
          {compact ? <ChevronsRight size={14} aria-hidden="true" /> : 'Last'}
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !disabled) {
            onPage(number - 1);
            setJump('');
          }
        }}
      >
        <label>
          <span className={compact ? 'sr-only' : undefined}>Go to page</span>{' '}
          <input
            aria-label={`${label}: go to page`}
            type="number"
            min={1}
            max={pages}
            step={1}
            value={jump}
            disabled={disabled}
            onChange={(e) => setJump(e.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          disabled={disabled || !valid}
          aria-label={`${label}: go to entered page`}
        >
          {compact ? <ArrowRight size={14} aria-hidden="true" /> : 'Go'}
        </button>
      </form>
    </nav>
  );
}
