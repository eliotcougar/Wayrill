// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  OutboundInterfacesContext,
  directInterfaceName,
  directInterfaceValue,
  automaticDirectInterface,
  type OutboundInterfaces,
} from '../outboundInterfaces';
import { makeNode } from '../graph/catalog';
import { SettingField } from './SettingField';
import NativeObjectFields from './NativeObjectFields';

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
function DirectField() {
  const [value, setValue] = useState('');
  return (
    <>
      <SettingField
        field={{ key: 'interface', label: 'Network interface', type: 'text' }}
        value={value}
        issues={[]}
        onChange={(v) => setValue(String(v))}
        directInterface
      />
      <output>{directInterfaceName(value, inventory)}</output>
    </>
  );
}
it('selects adapters and restores automatic Direct without typing an alias', async () => {
  await act(() =>
    root.render(
      <OutboundInterfacesContext.Provider value={inventory}>
        <DirectField />
      </OutboundInterfacesContext.Provider>,
    ),
  );
  const select = container.querySelector('select')!;
  expect(select.options[0].text).toBe('Automatic (Wi-Fi Дом)');
  expect(Array.from(select.options).map((o) => o.text)).toEqual([
    'Automatic (Wi-Fi Дом)',
    'Wi-Fi Дом',
    'OpenVPN (inactive)',
  ]);
  expect(container.querySelector('input')).toBeNull();
  await act(() => {
    select.value = 'OpenVPN';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector('output')!.textContent).toBe('OpenVPN');
  await act(() => {
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelector('output')!.textContent).toBe('Wi-Fi Дом');
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
it('uses the same dropdown in native socket editors and labels capture egress', async () => {
  await act(() =>
    root.render(
      <OutboundInterfacesContext.Provider value={{ ...inventory, captured: true }}>
        <NativeObjectFields
          fields={[{ key: 'interface', label: 'Network interface', type: 'text' }]}
          object={{ interface: 'OpenVPN' }}
          idPrefix="native"
          onChange={() => {}}
          onValidity={() => {}}
          plain
        />
      </OutboundInterfacesContext.Provider>,
    ),
  );
  const select = container.querySelector('select')!;
  expect(select.value).toBe('OpenVPN');
  expect(select.options[0].text).toBe('Automatic (Wi-Fi Дом)');
});
it('shows the compiled binding including native socket extras, and tolerates unfinished drafts', () => {
  const data = makeNode('direct-outbound', { x: 0, y: 0 }).data;
  data.settings.sockoptExtra = JSON.stringify({ interface: 'Ethernet 2' });
  expect(directInterfaceName(directInterfaceValue(data), inventory)).toBe('Ethernet 2');
  data.settings.interface = 'OpenVPN';
  expect(directInterfaceName(directInterfaceValue(data), inventory)).toBe('OpenVPN');
  data.settings.sockoptExtra = '{';
  expect(directInterfaceValue(data)).toBe('OpenVPN');
});

it('shows the local binding for a fixed loopback redirect and keeps inherited socket interfaces visible', () => {
  const data = makeNode('direct-outbound', { x: 0, y: 0 }).data;
  data.settings.redirect = '127.0.0.1:53';
  expect(
    automaticDirectInterface(data, { ...inventory, loopback: 'Loopback Pseudo-Interface 1' }),
  ).toBe('Loopback Pseudo-Interface 1');
  data.settings.redirect = '[::1]:53';
  expect(
    automaticDirectInterface(data, { ...inventory, loopback: 'Loopback Pseudo-Interface 1' }),
  ).toBe('Loopback Pseudo-Interface 1');
  data.settings.redirect = '[0:0:0:0:0:0:0:1]:53';
  expect(
    automaticDirectInterface(data, { ...inventory, loopback: 'Loopback Pseudo-Interface 1' }),
  ).toBe('Loopback Pseudo-Interface 1');
  data.settings.redirect = '';
  data.settings.interface = 'OpenVPN';
  expect(automaticDirectInterface(data, inventory)).toBe('Wi-Fi Дом');
  data.settings.sockoptExtra = JSON.stringify({ interface: 'Inherited adapter' });
  expect(automaticDirectInterface(data, inventory)).toBe('Inherited adapter');
});
