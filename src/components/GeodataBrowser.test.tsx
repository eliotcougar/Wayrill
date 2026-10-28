// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import GeoBrowseButton from './GeoBrowseButton';
import GeoMatcherField from './GeoMatcherField';
import GeodataBrowser from './GeodataBrowser';
import { GeoResourcesContext } from '../geodata';
import { factoryResources } from '../graph/resources';
import { serviceCall } from '../serviceClient';
vi.mock('../serviceClient', () => ({ errorText: (e: Error) => e.message, serviceCall: vi.fn() }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(serviceCall).mockImplementation(async (method, params = {}) => {
    if (method === 'resources.status')
      return { generation: 0, files: [{ file: 'geosite.dat', present: true }] } as never;
    if (!params.group)
      return { ready: true, total: 1, rows: [{ code: 'google', count: 2 }], group: null } as never;
    return {
      ready: true,
      total: (params.attributes as string[] | undefined)?.length ? 1 : 2,
      rows: [{ value: 'domain:google.com', preview: 'domain:google.com' }],
      group: { count: 2, attributes: ['ads', 'cn'], inverse: false },
    } as never;
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  )!;
it.each(['groups', 'entries'] as const)(
  'recovers the %s page when a resource update removes its results',
  async (scope) => {
    let generation = 0;
    vi.mocked(serviceCall).mockImplementation(async (method, params = {}) => {
      if (method === 'resources.status') return { generation, files: [] } as never;
      const paged = Boolean(params.group) === (scope === 'entries');
      const total = paged ? (generation === 0 ? 201 : generation === 1 ? 101 : 0) : 1;
      const offset = Number(params.offset);
      return {
        ready: true,
        total,
        rows: Array.from({ length: Math.min(100, Math.max(0, total - offset)) }, (_, i) =>
          params.group
            ? { value: `full:entry${offset + i}.test`, preview: `full:entry${offset + i}.test` }
            : { code: `group${offset + i}`, count: 1 },
        ),
        group: params.group ? { count: total, attributes: [], inverse: false } : null,
      } as never;
    });
    await act(async () =>
      root.render(
        <GeodataBrowser
          kind="geosite"
          resources={factoryResources()}
          initialExpression={scope === 'entries' ? 'geosite:google' : ''}
          onInsert={() => null}
          onClose={vi.fn()}
        />,
      ),
    );
    const section = () =>
      host.querySelector(
        `[aria-label="${scope === 'groups' ? 'Resource groups' : 'Expression preview'}"]`,
      )!;
    const next = () => section().querySelector<HTMLButtonElement>('[aria-label="Next page"]')!;
    const previous = () =>
      section().querySelector<HTMLButtonElement>('[aria-label="Previous page"]')!;
    await wait();
    for (let i = 0; i < 2; i++) {
      await act(async () => next().click());
      await wait();
    }
    expect(section().textContent).toContain('201–201 / 201');
    generation = 1;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await wait();
    await wait();
    expect(section().textContent).toContain('101–101 / 101');
    expect(section().querySelectorAll('tbody tr')).toHaveLength(1);
    expect(next().disabled).toBe(true);
    expect(previous().disabled).toBe(false);
    generation = 2;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    await wait();
    await wait();
    expect(section().textContent).toContain('0 results');
    expect(previous().disabled).toBe(true);
    expect(next().disabled).toBe(true);
  },
);
async function wait() {
  await act(async () => vi.advanceTimersByTimeAsync(150));
}
it('selects a group from its count cell and keeps cursor insertion independent of modal focus', async () => {
  const change = vi.fn();
  const input = document.createElement('textarea');
  input.value = 'first\nlast';
  host.append(input);
  input.setSelectionRange(2, 2);
  await act(async () =>
    root.render(
      <GeoBrowseButton
        kind="geosite"
        label="Domains"
        resources={factoryResources()}
        target={{ current: input }}
        value={input.value}
        onChange={change}
      />,
    ),
  );
  await act(async () => button('Browse GeoSite for Domains').click());
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Search groups"]'));
  await wait();
  await act(async () => button('google').closest('tr')!.cells[1].click());
  await wait();
  expect(host.querySelector<HTMLInputElement>('[aria-label="GeoSite expression"]')?.value).toBe(
    'geosite:google',
  );
  await act(async () => button('Insert expression').click());
  expect(change).toHaveBeenCalledWith('first\ngeosite:google\nlast');
  expect(host.querySelector('dialog')).toBeNull();
});
it('inserts an attribute selector and keeps DNS expanded edits transactional', async () => {
  const change = vi.fn();
  await act(async () =>
    root.render(
      <GeoResourcesContext.Provider value={factoryResources()}>
        <GeoMatcherField
          kind="geosite"
          label="Preferred domains"
          value="domain:before"
          onChange={change}
        />
      </GeoResourcesContext.Provider>,
    ),
  );
  await act(async () => button('Expand Preferred domains').click());
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        'dialog.geo-expanded [aria-label="Browse GeoSite for Preferred domains"]',
      )!
      .click(),
  );
  await wait();
  await act(async () => button('google').click());
  await wait();
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="Attribute @cn"]')!.click(),
  );
  await wait();
  await act(async () => button('Insert expression').click());
  expect(
    host.querySelector<HTMLTextAreaElement>('[aria-label="Expanded Preferred domains"]')?.value,
  ).toBe('domain:before\ngeosite:google@cn\n');
  expect(change).not.toHaveBeenCalled();
  await act(async () => button('Cancel').click());
  expect(change).not.toHaveBeenCalled();
});
it('reports limits without closing or mutating the field', async () => {
  const change = vi.fn();
  await act(async () =>
    root.render(
      <GeoBrowseButton
        kind="geosite"
        label="Domains"
        resources={factoryResources()}
        target={{ current: null }}
        value="already full"
        onChange={change}
        maxLength={12}
      />,
    ),
  );
  await act(async () => button('Browse GeoSite for Domains').click());
  await wait();
  await act(async () => button('google').click());
  await wait();
  await act(async () => button('Insert expression').click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('12 characters');
  expect(change).not.toHaveBeenCalled();
});
it('preselects the active external resource, group and AND attributes and inserts them together', async () => {
  const change = vi.fn();
  const input = document.createElement('textarea');
  input.value = 'first\next-domain:Office.dat:google@cn@ads\nlast';
  input.setSelectionRange(20, 20);
  const resources = factoryResources();
  resources.files.push({
    id: 'office',
    name: 'Office.dat',
    kind: 'geosite',
    url: '',
    enabled: false,
    autoUpdate: false,
    intervalHours: 24,
    throughWayrill: false,
  });
  await act(async () =>
    root.render(
      <GeoBrowseButton
        kind="geosite"
        label="Domains"
        resources={resources}
        target={{ current: input }}
        value={input.value}
        onChange={change}
      />,
    ),
  );
  await act(async () => button('Browse GeoSite for Domains').click());
  await wait();
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Resource file"]')?.value).toBe(
    'Office.dat',
  );
  expect(host.querySelector<HTMLInputElement>('[aria-label="Attribute @cn"]')?.checked).toBe(true);
  expect(host.querySelector<HTMLInputElement>('[aria-label="Attribute @ads"]')?.checked).toBe(true);
  expect(serviceCall).toHaveBeenCalledWith(
    'resources.browse',
    expect.objectContaining({
      file: 'Office.dat',
      group: 'google',
      attributes: ['cn', 'ads'],
    }),
  );
  await act(async () =>
    host.querySelector<HTMLInputElement>('[aria-label="Attribute @cn"]')!.click(),
  );
  await wait();
  expect(host.querySelector<HTMLInputElement>('[aria-label="GeoSite expression"]')?.value).toBe(
    'ext-domain:Office.dat:google@ads',
  );
  await act(async () => button('Insert expression').click());
  expect(change).toHaveBeenCalledWith(
    'first\next-domain:Office.dat:google@cn@ads\next-domain:Office.dat:google@ads\nlast',
  );
});
it('does not propagate the browser Escape/cancel to its parent editor', async () => {
  const parent = vi.fn(),
    change = vi.fn();
  await act(async () =>
    root.render(
      <dialog open onCancel={parent}>
        <GeoBrowseButton
          kind="geoip"
          label="IPs"
          resources={factoryResources()}
          target={{ current: null }}
          value=""
          onChange={change}
        />
      </dialog>,
    ),
  );
  await act(async () => button('Browse GeoIP for IPs').click());
  await act(async () =>
    host
      .querySelector('dialog.geo-browser')!
      .dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true })),
  );
  expect(parent).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  expect(host.querySelector('dialog.geo-browser')).toBeNull();
});
