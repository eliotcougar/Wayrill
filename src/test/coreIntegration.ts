import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Run npm run test:core to prepare the Xray integration suite.');
  return value;
}

export const core = required('WAYRILL_XRAY_TEST_EXE');
export const fixtureDir = required('WAYRILL_XRAY_FIXTURE_DIR');
export const sourceDirectory = required('WAYRILL_XRAY_SOURCE');

export function checkCoreConfig(name: string, config: unknown) {
  mkdirSync(fixtureDir, { recursive: true });
  const file = join(fixtureDir, name + '.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  const result = spawnSync(core, ['run', '-test', '-config', file], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  writeFileSync(file + '.log', `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return result;
}
