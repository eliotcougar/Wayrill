import { build } from 'rolldown';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] ?? `${root}service/subscription-engine/engine.js`;
await build({
  input: `${root}src/profiles/serviceEngine.ts`,
  platform: 'neutral',
  output: {
    file: output,
    format: 'iife', name: 'WayrillSubscriptions',
  },
});
