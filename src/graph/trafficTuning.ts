import {
  tuningProblems as problems,
  tunedFinalMask as finalMask,
} from '@wayrill/core/trafficTuning';
import { LIMITS } from '../limits';
import type { RuleNodeData } from './types';

export * from '@wayrill/core/trafficTuning';
export const tuningProblems = (data: RuleNodeData) => problems(data, LIMITS.configBytes);
export const tunedFinalMask = (data: RuleNodeData) => finalMask(data, LIMITS.configBytes);
