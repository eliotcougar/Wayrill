// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RoutingLog, { type RoutingLogSnapshot } from './RoutingLog';
import { serviceCall } from '../serviceClient';
import { exportFile } from '../exportFile';
vi.mock('../exportFile', () => ({ exportFile: vi.fn().mockResolvedValue(true) }));
vi.mock('../serviceClient', () => ({
  desktopServiceAvailable: () => true,
  serviceCall: vi.fn(),
  errorText: (e: Error) => e.message,
}));
let host: HTMLDivElement, root: Root;
const snapshot = (count: number, instance = 'service1', revision = 1): RoutingLogSnapshot => ({
  instanceId: instance,
  generation: revision,
  revision,
  state: 'collecting',
  capacity: 1000,
  rows: Array.from({ length: Math.min(count, 1000) }, (_, i) => ({
    id: String(count - Math.min(count, 1000) + i + 1),
    timestampMs: 1791892800000 + i,
    revision,
    destination: `host${count - Math.min(count, 1000) + i + 1}.example:443`,
    outbound: '🇫🇮 Server',
    output: 'Web',
    outputId: 'out',
    rule: 'Browser family',
    ruleId: 'browser',
  })),
});
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(serviceCall).mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function render(maskAddress = '') {
  await act(async () => root.render(<RoutingLog filterId="filter" maskAddress={maskAddress} />));
}
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
}
async function click(name: string) {
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((b) => b.textContent === name || b.getAttribute('aria-label') === name)!
      .click(),
  );
}
it('collects while paused, freezes inspection and resumes newest buffer together', async () => {
  vi.mocked(serviceCall).mockResolvedValue(snapshot(2));
  await render();
  expect(host.textContent).toContain('host2.example');
  await click('Pause updates');
  vi.mocked(serviceCall).mockResolvedValue(snapshot(8));
  await poll();
  expect(serviceCall).toHaveBeenLastCalledWith('routing.log', { filterId: 'filter' });
  expect(host.textContent).not.toContain('host8.example');
  expect(host.textContent).toContain('host2.example');
  await click('Resume updates');
  expect(host.textContent).toContain('host8.example');
  expect(host.querySelectorAll('[role="row"]')).toHaveLength(9);
});
it('follows the bottom, holds scroll while paused, and virtualizes a full rolled buffer', async () => {
  vi.mocked(serviceCall).mockResolvedValue(snapshot(2));
  await render();
  const viewport = host.querySelector('.routing-log-viewport') as HTMLDivElement;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 96 });
  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    get: () =>
      32 +
      Number(
        (host.querySelector('.routing-log-spacer') as HTMLElement).style.height.replace('px', ''),
      ),
  });
  vi.mocked(serviceCall).mockResolvedValue(snapshot(1200));
  await poll();
  expect(viewport.scrollTop).toBe(1001 * 32 - 96);
  expect(host.textContent).toContain('host1200.example');
  expect(host.querySelectorAll('[role="row"]').length).toBeLessThan(25);
  await click('Pause updates');
  await act(async () => {
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  expect(host.textContent).toContain('host201.example');
  vi.mocked(serviceCall).mockResolvedValue(snapshot(1500, 'service2', 4));
  await poll();
  expect(viewport.scrollTop).toBe(0);
  expect(host.textContent).toContain('host201.example');
  await click('Resume updates');
  expect(viewport.scrollTop).toBe(1001 * 32 - 96);
  expect(host.textContent).toContain('host1500.example');
  expect(host.textContent).toContain('Revision 4');
});

async function search(text: string) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Search destinations"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function varied() {
  const data = snapshot(4);
  data.rows[0] = {
    ...data.rows[0],
    destination: '192.168.5.23:8080',
    outputId: 'local',
    output: 'Local',
  };
  data.rows[1] = {
    ...data.rows[1],
    destination: 'News.Example.org:443',
    ruleId: null,
    rule: 'Unmatched traffic',
  };
  data.rows[2] = { ...data.rows[2], destination: '[2001:db8:ab::7]:443' };
  data.rows[3] = { ...data.rows[3], destination: 'News.Example.org:8443' };
  return data;
}
it('filters by stable output identity, destination and unmatched reason without affecting collection', async () => {
  const data = varied();
  vi.mocked(serviceCall).mockResolvedValue(data);
  await render();
  const local = [...host.querySelectorAll('fieldset label')]
    .find((label) => label.textContent === 'Local')!
    .querySelector<HTMLInputElement>('input')!;
  await act(async () => local.click());
  expect(host.textContent).not.toContain('192.168.5.23:8080');
  await search(' NEWS.example.ORG ');
  expect(host.querySelectorAll('.routing-log-entry')).toHaveLength(2);
  await choose('Rules', 'All');
  await choose('Rules', 'Unmatched traffic');
  expect(host.querySelectorAll('.routing-log-entry')).toHaveLength(1);
  expect(host.textContent).toContain('Unmatched traffic');
  const next = varied();
  next.rows.push({ ...data.rows[0], id: '5', output: 'Renamed local' });
  vi.mocked(serviceCall).mockResolvedValue(next);
  await poll();
  expect(serviceCall).toHaveBeenLastCalledWith('routing.log', { filterId: 'filter' });
  await click('Reset filters');
  expect(host.querySelectorAll('.routing-log-entry')).toHaveLength(5);
  expect(host.textContent).toContain('Renamed local');
  expect(host.textContent).toContain('192.168.5.23:8080');
});
async function choose(filter: string, name: string) {
  const menu = [...host.querySelectorAll('.routing-log-choice-filter')].find((item) =>
    item.querySelector('summary')!.textContent!.trim().startsWith(filter),
  )!;
  const input = [...menu.querySelectorAll('label')]
    .find((label) => label.textContent!.trim() === name)!
    .querySelector<HTMLInputElement>('input')!;
  await act(async () => input.click());
}
it('keeps live destinations visible and masks only copied and exported visible rows', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.mocked(serviceCall).mockResolvedValue(varied());
  await render('half');
  expect(host.textContent).toContain('192.168.5.23:8080');
  expect(host.textContent).toContain('News.Example.org:443');
  const cell = host.querySelector('[data-log-destination="News.Example.org:443"]')!;
  const range = document.createRange();
  range.selectNodeContents(cell);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const selectionCopy = new Event('copy', { bubbles: true, cancelable: true });
  cell.dispatchEvent(selectionCopy);
  expect(selectionCopy.defaultPrevented).toBe(false);
  expect(selection.toString()).toBe('News.Example.org:443');
  selection.removeAllRanges();
  await search(':8080');
  await click('Copy displayed log');
  expect(writeText.mock.calls[0][0]).toContain('192.168.*.*:8080');
  expect(writeText.mock.calls[0][0]).not.toContain('192.168.5.23');
  await click('Export displayed log');
  const exported = JSON.parse(vi.mocked(exportFile).mock.calls.at(-1)![1]);
  expect(exported.rows).toHaveLength(1);
  expect(exported.rows[0].destination).toBe('192.168.*.*:8080');
  expect(host.textContent).toContain('192.168.5.23:8080');
});

it('remembers each filter independently across reopening, including unmatched selection and renamed items', async () => {
  vi.mocked(serviceCall).mockResolvedValue(varied());
  const show = async (filterId: string) => {
    await act(async () => root.render(<RoutingLog filterId={filterId} />));
  };
  await show('filter-a');
  await choose('Outputs', 'Local');
  await choose('Rules', 'All');
  await choose('Rules', 'Unmatched traffic');
  expect(host.querySelectorAll('.routing-log-entry')).toHaveLength(1);

  await show('filter-b');
  expect(host.querySelectorAll('.routing-log-entry')).toHaveLength(4);
  await choose('Outputs', 'Web');
  expect(host.querySelectorAll('.routing-log-entry')).toHaveLength(1);
  expect(host.textContent).toContain('192.168.5.23:8080');

  const renamed = varied();
  renamed.rows[0].output = 'Renamed local';
  renamed.rows[1].rule = 'Renamed unmatched';
  vi.mocked(serviceCall).mockResolvedValue(renamed);
  await act(async () => root.render(null));
  await show('filter-a');
  expect(host.querySelectorAll('.routing-log-entry')).toHaveLength(1);
  expect(host.querySelector('.routing-log-entry')!.textContent).toContain('Renamed unmatched');
  expect(host.querySelector('.routing-log-entry')!.textContent).not.toContain('192.168.5.23');
  await show('filter-b');
  expect(host.querySelectorAll('.routing-log-entry')).toHaveLength(1);
  expect(host.querySelector('.routing-log-entry')!.textContent).toContain('Renamed local');
});
