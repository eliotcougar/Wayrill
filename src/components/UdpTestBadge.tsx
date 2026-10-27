export default function UdpTestBadge({
  result,
}: {
  result?: { reachable: boolean; title: string };
}) {
  return result ? (
    <span
      className={`udp-test-badge ${result.reachable ? 'reachable' : 'unreachable'}`}
      aria-label={result.reachable ? 'UDP available' : 'UDP unavailable'}
      title={result.title}
    >
      UDP
    </span>
  ) : null;
}
