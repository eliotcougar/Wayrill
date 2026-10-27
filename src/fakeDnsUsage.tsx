import { createContext, useContext } from 'react';
import { matchesCapture } from './runtimeState';
import { jsonRecord } from './graph/xrayJson';
import type { ServiceSnapshot } from './serviceClient';

type Summary = { text: string; title: string };
export const FakeDnsUsageContext = createContext<Summary>({
  text: '—',
  title: 'Mapping usage is available while routing is running.',
});

/** All FakeDNS cards represent the same allocator; never show an old runtime's
 * counts against newly edited pool geometry or a disconnected service. */
export function fakeDnsUsageSummary(
  connected: boolean,
  snapshot: ServiceSnapshot | null,
  draft: Record<string, unknown> | null | undefined,
  applied: Record<string, unknown> | null,
  revision: number,
): Summary {
  const unavailable = (title: string) => ({ text: '—', title });
  if (!connected || !snapshot) return unavailable('Service disconnected.');
  if (snapshot.core.state !== 'running') return unavailable('Routing is not running.');
  if (
    !draft ||
    !applied ||
    revision !== snapshot.config.revision ||
    !matchesCapture(draft.fakedns, applied.fakedns) ||
    (!draft.fakedns &&
      !matchesCapture(
        jsonRecord(draft.dns) ? draft.dns.queryStrategy : undefined,
        jsonRecord(applied.dns) ? applied.dns.queryStrategy : undefined,
      ))
  )
    return unavailable('Apply the pool changes to see mapping usage.');
  const usage = snapshot.fakeDns?.usage;
  if (!usage) return unavailable('Waiting for mapping usage.');
  return {
    text: `${usage.used.toLocaleString()} / ${usage.capacity.toLocaleString()}`,
    title: [
      'Used mappings / capacity · shared by all FakeDNS nodes',
      ...usage.pools.map(
        (p) => `${p.ipPool}: ${p.used.toLocaleString()} / ${p.capacity.toLocaleString()}`,
      ),
      'Each IPv4 or IPv6 mapping occupies one slot.',
    ].join('\n'),
  };
}

export function FakeDnsUsage() {
  const summary = useContext(FakeDnsUsageContext);
  return (
    <div className="node-detail">
      <span>Mappings</span>
      <strong title={summary.title}>{summary.text}</strong>
    </div>
  );
}
