import { describe, expect, it } from 'vitest';
import { cloneJson } from '../graph/xrayJson';
import { remoteView } from '../remoteModel';
import { demoConfig } from '../demo';
import { canConnectUsers, userNodeId, withUserNodes } from './view';
import {
  accountProblem,
  addSetToWorkspace,
  compileUsers,
  connectUserSet,
  createUserWorkspace,
  emptyLibrary,
  inboundUserProtocol,
  inboundUsers,
  mergeUserLibraries,
  newUser,
  newUserSet,
  parseUserLibrary,
  saveUserSet,
  userProtocols,
  type UserProtocol,
} from './model';

const id = '00000000-0000-4000-8000-000000000001';
const server = () => ({
  log: { loglevel: 'warning' },
  inbounds: [0, 1].map((i) => ({
    tag: `vless-${i}`,
    protocol: 'vless',
    listen: '0.0.0.0',
    port: 4400 + i,
    settings: {
      clients: [{ id, email: 'alice', custom: { keep: true } }],
      decryption: 'none',
      flow: i ? 'xtls-rprx-vision' : '',
    },
    streamSettings: { network: 'tcp' },
  })),
  outbounds: [{ tag: 'direct', protocol: 'freedom' }],
  routing: { rules: [] },
  policy: { levels: { 0: { handshake: 10 } } },
});
describe('portable multi-user sets', () => {
  it('extracts identical lists into one set shared by multiple inbounds without changing the source', () => {
    const config = server(),
      before = cloneJson(config),
      workspace = createUserWorkspace(config, emptyLibrary());
    expect(workspace.sets).toHaveLength(1);
    expect(workspace.bindings).toHaveLength(2);
    expect(compileUsers(config, workspace)).toEqual({ config, changed: false, errors: [] });
    expect(config).toEqual(before);
    expect(workspace.sets[0].users[0].account.custom).toEqual({ keep: true });
  });
  it('updates every linked inbound while preserving listener, transport, policy and routing fields', () => {
    const config = server(),
      workspace = createUserWorkspace(config, emptyLibrary());
    workspace.sets[0].users.push({ ...newUser('vless', 2), name: 'Боб 🦦' });
    const compiled = compileUsers(config, workspace);
    expect(compiled.errors).toEqual([]);
    expect(compiled.changed).toBe(true);
    for (const [index, inbound] of (compiled.config.inbounds as typeof config.inbounds).entries()) {
      expect(inbound.settings.clients).toHaveLength(2);
      expect(inbound.settings.flow).toBe(config.inbounds[index].settings.flow);
      expect(inbound.streamSettings).toEqual(config.inbounds[index].streamSettings);
    }
    expect(compiled.config.routing).toEqual(config.routing);
    expect(compiled.config.policy).toEqual(config.policy);
    expect(config.inbounds[0].settings.clients).toHaveLength(1);
  });
  it('supports many sets per inbound, deduplicates identical credentials and skips disabled users', () => {
    const config = server();
    let workspace = createUserWorkspace(config, emptyLibrary());
    const shared = cloneJson(workspace.sets[0]);
    shared.id = 'another-set';
    shared.name = 'Another set';
    shared.users.push({ ...newUser('vless', 2), enabled: false }, newUser('vless', 3));
    workspace = connectUserSet(config, addSetToWorkspace(workspace, shared), shared.id, 0);
    const result = compileUsers(config, workspace);
    expect(result.errors).toEqual([]);
    expect(inboundUsers((result.config.inbounds as Record<string, unknown>[])[0])).toHaveLength(2);
    expect(inboundUsers((result.config.inbounds as Record<string, unknown>[])[1])).toHaveLength(1);
    expect(connectUserSet(config, workspace, shared.id, 0)).toBe(workspace);
  });
  it('reports conflicting credentials and duplicate emails without including secrets in errors', () => {
    const config = server();
    let workspace = createUserWorkspace(config, emptyLibrary());
    const set = cloneJson(workspace.sets[0]);
    set.id = 'conflict';
    set.users[0].account.flow = 'xtls-rprx-vision';
    workspace = connectUserSet(config, addSetToWorkspace(workspace, set), set.id, 0);
    expect(compileUsers(config, workspace).errors.join(' ')).toContain('conflicting options');
    set.users[0].account.id = newUser('vless', 2).account.id;
    workspace = addSetToWorkspace(workspace, set);
    const errors = compileUsers(config, workspace).errors.join(' ');
    expect(errors).toContain('same email');
    expect(errors).not.toContain(id);
  });
  it('does not export a removal that would make a password listener unauthenticated', () => {
    const config = {
        inbounds: [
          { protocol: 'http', settings: { accounts: [{ user: 'alice', pass: 'fictional' }] } },
        ],
      },
      workspace = createUserWorkspace(config, emptyLibrary());
    workspace.bindings = [];
    const result = compileUsers(config, workspace);
    expect(result.errors).toHaveLength(1);
    expect(result.config).toEqual(config);
  });
  it('can disable every VLESS user without preserving active stale credentials', () => {
    const config = server(),
      workspace = createUserWorkspace(config, emptyLibrary());
    workspace.sets[0].users[0].enabled = false;
    const result = compileUsers(config, workspace);
    expect(result.errors).toEqual([]);
    for (const inbound of result.config.inbounds as Record<string, unknown>[])
      expect(inboundUsers(inbound)).toEqual([]);
  });
  it('rejects wrong protocol, wrong handles and non-inbound connections', () => {
    const config = server(),
      view = remoteView(JSON.stringify(config));
    let workspace = createUserWorkspace(config, emptyLibrary());
    const wrong = newUserSet('trojan');
    workspace = addSetToWorkspace(workspace, wrong);
    expect(() => connectUserSet(config, workspace, wrong.id, 0)).toThrow('compatible');
    const connection = {
      source: userNodeId(workspace.sets[0].id),
      target: 'native-in-0',
      sourceHandle: 'users',
      targetHandle: 'users',
    };
    expect(canConnectUsers(connection, view, workspace)).toBe(false);
    workspace.bindings = workspace.bindings.filter((b) => b.inbound !== 0);
    expect(canConnectUsers(connection, view, workspace)).toBe(true);
    expect(canConnectUsers({ ...connection, target: 'native-out-0' }, view, workspace)).toBe(false);
    expect(canConnectUsers({ ...connection, targetHandle: 'in' }, view, workspace)).toBe(false);
    expect(canConnectUsers({ ...connection, source: userNodeId(wrong.id) }, view, workspace)).toBe(
      false,
    );
  });
  it('keeps one spare output and stable per-inbound points as links change', () => {
    const config = server(),
      view = remoteView(JSON.stringify(config)),
      workspace = createUserWorkspace(config, emptyLibrary());
    const setId = workspace.sets[0].id;
    const node = withUserNodes(view, workspace).nodes.find((n) => n.data.userSetId === setId)!;
    expect(node.data.outputs.map((port) => port.id)).toEqual(['users-0', 'users-1', 'users']);
    expect(
      withUserNodes(view, workspace)
        .edges.filter((e) => e.data?.connectionKind === 'users')
        .map((e) => e.sourceHandle),
    ).toEqual(['users-0', 'users-1']);
    workspace.bindings = workspace.bindings.filter((b) => b.inbound !== 0);
    const updated = withUserNodes(view, workspace);
    expect(
      updated.nodes.find((n) => n.data.userSetId === setId)!.data.outputs.map((p) => p.id),
    ).toEqual(['users-1', 'users']);
    expect(updated.edges.find((e) => e.id === `users:${setId}:1`)?.sourceHandle).toBe('users-1');
    workspace.bindings = [];
    expect(
      withUserNodes(view, workspace)
        .nodes.find((n) => n.data.userSetId === setId)!
        .data.outputs.map((p) => p.id),
    ).toEqual(['users']);
  });
  it('only exposes Users inputs on list-capable inbounds, preserving fixed server credentials', () => {
    for (const protocol of ['dokodemo-door', 'tun', 'wireguard', 'shadowsocks'])
      expect(
        inboundUserProtocol({
          protocol,
          settings: { password: 'fixed-key', method: 'aes-256-gcm' },
        }),
      ).toBeNull();
    expect(
      inboundUserProtocol({
        protocol: 'shadowsocks',
        settings: { method: '2022-blake3-chacha20-poly1305', users: [] },
      }),
    ).toBeNull();
    const view = remoteView(JSON.stringify(demoConfig)),
      workspace = createUserWorkspace(view.original, emptyLibrary()),
      decorated = withUserNodes(view, workspace);
    expect(decorated.nodes.find((n) => n.id === 'native-in-0')?.data.inputs?.[0].id).toBe('users');
    expect(decorated.nodes.find((n) => n.id === 'native-in-1')?.data.inputs).toBeUndefined();
    expect(decorated.nodes.filter((n) => n.data.category === 'users')).toHaveLength(1);
    expect(decorated.edges.filter((e) => e.data?.connectionKind === 'users')).toHaveLength(1);
  });
  it('preserves alias precedence, original spelling and unrelated account properties', () => {
    const config = {
      Inbounds: [
        {
          Protocol: 'vless',
          Settings: {
            Users: [{ ID: id, Email: 'alice', reverse: { tag: 'portal' } }],
            Decryption: 'none',
          },
        },
      ],
    };
    const workspace = createUserWorkspace(config, emptyLibrary());
    expect(compileUsers(config, workspace).config).toEqual(config);
    workspace.sets[0].users.push(newUser('vless', 2));
    const result = compileUsers(config, workspace).config as typeof config;
    expect(result.Inbounds[0].Settings.Users).toHaveLength(2);
    expect(result.Inbounds[0].Settings.Users[0].reverse).toEqual({ tag: 'portal' });
    expect(inboundUsers({ protocol: 'vless', settings: { clients: [], users: [{ id }] } })).toEqual(
      [],
    );
  });
  it.each(['socks', 'mixed', 'http'])(
    'assigns accounts to %s without changing unrelated settings',
    (protocol) => {
      const config = { inbounds: [{ protocol, settings: { auth: 'noauth', udp: true } }] };
      const set = newUserSet('password');
      let workspace = createUserWorkspace(config, emptyLibrary());
      workspace = connectUserSet(config, addSetToWorkspace(workspace, set), set.id, 0);
      const result = compileUsers(config, workspace);
      expect(result.errors).toEqual([]);
      const settings = (
        result.config as typeof config & { inbounds: { settings: Record<string, unknown> }[] }
      ).inbounds[0].settings;
      expect(settings.accounts).toHaveLength(1);
      expect(settings.auth).toBe(protocol === 'http' ? 'noauth' : 'password');
      expect(settings.udp).toBe(true);
    },
  );
  it('uses the saved library across different server configs', () => {
    const config = server(),
      workspace = createUserWorkspace(config, emptyLibrary()),
      set = workspace.sets[0];
    const library = saveUserSet(emptyLibrary(), set),
      restored = parseUserLibrary(JSON.stringify(library));
    const other = server();
    other.inbounds[0].port = 8443;
    const imported = createUserWorkspace(other, restored);
    expect(imported.sets[0].id).toBe(set.id);
    expect(imported.bindings).toHaveLength(2);
    expect(restored.sets[0].users[0].account.id).toBe(id);
  });
  it('merges portable files without overwriting local sets with the same ID', () => {
    const set = newUserSet();
    const current = saveUserSet(emptyLibrary(), set),
      modified = cloneJson(current);
    modified.sets[0].users[0].account.id = newUser('vless', 2).account.id;
    expect(mergeUserLibraries(current, current).skipped).toBe(1);
    const merged = mergeUserLibraries(current, modified);
    expect(merged.added).toBe(1);
    expect(merged.library.sets).toHaveLength(2);
    expect(merged.library.sets[0]).toEqual(set);
    expect(merged.library.sets[1].id).not.toBe(set.id);
    expect(mergeUserLibraries(merged.library, modified).skipped).toBe(1);
  });
  it.each(Object.keys(userProtocols) as UserProtocol[])(
    'generates valid %s users with portable metadata',
    (protocol) => {
      const set = newUserSet(protocol);
      set.users.push(newUser(protocol, 2));
      expect(accountProblem(protocol, set.users[0].account)).toBeNull();
      expect(parseUserLibrary(JSON.stringify({ ...emptyLibrary(), sets: [set] })).sets[0]).toEqual(
        set,
      );
    },
  );
  it('rejects invalid credentials, duplicate IDs, unsafe keys and malformed portable files', () => {
    const set = newUserSet();
    const library = saveUserSet(emptyLibrary(), set);
    expect(() =>
      parseUserLibrary('{"format":"wayrill-user-sets","version":1,"sets":[],"sets":[]}'),
    ).toThrow();
    expect(() => parseUserLibrary('{"__proto__":{}}')).toThrow();
    const duplicate = { ...library, sets: [set, set] };
    expect(() => parseUserLibrary(JSON.stringify(duplicate))).toThrow('metadata');
    const invalid = cloneJson(library);
    invalid.sets[0].users[0].account.id = 'x'.repeat(31);
    expect(() => parseUserLibrary(JSON.stringify(invalid))).toThrow('30 bytes');
    expect(accountProblem('vless', { id, flow: 'invalid' })).toContain('flow');
    expect(accountProblem('ss2022-128', { password: 'not-base64' })).toBeTruthy();
    expect(accountProblem('masque', { email: 'invalid:name', pass: 'password' })).toContain(
      'colon',
    );
  });
  it('keeps large sets intact without putting credentials on graph cards', () => {
    const config = server(),
      workspace = createUserWorkspace(config, emptyLibrary());
    workspace.sets[0].users = Array.from({ length: 10000 }, (_, i) => ({
      id: `u${i}`,
      name: `User ${i}`,
      enabled: true,
      account: { id: `synthetic-user-${i}` },
    }));
    expect(compileUsers(config, workspace).errors).toEqual([]);
    const view = withUserNodes(remoteView(JSON.stringify(config)), workspace),
      card = view.nodes.find((n) => n.data.category === 'users')!;
    expect(card.data.facts[0][1]).toContain('10000');
    expect(JSON.stringify(card.data.facts)).not.toContain('synthetic-user');
    expect(
      parseUserLibrary(JSON.stringify({ ...emptyLibrary(), sets: workspace.sets })).sets[0].users,
    ).toHaveLength(10000);
  });
});
