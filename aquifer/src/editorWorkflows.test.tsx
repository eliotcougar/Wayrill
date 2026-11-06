// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RemoteSettings from './RemoteSettings';
import RemoteStash from './RemoteStash';
import { policyCandidates } from './RemotePolicySettings';
import { ruleIssues } from './routingEditor';
import { remoteView } from './remoteModel';
import MapInput from './MapInput';
import { readRoutingOutputs } from './routingOutputs';
import { nodeSettings } from './nodeSettings';
import { demoConfig } from './demo';

let host: HTMLDivElement, root: Root;
const destinations = [
  { tag: 'direct', group: false },
  { tag: 'relay-eu', group: false },
  { tag: 'relay-us', group: false },
  { tag: 'regional', group: true },
  { tag: 'api', group: false, internal: true },
];
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.requestAnimationFrame = (callback) =>
    window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const button = (name: string) =>
  [...host.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  )!;
const control = (name: string) =>
  host.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    `[aria-label="${name}"]`,
  )!;
async function change(name: string, value: string) {
  const input = control(name);
  await act(async () => {
    const prototype =
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}
async function render(
  value: Record<string, unknown>,
  schema = 'RouterConfig',
  options = destinations,
) {
  const onSave = vi.fn();
  await act(async () =>
    root.render(
      <RemoteSettings
        title="Test"
        value={value}
        schema={schema}
        destinations={options}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    ),
  );
  return onSave;
}
const first = {
  type: 'field',
  ruleTag: 'First',
  domain: ['domain:first.example'],
  ip: ['192.0.2.0/24'],
  outboundTag: 'direct',
};
const second = {
  type: 'field',
  ruleTag: 'Second',
  domain: ['domain:second.example'],
  ip: ['198.51.100.0/24'],
  outboundTag: 'relay-eu',
};
it('refreshes list fields after deleting the selected rule and keeps editing the surviving rule', async () => {
  const onSave = await render({ rules: [first, second] });
  await act(async () => button('Remove rule').click());
  expect(control('Destination domains').value).toBe('domain:second.example');
  expect(control('Destination IPs').value).toBe('198.51.100.0/24');
  await change('Destination domains', 'domain:edited.example\n');
  expect(control('Destination domains').value.endsWith('\n')).toBe(true);
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenCalledWith({
    rules: [{ ...second, domain: ['domain:edited.example'] }],
  });
});
it('searches only visible rules and cannot delete a hidden selection', async () => {
  const onSave = await render({ rules: [first, second] });
  await change('Find routing rules', 'second.example');
  expect(control('Destination domains').value).toBe('domain:second.example');
  await change('Destination domains', 'domain:edited.example');
  expect(control('Find routing rules').value).toBe('');
  expect(control('Destination domains').value).toBe('domain:edited.example');
  await change('Find routing rules', 'no-such-rule');
  expect(button('Remove rule').disabled).toBe(true);
  expect(host.querySelector('[aria-label="Rule name"]')).toBeNull();
  await change('Find routing rules', 'edited.example');
  await act(async () => button('Remove rule').click());
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenCalledWith({ rules: [first] });
});
it('validation reveals a failing rule outside the current search', async () => {
  await render({ rules: [first, { ...second, sourcePort: '99999' }] });
  await change('Find routing rules', 'first.example');
  await act(async () => button('Apply changes').click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(control('Find routing rules').value).toBe('');
  expect(control('Rule name').value).toBe('Second');
  expect(control('Source ports').value).toBe('99999');
  expect(document.activeElement).toBe(control('Source ports'));
});
it('duplicates next to the original and preserves unknown fields through move and search', async () => {
  const original = {
    ...first,
    webhook: { url: 'https://example.org/check' },
    futureField: { retained: true },
  };
  const onSave = await render({ rules: [original, second] });
  await act(async () => button('Duplicate rule').click());
  await change('Rule name', 'Copy');
  await act(async () => button('Move rule down').click());
  await change('Find routing rules', 'second.example');
  const list = host.querySelector('[aria-label="Routing rules"]')!;
  expect(list.querySelectorAll('button')).toHaveLength(1);
  expect(list.textContent).toContain('Second');
  expect(list.querySelector('b')!.textContent).toBe('2');
  await act(async () => list.querySelector<HTMLButtonElement>('button')!.click());
  expect(control('Destination domains').value).toBe('domain:second.example');
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenCalledWith({
    rules: [original, second, { ...original, ruleTag: 'Copy' }],
  });
});
it('edits the effective aliases and preserves imported capitalization without duplicate properties', async () => {
  const onSave = await render({
    Rules: [
      {
        Type: 'field',
        RuleTag: 'Alias',
        Domain: ['unused'],
        Domains: ['domain:effective.example'],
        Source: ['192.0.2.1'],
        OutboundTag: 'direct',
      },
    ],
  });
  expect(control('Destination domains').value).toBe('domain:effective.example');
  await change('Destination domains', 'domain:new.example');
  await change('Source IPs', '198.51.100.1');
  await change('Rule name', 'Renamed');
  await change('Rule destination', JSON.stringify([true, 'regional']));
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenCalledWith({
    Rules: [
      {
        Type: 'field',
        RuleTag: 'Renamed',
        Domain: ['unused'],
        Domains: ['domain:new.example'],
        Source: ['198.51.100.1'],
        balancerTag: 'regional',
      },
    ],
  });
});
it('removes both domain aliases when clearing the condition so a hidden alias cannot reactivate', async () => {
  const onSave = await render({ rules: [{ ...first, domains: ['second'], network: 'tcp' }] });
  await change('Destination domains', '');
  await act(async () => button('Apply changes').click());
  const rule = onSave.mock.calls[0][0].rules[0];
  expect(rule.domain).toBeUndefined();
  expect(rule.domains).toBeUndefined();
});
it('uses protocol/network checkboxes and removes empty restrictions', async () => {
  const onSave = await render({ rules: [{ ...first, network: 'tcp,udp', protocol: ['tls'] }] });
  const checkbox = (label: string) =>
    [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(
      (item) => item.parentElement?.textContent === label,
    )!;
  await act(async () => checkbox('TCP').click());
  await act(async () => checkbox('UDP').click());
  await act(async () => checkbox('TLS').click());
  await act(async () => checkbox('QUIC').click());
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenCalledWith({ rules: [{ ...first, protocol: ['quic'] }] });
  expect(host.textContent).toContain('none selected = any');
});
it('selects the failing rule and opens its advanced conditions for invalid ports', async () => {
  const onSave = await render({ rules: [first, { ...second, sourcePort: '99999' }] });
  await act(async () => button('Apply changes').click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(onSave).not.toHaveBeenCalled();
  expect(control('Rule name').value).toBe('Second');
  expect(control('Source ports').closest('details')!.open).toBe(true);
  expect(document.activeElement).toBe(control('Source ports'));
  await change('Source ports', '1000-2000');
  expect(host.querySelector('.settings-issues')).toBeNull();
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenCalledOnce();
});
it('blocks a new empty rule and exposes unavailable destinations without replacing them silently', async () => {
  const onSave = await render({ rules: [{ ...first, outboundTag: 'missing' }] });
  expect(control('Rule destination').textContent).toContain('Unavailable: missing');
  await act(async () => button('Apply changes').click());
  expect(onSave).not.toHaveBeenCalled();
  await change('Rule destination', JSON.stringify([false, 'direct']));
  await act(async () => button('Add rule').click());
  await act(async () => button('Apply changes').click());
  expect(host.textContent).toContain('Rule 2: add a condition');
  expect(onSave).not.toHaveBeenCalled();
  await change('Destination domains', 'domain:added.example');
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenCalledOnce();
});
it('edits structured HTTP attributes while keeping case-sensitive map keys separate', async () => {
  let current: unknown = { Foo: 'one', foo: 'two' };
  const update = (value: unknown) => {
    current = value;
    root.render(<MapInput value={value} lists={false} label="Attributes" onChange={update} />);
  };
  await act(async () => update(current));
  await change('Attributes value 2', 'changed');
  expect(current).toEqual({ Foo: 'one', foo: 'changed' });
});
it('reorders native rules by pointer and keyboard without submitting or losing selection', async () => {
  const onSave = await render({ rules: [first, second] });
  HTMLElement.prototype.setPointerCapture = () => {};
  const list = host.querySelector<HTMLElement>('[aria-label="Routing rules"]')!;
  list.getBoundingClientRect = () => ({ left: 0, right: 200, top: 0, bottom: 120 }) as DOMRect;
  const rows = [...list.querySelectorAll<HTMLButtonElement>('button')];
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: index * 60, bottom: (index + 1) * 60 }) as DOMRect;
  });
  const handle = rows[1].querySelector<HTMLElement>('.rule-drag-handle')!;
  for (const [type, y] of [
    ['pointerdown', 90],
    ['pointermove', 20],
    ['pointerup', 20],
  ] as const) {
    await act(async () => {
      const event = new MouseEvent(type, { clientX: 20, clientY: y, button: 0, bubbles: true });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      handle.dispatchEvent(event);
    });
  }
  expect(list.querySelector('button')).toBe(rows[1]);
  expect(document.activeElement).toBe(rows[1]);
  expect(control('Rule name').value).toBe('Second');
  await act(async () =>
    rows[1].dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(list.querySelector('button')).toBe(rows[0]);
  expect(document.activeElement).toBe(rows[1]);
  await act(async () => rows[0].click());
  expect(onSave).not.toHaveBeenCalled();
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenCalledWith({ rules: [first, second] });
});
it('stages expanded domains and IPs; Cancel and Escape discard only the expansion', async () => {
  const onSave = await render({ rules: [first] });
  await act(async () => button('Expand Destination domains').click());
  await change('Expanded Destination domains', 'domain:discard.example');
  const expanded = host.querySelector<HTMLDialogElement>(
    '[aria-label="Edit Destination domains"]',
  )!;
  await act(async () =>
    expanded.querySelector<HTMLButtonElement>('.dialog-footer button')!.click(),
  );
  expect(control('Destination domains').value).toBe('domain:first.example');
  await act(async () => button('Expand Destination IPs').click());
  await change('Expanded Destination IPs', '203.0.113.0/24\n2001:db8::/32\n');
  await act(async () => button('OK').click());
  expect(control('Destination IPs').value).toBe('203.0.113.0/24\n2001:db8::/32');
  await act(async () => button('Expand Destination domains').click());
  await act(async () =>
    host
      .querySelector<HTMLDialogElement>('[aria-label="Edit Destination domains"]')!
      .dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true })),
  );
  expect(host.querySelectorAll('dialog')).toHaveLength(1);
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenCalledWith({
    rules: [{ ...first, ip: ['203.0.113.0/24', '2001:db8::/32'] }],
  });
});
it('manages outputs without touching hidden API routes; retargeting preserves all rule conditions', async () => {
  const view = remoteView(JSON.stringify(demoConfig));
  const editor = nodeSettings(view, 'native-routing')!;
  const onSave = vi.fn();
  await act(async () =>
    root.render(
      <RemoteSettings
        {...editor}
        routingOutputs={readRoutingOutputs(view)}
        title="Routing"
        destinations={[...destinations, { tag: 'blocked', group: false }].map((destination) => ({
          ...destination,
          hidden: destination.tag === 'api',
        }))}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    ),
  );
  await act(async () => button('Outputs').click());
  expect(control('Destination for api')).toBeNull();
  expect(button('Delete output direct').disabled).toBe(true);
  await change('Destination for blocked', JSON.stringify([false, 'relay-eu']));
  await change('Output 2 name', 'Relay');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => button('Delete output Relay').click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(button('Delete output Relay')).not.toBeNull();
  await act(async () => button('Apply changes').click());
  const [routing, , outputs] = onSave.mock.calls[0];
  expect(routing.rules[1]).toEqual({ ...demoConfig.routing.rules[2], outboundTag: 'relay-eu' });
  expect(routing.rules).toHaveLength(3);
  expect(outputs.find((output: { name: string }) => output.name === 'Relay')).toMatchObject({
    tag: 'relay-eu',
  });
  onSave.mockClear();
  confirm.mockReturnValue(true);
  await act(async () => button('Delete output Relay').click());
  await act(async () => button('Apply changes').click());
  expect(onSave.mock.calls[0][0].rules).toEqual([
    demoConfig.routing.rules[1],
    demoConfig.routing.rules[3],
  ]);
  expect(onSave.mock.calls[0][2].some((output: { name: string }) => output.name === 'Relay')).toBe(
    false,
  );
});
it('previews case-sensitive deduplicated policy members and excludes virtual/group destinations', () => {
  expect(
    policyCandidates(
      { selector: ['relay', 'relay-', 'api', 'regional', 'DIRECT'] },
      destinations,
    ).map(({ tag }) => tag),
  ).toEqual(['relay-eu', 'relay-us']);
});
it('edits policy strategy and fallback without adding defaults to an unchanged policy', async () => {
  const value = {
    Tag: 'regional',
    Selector: ['relay-'],
    FallbackTag: 'direct',
    Strategy: { Type: 'leastPing', future: { kept: true } },
  };
  const onSave = await render(value, 'BalancingRule');
  expect(host.querySelectorAll('.policy-preview li')).toHaveLength(2);
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenLastCalledWith(value);
  await change('Selection strategy', 'roundrobin');
  await change('Fallback outbound', 'relay-eu');
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenLastCalledWith({
    ...value,
    FallbackTag: 'relay-eu',
    Strategy: { ...value.Strategy, Type: 'roundrobin' },
  });
});
it('searches a large policy candidate set without rendering every row', async () => {
  const list = Array.from({ length: 220 }, (_, i) => ({ tag: `relay-${i} 🌍`, group: false }));
  await render({ tag: 'large', selector: ['relay-'] }, 'BalancingRule', list);
  expect(host.querySelectorAll('.policy-preview li')).toHaveLength(100);
  await act(async () => button('Next').click());
  expect(host.textContent).toContain('2 / 3');
  await change('Find matching outbounds', 'relay-219');
  expect(host.querySelectorAll('.policy-preview li')).toHaveLength(1);
  expect(host.textContent).toContain('relay-219 🌍');
});
it('keeps numeric WireGuard reserved bytes numeric in the outbound form', async () => {
  const onSave = await render(
    { protocol: 'wireguard', settings: { secretKey: 'test', reserved: [1, 2, 3] } },
    'OutboundDetourConfig',
  );
  await change('Reserved bytes', '1\n42\n3');
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenCalledWith({
    protocol: 'wireguard',
    settings: { secretKey: 'test', reserved: [1, 42, 3] },
  });
});
it('bounds Stash rows and finds Unicode names beyond the current page', async () => {
  const view = remoteView(
    JSON.stringify({
      outbounds: Array.from({ length: 230 }, (_, i) => ({
        tag: `\u{1F1EE}\u{1F1EA} Ireland-${i}`,
        protocol: 'freedom',
      })),
    }),
  );
  const onEdit = vi.fn();
  await act(async () =>
    root.render(
      <RemoteStash
        view={view}
        visible={new Set()}
        onEditChain={vi.fn()}
        onEdit={onEdit}
        onShow={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(host.querySelectorAll('tbody tr')).toHaveLength(100);
  await act(async () => button('Next').click());
  expect(host.textContent).toContain('101–200 of 230');
  await change('Find stashed configurations', 'Ireland-229');
  expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
  await act(async () => button('Edit 🇮🇪 Ireland-229').click());
  expect(onEdit).toHaveBeenCalledWith('native-out-229');
});
it('validates effective aliases and allows native webhook-only conditions', () => {
  expect(
    ruleIssues(
      {
        rules: [
          { domains: ['domain:example.org'], outboundTag: 'direct' },
          { webhook: { url: 'https://example.org/check' }, outboundTag: 'relay-eu' },
        ],
      },
      destinations,
    ),
  ).toEqual([]);
});
it('supports Xray’s empty-prefix selector explicitly as all outbounds', async () => {
  const value = { tag: 'all', selector: [''] };
  const onSave = await render(value, 'BalancingRule');
  expect(control('Candidate selection').value).toBe('all');
  expect(host.querySelectorAll('.policy-preview li')).toHaveLength(3);
  await act(async () => button('Apply changes').click());
  expect(onSave).toHaveBeenCalledWith(value);
  await change('Candidate selection', 'prefixes');
  await change('Outbound tag prefixes', 'relay-');
  expect(host.querySelectorAll('.policy-preview li')).toHaveLength(2);
});
it('retains malformed imported rules for correction instead of dropping them during structured edits', async () => {
  const value = { rules: [first, null, second] },
    onSave = await render(value);
  expect(host.textContent).toContain('Use Edit JSON to correct');
  expect(host.querySelector('[aria-label="Remove rule"]')).toBeNull();
  await act(async () => button('Apply changes').click());
  expect(onSave).not.toHaveBeenCalled();
  await act(async () => button('Edit JSON').click());
  expect(JSON.parse(control('Node settings JSON').value)).toEqual(value);
});
