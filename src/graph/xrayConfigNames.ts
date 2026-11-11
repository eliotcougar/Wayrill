import source from './xrayConfigNames.json';
import { createXrayNameTools } from '@wayrill/core/xrayConfigNames';
import { LIMITS } from '../limits';

export type { XrayNameCorrection } from '@wayrill/core/xrayConfigNames';
export const { inspectXrayCapitalization, fixXrayCapitalization } = createXrayNameTools(
  source,
  LIMITS.configBytes,
);
