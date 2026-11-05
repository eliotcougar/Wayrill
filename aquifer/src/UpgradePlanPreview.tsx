import { useState } from 'react';
import { Search } from 'lucide-react';
import type { PackageChange, UpgradePlan } from './remoteClient';

const PAGE_SIZE = 100;
function Changes({
  title,
  items,
  query,
}: {
  title: string;
  items: PackageChange[];
  query: string;
}) {
  const [page, setPage] = useState(0);
  const matching = items.filter((p) => `${p.name}:${p.architecture}`.includes(query));
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  return (
    <section
      className="upgrade-plan-group"
      aria-label={title}
      data-removals={title === 'Removals' && items.length > 0}
    >
      <h4>
        {title} <span>{items.length}</span>
      </h4>
      {matching.length ? (
        <>
          <table className="status-table upgrade-plan-table">
            <thead>
              <tr>
                <th>Package</th>
                <th>Installed</th>
                <th>Proposed</th>
              </tr>
            </thead>
            <tbody>
              {matching.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((p) => (
                <tr key={`${p.name}:${p.architecture}`}>
                  <td>
                    {p.name}
                    <small>{p.architecture}</small>
                  </td>
                  <td>{p.installedVersion ?? '—'}</td>
                  <td>{p.candidateVersion ?? 'Remove'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {pages > 1 && (
            <div className="status-pagination">
              <button
                disabled={!current}
                onClick={() => setPage(current - 1)}
                aria-label={`Previous ${title.toLowerCase()}`}
              >
                Previous
              </button>
              <span>
                {current + 1} / {pages}
              </span>
              <button
                disabled={current + 1 >= pages}
                onClick={() => setPage(current + 1)}
                aria-label={`Next ${title.toLowerCase()}`}
              >
                Next
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="muted">{items.length ? 'No matching packages.' : 'None.'}</p>
      )}
    </section>
  );
}

export default function UpgradePlanPreview({ plan }: { plan: UpgradePlan }) {
  const [query, setQuery] = useState('');
  return (
    <div className="upgrade-plan">
      <p className="muted">
        {plan.hostname} · Preview expires {new Date(plan.expiresAt * 1000).toLocaleTimeString()}
      </p>
      <div className="search-field">
        <Search size={15} />
        <input
          aria-label="Search proposed package changes"
          placeholder="Search package changes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <Changes title="Installations" items={plan.installs} query={query.trim().toLowerCase()} />
      <Changes title="Upgrades" items={plan.upgrades} query={query.trim().toLowerCase()} />
      <Changes title="Removals" items={plan.removals} query={query.trim().toLowerCase()} />
      {!!plan.heldBack && <p className="muted">{plan.heldBack} packages remain deferred.</p>}
    </div>
  );
}
