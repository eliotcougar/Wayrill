import { createContext } from 'react';
export const NodeEditorContext = createContext<(id: string, tab?: 'log' | 'export') => void>(
  () => {},
);
