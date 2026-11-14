import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { initializeTheme } from '../theme';
import PoolWorkspace from './PoolWorkspace';
import './workspace.css';

document.documentElement.dataset.app = 'pool';
initializeTheme();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PoolWorkspace />
  </StrictMode>,
);
