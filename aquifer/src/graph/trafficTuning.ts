import {
  tuningProblems as problems,
  tunedFinalMask as finalMask,
} from '@wayrill/core/trafficTuning';
import { LIMITS } from '../limits';
import type { RuleNodeData } from './types';

export * from '@wayrill/core/trafficTuning';
export const tuningProblems = (data: RuleNodeData) => problems(data, LIMITS.configBytes);
export const tunedFinalMask = (data: RuleNodeData) => finalMask(data, LIMITS.configBytes);

// Windows UDP sockets otherwise inherit the OS's small datagram buffers.
// Scope the options to UDP; TCP keeps its existing socket/autotuning behavior.
export const windowsUdpSocketOptions = [4098, 4097].map((opt) => ({
  system: 'windows',
  network: 'udp',
  level: '65535',
  opt: String(opt),
  value: String(256 * 1024),
  type: 'int',
}));
