/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { makeProxyInbound } from './catalog';
import { inboundPreview, inboundPreFilters, inboundProblems } from './inbounds';
import { makeProxyInbound as makeAquiferProxy } from '../../aquifer/src/graph/catalog';
import {
  inboundPreview as aquiferPreview,
  inboundProblems as aquiferProblems,
} from '../../aquifer/src/graph/inbounds';
import type { SettingValue } from '@wayrill/core/settings';
import { importXrayConfig } from './xrayImport';
import { compileRuntimeGraph } from './runtime';

const modes = ['socks', 'http', 'mixed'] as const;
type ProxyMode = (typeof modes)[number];
const editors = [
  [
    'Wayrill',
    (mode: ProxyMode, settings: Record<string, SettingValue>) => {
      const input = makeProxyInbound(mode, { x: 0, y: 0 });
      Object.assign(input.data.settings, settings);
      return { config: inboundPreview(input.data), issues: inboundProblems(input.data) };
    },
  ],
  [
    'Aquifer',
    (mode: ProxyMode, settings: Record<string, SettingValue>) => {
      const input = makeAquiferProxy(mode, { x: 0, y: 0 });
      Object.assign(input.data.settings, settings);
      return { config: aquiferPreview(input.data), issues: aquiferProblems(input.data) };
    },
  ],
] as const;
const native = (mode: (typeof modes)[number], settings: Record<string, unknown> = {}) => ({
  inbounds: [{ tag: 'native', protocol: mode, listen: '127.0.0.1', port: 20801, settings }],
  outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }],
  routing: { rules: [] },
});

describe('One Proxy inbound with three modes', () => {
  it('adds UDP to the DNS branch when switching an HTTP proxy to mixed mode', () => {
    const input = makeProxyInbound('http', { x: 0, y: 0 });
    const dnsNetwork = () =>
      inboundPreFilters(input.data).find((p) => p.branch === 'dns')?.match.network;
    expect(dnsNetwork()).toBe('tcp');
    input.data.settings.mode = 'mixed';
    expect(dnsNetwork()).toBe('tcp,udp');
  });
  it.each(editors)(
    '%s preserves each proxy mode’s authentication and credential limits',
    (_app, edit) => {
      for (const mode of modes) {
        const credentials = {
          auth: 'password',
          username: 'qa',
          password: 'example-only',
          extraAccounts: JSON.stringify([{ user: 'other', pass: 'second' }]),
        };
        const { config, issues } = edit(mode, credentials);
        expect(issues.filter(({ severity }) => severity === 'error')).toEqual([]);
        const settings = config.settings as Record<string, unknown>;
        expect(settings[mode === 'socks' ? 'users' : 'accounts']).toEqual([
          { user: 'qa', pass: 'example-only' },
          { user: 'other', pass: 'second' },
        ]);
        if (mode === 'http') {
          expect(settings).not.toHaveProperty('auth');
          expect(settings).not.toHaveProperty('udp');
        }
        const oversized = edit(mode, { ...credentials, password: 'я'.repeat(128) });
        expect(oversized.issues.some(({ fieldKey }) => fieldKey === 'password')).toBe(
          mode !== 'http',
        );
        const duplicate = edit(mode, {
          ...credentials,
          extraAccounts: '[{"user":"qa","pass":"another"}]',
        });
        expect(duplicate.issues).toContainEqual(
          expect.objectContaining({ fieldKey: 'extraAccounts', severity: 'error' }),
        );
        const unauthenticated = edit(mode, { ...credentials, auth: 'noauth', listen: '0.0.0.0' });
        expect(unauthenticated.config.settings).not.toHaveProperty('users');
        expect(unauthenticated.config.settings).not.toHaveProperty('accounts');
        expect(unauthenticated.issues).toContainEqual(
          expect.objectContaining({ fieldKey: 'auth', severity: 'warning' }),
        );
      }
    },
  );
  it.each(modes)(
    'native %s switching modes removes old protocol settings without losing metadata',
    (mode) => {
      const original = native(
        mode,
        mode === 'http'
          ? { accounts: [{ user: 'qa', pass: 'one' }], allowTransparent: true }
          : { auth: 'password', udp: true, ip: '127.0.0.1', users: [{ user: 'qa', pass: 'one' }] },
      );
      const graph = importXrayConfig(JSON.stringify(original)),
        input = graph.nodes.find((n) => n.data.kind === 'proxy-inbound')!;
      const oldId = input.id,
        edges = structuredClone(graph.edges),
        oldTag = input.data.settings.tag;
      for (const next of modes) {
        input.data.settings.mode = next;
        const config = compileRuntimeGraph(graph).config,
          raw = (config.inbounds as Record<string, unknown>[])[0];
        expect(raw.protocol).toBe(next);
        expect(raw.tag).toBe(oldTag);
        expect(input.id).toBe(oldId);
        expect(graph.edges).toEqual(edges);
        if (next === 'http') {
          expect(raw.settings).not.toHaveProperty('udp');
          expect(raw.settings).not.toHaveProperty('ip');
          expect(raw.settings).not.toHaveProperty('auth');
        } else if (next !== mode) {
          expect(raw.settings).not.toHaveProperty('allowTransparent');
        }
      }
      input.data.settings.mode = mode;
      expect(compileRuntimeGraph(graph).config).toEqual(original);
    },
  );
});
