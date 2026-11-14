import { useEffect, useRef } from 'react';
import OutboundTestResults from '../components/OutboundTestResults';
import type { GraphState } from '../graph/types';
import type { Stash } from '../profiles/import';
import useOutboundTests from '../useOutboundTests';

export default function PoolConnectionTests({
  graph,
  stash,
  onClose,
}: {
  graph: GraphState;
  stash: Stash;
  onClose: () => void;
}) {
  const tests = useOutboundTests(graph, stash);
  const start = tests.start;
  const started = useRef(false);
  useEffect(() => {
    // Let the hook finish mounting before opening a test job.
    const timer = window.setTimeout(() => {
      if (started.current) return;
      started.current = true;
      void start();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [start]);
  return tests.open ? <OutboundTestResults tests={{ ...tests, setOpen: onClose }} /> : null;
}
