// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RemoteStash from './RemoteStash';
import RemoteChainSettings from './RemoteChainSettings';
import UserLibraryDialog from './users/UserLibraryDialog';
import { remoteView } from './remoteModel';
import { demoConfig } from './demo';
import { primaryProxy } from './remoteStashModel';
import { newUser, newUserSet, emptyLibrary, createUserWorkspace } from './users/model';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
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
    (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
  )!;
const click = async (name: string) => {
  await act(async () => button(name).click());
};
async function change(label: string, value: string) {
  const control = host.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      control instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )!.set!.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

it('lists used outbounds and all groups/chains in separate tabs with accurate graph state', async () => {
  const config = structuredClone(demoConfig) as Record<string, any>;
  config.outbounds[2].proxySettings = { tag: 'direct' };
  const view = remoteView(JSON.stringify(config)),
    edit = vi.fn(),
    editChain = vi.fn(),
    show = vi.fn();
  await act(async () =>
    root.render(
      <RemoteStash
        view={view}
        visible={new Set(['native-out-0'])}
        onEdit={edit}
        onEditChain={editChain}
        onShow={show}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
  expect(host.textContent).toContain('On graph');
  const directUsage = host.querySelector('tbody tr td:nth-child(3)')!.textContent!;
  expect(directUsage).toContain('Routing filter');
  expect(directUsage.match(/relay-eu/g)).toHaveLength(1);
  await click('Locate on graph');
  expect(show).toHaveBeenCalledWith('native-out-0');
  await click('Policy groups');
  expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(host.querySelector('tbody tr td:nth-child(3)')?.textContent).toContain('Routing filter');
  await click('Edit regional');
  expect(edit).toHaveBeenCalledWith('native-balancer-0');
  await click('Proxy chains');
  expect(host.textContent).toContain('relay-eu → direct');
  await click('Edit relay-eu');
  expect(editChain).toHaveBeenCalledWith('native-out-2');
});
it('edits chain hops without losing credentials or unknown fields and blocks cycles', async () => {
  const outbounds = [
    {
      tag: 'entry',
      protocol: 'socks',
      settings: { address: 'example.org', port: 1080, pass: 'fictional' },
      proxySettings: { tag: 'exit', transportLayer: true },
      extra: 17,
    },
    { tag: 'exit', protocol: 'freedom' },
    { tag: 'other', protocol: 'freedom' },
  ];
  const save = vi.fn();
  await act(async () =>
    root.render(
      <RemoteChainSettings root={0} outbounds={outbounds} onSave={save} onClose={vi.fn()} />,
    ),
  );
  await change('Next outbound for exit', 'entry');
  expect(button('Apply changes').disabled).toBe(true);
  expect(host.textContent).toContain('contains a loop');
  await change('Next outbound for exit', 'other');
  await click('Apply changes');
  const result = save.mock.calls[0][0];
  expect(result[0]).toEqual(outbounds[0]);
  expect(primaryProxy(result[1])).toBe('other');
  expect(outbounds[1]).not.toHaveProperty('streamSettings');
});
it('uses a new valid User set in the graph without requiring a library save', async () => {
  const set = newUserSet('vless'),
    use = vi.fn(),
    save = vi.fn(),
    close = vi.fn();
  await act(async () =>
    root.render(
      <UserLibraryDialog
        library={emptyLibrary()}
        workspace={createUserWorkspace({}, emptyLibrary())}
        initial={set}
        onSave={save}
        onReplace={vi.fn()}
        onUse={use}
        onClose={close}
      />,
    ),
  );
  expect(button('Add to graph').disabled).toBe(false);
  await click('Add to graph');
  expect(use).toHaveBeenCalledWith(set);
  expect(save).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});
it('shows the graph version of a linked User set rather than stale library credentials', async () => {
  const stored = newUserSet('vless'),
    graph = {
      ...stored,
      name: 'Graph version',
      users: stored.users.map((user) => ({ ...user, name: 'Current user' })),
    };
  await act(async () =>
    root.render(
      <UserLibraryDialog
        library={{ ...emptyLibrary(), sets: [stored] }}
        workspace={{ sets: [graph], bindings: [] }}
        initial={graph}
        onSave={vi.fn()}
        onReplace={vi.fn()}
        onUse={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  expect(host.textContent).toContain('Current user');
  expect(host.querySelector<HTMLInputElement>('[aria-label="Set name"]')!.value).toBe(
    'Graph version',
  );
  await click('Load library version');
  expect(host.querySelector<HTMLInputElement>('[aria-label="Set name"]')!.value).toBe(stored.name);
  await click('Load graph version');
  expect(host.textContent).toContain('Current user');
});
it('protects invalid account JSON from being discarded by user navigation or close', async () => {
  const set = newUserSet('vless');
  set.users.push(newUser('vless', 2));
  const close = vi.fn(),
    confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () =>
    root.render(
      <UserLibraryDialog
        library={emptyLibrary()}
        workspace={{ sets: [set], bindings: [] }}
        initial={set}
        onSave={vi.fn()}
        onReplace={vi.fn()}
        onUse={vi.fn()}
        onClose={close}
      />,
    ),
  );
  await click('Edit account JSON');
  const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Account JSON"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '{');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(
    [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Users in set"] button')].every(
      (button) => button.disabled,
    ),
  ).toBe(true);
  await click('Close user sets');
  expect(confirm).toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(input.value).toBe('{');
  await click('Restore last valid JSON');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('keeps all Stash tabs connected to their visible, correctly labelled panel', async () => {
  const view = remoteView(JSON.stringify(demoConfig));
  await act(async () =>
    root.render(
      <RemoteStash
        view={view}
        visible={new Set()}
        onEdit={vi.fn()}
        onEditChain={vi.fn()}
        onShow={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  const verify = () => {
    for (const tab of host.querySelectorAll('[role="tab"]'))
      expect(document.getElementById(tab.getAttribute('aria-controls')!)).not.toBeNull();
    const active = host.querySelector('[role="tab"][aria-selected="true"]')!;
    expect(
      document
        .getElementById(active.getAttribute('aria-controls')!)
        ?.getAttribute('aria-labelledby'),
    ).toBe(active.id);
  };
  verify();
  await click('Policy groups');
  verify();
  await click('Proxy chains');
  verify();
});
