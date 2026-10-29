// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { OutboundInterfacesContext, type OutboundInterfaces } from '../outboundInterfaces';
import { SettingField } from './SettingField';

let root: Root, container: HTMLDivElement;
const inventory: OutboundInterfaces = {
  automatic: 'Wi-Fi Дом',
  captured: false,
  error: null,
  adapters: [
    { name: 'Wi-Fi Дом', active: true },
    { name: 'OpenVPN', active: false },
  ],
};
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
it('retains a saved missing adapter instead of silently switching to automatic', async () => {
  await act(() =>
    root.render(
      <OutboundInterfacesContext.Provider value={inventory}>
        <SettingField
          field={{ key: 'interface', label: 'Network interface', type: 'text' }}
          value="Old Ethernet"
          issues={[]}
          onChange={() => {}}
          directInterface
        />
      </OutboundInterfacesContext.Provider>,
    ),
  );
  const select = container.querySelector('select')!;
  expect(select.value).toBe('Old Ethernet');
  expect(select.selectedOptions[0].text).toBe('Old Ethernet (unavailable)');
});
