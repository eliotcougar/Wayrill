import { factoryDefaults } from '../graph/defaults';
import { profileNode } from '../graph/composites';
import { outboundPreview } from '../graph/outbounds';
import { jsonRecord } from '../graph/xrayJson';
import { xrayOutbound, type Stash, type StashEntry } from './import';
import { stashEditorNode } from './workspace';
import { putStashEntry, type StashEntryEdit } from './stashModel';
import { refreshStashComposites } from '../graph/policySources';

const labels: Record<string, string> = {
  id: 'User ID / UUID',
  user: 'Username',
  username: 'Username',
  pass: 'Password',
  password: 'Password',
  secretkey: 'Private key',
  privatekey: 'Private key',
  presharedkey: 'Pre-shared key',
  auth: 'Authentication token',
};
export type CredentialField = { path: (string | number)[]; label: string; value: string };
export type StashCredentialEdit = StashEntryEdit & { fields: CredentialField[] };

export function entryCredentials(entry: StashEntry) {
  const node = stashEditorNode(
    entry,
    {
      name: '',
      nodes: [],
      edges: [],
      defaults: factoryDefaults(),
    },
    'credentials',
  );
  const outbound = outboundPreview(node.data);
  const fields: CredentialField[] = [];
  function visit(value: unknown, path: (string | number)[]) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
    } else if (jsonRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        const label = labels[key.toLowerCase()];
        if (
          label &&
          typeof item === 'string' &&
          !(key === 'auth' && ['noauth', 'password'].includes(item))
        )
          fields.push({ path: [...path, key], label, value: item });
        else visit(item, [...path, key]);
      }
    }
  }
  visit(outbound.settings, ['settings']);
  return { outbound, fields };
}

export function applyStashCredentials(stash: Stash, edits: StashCredentialEdit[]) {
  let result = stash;
  for (const { entry, link, fields } of edits) {
    const { outbound } = entryCredentials(entry);
    for (const { path, value } of fields) {
      let parent: unknown = outbound;
      for (const key of path.slice(0, -1))
        parent = (parent as Record<string | number, unknown>)[key];
      (parent as Record<string | number, unknown>)[path.at(-1)!] = value;
    }
    const profile = xrayOutbound(outbound);
    const draft =
      entry.draft &&
      profileNode(
        profile,
        entry.name,
        {
          name: '',
          nodes: [],
          edges: [],
          defaults: factoryDefaults(),
        },
        'credentials',
      ).data;
    result = putStashEntry(
      result,
      {
        ...entry,
        profile,
        draft: draft && {
          kind: profile.kind,
          settings: draft.settings,
          overrides: draft.overrides,
          description: entry.draft?.description ?? '',
        },
        raw: '',
        problem: '',
      },
      link,
      entry,
    );
  }
  return refreshStashComposites(result, new Set(edits.map(({ link }) => link.groupId)));
}
