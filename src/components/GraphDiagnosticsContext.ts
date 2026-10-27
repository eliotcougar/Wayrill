import { createContext } from 'react';
import type { Diagnostic } from '../graph/types';
export const GraphDiagnosticsContext = createContext<Record<string, Diagnostic[]>>({});
