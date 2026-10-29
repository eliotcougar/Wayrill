import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { protocolSource } from './protocolSource';
import { sourceDirectory } from '../test/coreIntegration';

it('keeps the source field catalogue in sync with the pinned Go structures', () => {
  for (const [name, spec] of Object.entries(protocolSource)) {
    if (spec.file.includes('+')) continue;
    const source = readFileSync(join(sourceDirectory, 'infra', 'conf', spec.file), 'utf8');
    const text = new RegExp(`type ${name} struct \\{([\\s\\S]*?)\\n\\}`).exec(source)![1];
    const fields = [...text.matchAll(/json:"([^",]+)(?:,[^"]*)?"/g)].map((match) => match[1]);
    expect(spec.fields.map((field) => field.key)).toEqual(fields);
  }
});
