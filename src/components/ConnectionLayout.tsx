import { createContext, useContext, useMemo, type ReactNode } from 'react';
import useEdgeRouting from '../useEdgeRouting';
import { EdgeRoutesContext } from './SchematicEdge';

const LayoutStatusContext = createContext({ blocked: false, error: '', retry: () => {} });

export function ConnectionLayoutProvider({ children }: { children: ReactNode }) {
  const { paths, error, retry } = useEdgeRouting();
  const blocked = Array.from(paths.values()).some((route) => route.blocked);
  const status = useMemo(() => ({ blocked, error, retry }), [blocked, error, retry]);
  return (
    <LayoutStatusContext.Provider value={status}>
      <EdgeRoutesContext.Provider value={paths}>{children}</EdgeRoutesContext.Provider>
    </LayoutStatusContext.Provider>
  );
}

export function ConnectionLayoutStatus() {
  const { blocked, error, retry } = useContext(LayoutStatusContext);
  return (
    <>
      {error && (
        <button className="graph-status has-errors" onClick={retry} title={error}>
          Retry connection layout
        </button>
      )}
      {blocked && (
        <span
          className="graph-status has-errors"
          role="status"
          title="A connection cannot be routed clearly in this layout. Move overlapping nodes or increase the space between them."
        >
          Connections need more space
        </span>
      )}
    </>
  );
}
