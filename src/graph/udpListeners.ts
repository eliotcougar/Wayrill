import type { GlobalDefaults } from './types';

// These variables configure Wayrill's public listener-controller callback.
// Zero/omission leaves the corresponding Windows socket default unchanged.
export const udpListenerFields = {
  udpListenerReceiveKiB: 'WAYRILL_UDP_LISTENER_RECEIVE_BYTES',
  udpListenerSendKiB: 'WAYRILL_UDP_LISTENER_SEND_BYTES',
} as const;

export function udpListenerEnvironment(defaults?: GlobalDefaults): Record<string, string> {
  return Object.fromEntries(
    Object.entries(udpListenerFields).flatMap(([key, variable]) => {
      const value = defaults?.settings[key];
      return value === undefined || value === '' ? [] : [[variable, String(Number(value) * 1024)]];
    }),
  );
}
