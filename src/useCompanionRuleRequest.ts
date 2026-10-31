import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { CompanionRuleRequest } from './companionRules';

export default function useCompanionRuleRequest(ready: boolean) {
  const [request, setRequest] = useState<CompanionRuleRequest | null>(null);
  const [error, setError] = useState('');
  const current = useRef<CompanionRuleRequest | null>(null);
  const dismissing = useRef(false);
  const enabled = useRef(ready);
  enabled.current = ready;
  const wake = useRef(() => {});
  useEffect(() => {
    if (!isTauri()) return;
    let active = true,
      busy = false,
      again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const read = async () => {
      again = true;
      if (!active || busy || !enabled.current || current.current) return;
      clearTimeout(timer);
      // Preserve any open editor and its unsaved draft. Only an incoming intent
      // waits here; an idle desktop does not poll the native command.
      if (document.querySelector('dialog[open]')) {
        timer = setTimeout(() => void read(), 500);
        return;
      }
      busy = true;
      again = false;
      try {
        // Peek until the dialog is dismissed: remounting the renderer must not
        // consume a request whose asynchronous response it can no longer show.
        const next = await invoke<CompanionRuleRequest | null>('companion_rule_request');
        if (active && next) {
          // A different editor or activation can begin while the native call waits.
          if (!enabled.current || document.querySelector('dialog[open]')) again = true;
          else {
            current.current = next;
            setRequest(next);
          }
        }
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        busy = false;
        if (active && again) void read();
      }
    };
    wake.current = () => void read();
    void listen('wayrill-companion-request', () => void read())
      .then((remove) => {
        if (!active) {
          remove();
          return;
        }
        unsubscribe = remove;
        void read();
      })
      .catch((failure: unknown) => {
        if (active) setError(String(failure));
      });
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe?.();
      wake.current = () => {};
    };
  }, []);
  useEffect(() => {
    if (ready) wake.current();
  }, [ready]);
  const close = useCallback(() => {
    const completed = current.current;
    if (!completed || dismissing.current) return;
    dismissing.current = true;
    void invoke('companion_rule_request', { completed })
      .then(() => {
        dismissing.current = false;
        current.current = null;
        setRequest(null);
        wake.current();
      })
      .catch((failure: unknown) => {
        dismissing.current = false;
        setError(String(failure));
      });
  }, []);
  return { request, close, error };
}
