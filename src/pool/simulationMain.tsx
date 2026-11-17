import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '../styles.css';
import App from '../App';
import { errorText } from '../serviceClient';
import { initializeTheme } from '../theme';
import PoolConnection, { type PoolSource } from './PoolConnection';
import { evaluateSimulatedRoute, inspectInvitation, prepareSimulation } from './simulation';

function Simulation() {
  const [setup, setSetup] = useState<{ source: PoolSource; user: string }>();
  const [error, setError] = useState('');
  const [workspace, setWorkspace] = useState<Awaited<ReturnType<typeof prepareSimulation>>>();
  useEffect(() => {
    let active = true;
    void invoke<NonNullable<typeof setup>>('pool_simulation_invitation')
      .then((value) => {
        if (active) setSetup(value);
      })
      .catch((reason) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, []);
  if (!setup)
    return (
      <p className="workspace-loading" role={error ? 'alert' : 'status'}>
        {error || 'Opening Pool simulation…'}
      </p>
    );
  return workspace ? (
    <ReactFlowProvider>
      <App
        simulation={{
          ...workspace,
          route: evaluateSimulatedRoute,
          onReview: () => setWorkspace(undefined),
        }}
      />
    </ReactFlowProvider>
  ) : (
    <div className="app-shell">
      <PoolConnection
        simulation={{
          user: setup.user,
          source: setup.source,
          inspect: inspectInvitation,
          prepare: prepareSimulation,
          onPrepare: setWorkspace,
        }}
        onClose={() =>
          void getCurrentWindow()
            .close()
            .catch((reason) => setError(errorText(reason)))
        }
      />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

document.documentElement.dataset.app = 'pool';
initializeTheme();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Simulation />
  </StrictMode>,
);
