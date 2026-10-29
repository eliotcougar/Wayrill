import { createContext, useCallback, useEffect, useState } from 'react';
import { desktopServiceAvailable, errorText, serviceCall } from './serviceClient';
import { outboundBundle } from './graph/outbounds';
import type { RuleNodeData } from './graph/types';

export type OutboundInterfaces = {
  automatic: string | null;
  captured: boolean;
  loopback?: string | null;
  adapters: { name: string; active: boolean }[];
  error: string | null;
};
const unavailable: OutboundInterfaces = {
  automatic: null,
  captured: false,
  loopback: null,
  adapters: [],
  error: null,
};
export const OutboundInterfacesContext = createContext(unavailable);

export function directInterfaceValue(data: RuleNodeData): string {
  try {
    const primary = outboundBundle(data)[0];
    const stream = primary.streamSettings as { sockopt?: { interface?: unknown } } | undefined;
    const value = stream?.sockopt?.interface;
    return typeof value === 'string' ? value : '';
  } catch {
    // Unfinished node drafts remain editable.
    return String(data.settings.interface ?? '');
  }
}

export function automaticDirectInterface(
  data: RuleNodeData,
  interfaces: OutboundInterfaces,
): string {
  const inherited = { ...data, settings: { ...data.settings, interface: '' } };
  const extra = directInterfaceValue(inherited);
  if (extra) return extra;
  const redirect = String(data.settings.redirect ?? '');
  let local = /^(?:localhost|127(?:\.\d{1,3}){3}):\d+$/i.test(redirect);
  if (redirect.startsWith('[')) {
    try {
      local = new URL(`http://${redirect}`).hostname === '[::1]';
    } catch {
      /* Invalid draft. */
    }
  }
  if (local) return interfaces.loopback || 'Loopback';
  return interfaces.automatic || 'Unavailable';
}

// One shared inventory for every card/editor, with no overlapping native calls.
export function useOutboundInterfaces(): OutboundInterfaces {
  const [state, setState] = useState(unavailable);
  const read = useCallback(async () => {
    const result = await serviceCall<OutboundInterfaces>('outbounds.interfaces');
    result.adapters.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }, []);
  useEffect(() => {
    if (!desktopServiceAvailable()) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const update = async () => {
      let next: OutboundInterfaces;
      try {
        next = await read();
      } catch (error) {
        next = { ...unavailable, error: errorText(error) };
      }
      if (!current) return;
      setState((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
      timer = setTimeout(() => void update(), 5000);
    };
    void update();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [read]);
  return state;
}
