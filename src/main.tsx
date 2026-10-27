import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App';
import { initializeDiagnostics } from './diagnostics';
import './accessibility.css';
import { initializeTheme } from './theme';
import { appWindowTitle } from './version';

document.title = appWindowTitle;
initializeTheme();
initializeDiagnostics();
const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <ReactFlowProvider>
      <App />
    </ReactFlowProvider>
  </StrictMode>,
);
