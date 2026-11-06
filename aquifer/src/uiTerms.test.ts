import { expect, it } from 'vitest';
import { remoteView } from './remoteModel';
import { compileRemote } from './remoteExport';
import { createUserWorkspace, emptyLibrary } from './users/model';
import { navigationGroup } from './uiTerms';

it('classifies native protocols and Data outputs without changing native settings or tags', () => {
  const config = {
    inbounds: [
      { tag: 'socks', protocol: 'socks', listen: '127.0.0.1', port: 1080, settings: { udp: true } },
      { tag: 'tun', protocol: 'tun', settings: { name: 'example' } },
    ],
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
      { tag: 'candidate', protocol: 'socks', settings: { address: '127.0.0.1', port: 1081 } },
    ],
    routing: {
      rules: [{ inboundTag: ['socks', 'tun'], outboundTag: 'direct' }],
      balancers: [{ tag: 'group', selector: ['candidate'] }],
    },
  };
  const view = remoteView(JSON.stringify(config));
  expect(
    ['native-in-0', 'native-out-0', 'native-out-1', 'native-out-2'].map(
      (id) => view.nodes.find((node) => node.id === id)?.data.kind,
    ),
  ).toEqual(['proxy-inbound', 'direct-outbound', 'block-outbound', 'socks-outbound']);
  const tun = view.nodes.find((node) => node.id === 'native-in-1')!;
  expect(navigationGroup(tun.data)).toBe('Local capture');
  expect(tun.data.outputs.some((output) => output.label === 'Data')).toBe(true);
  expect(compileRemote(view, createUserWorkspace(config, emptyLibrary())).config).toEqual(config);
});
