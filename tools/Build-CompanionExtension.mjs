import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(project, 'extensions/companion');
const files = [
  'api.js',
  'background.js',
  'capture.js',
  'native.js',
  'popup.js',
  'popup.html',
  'popup.css',
  'mark.svg',
  'icon.png',
];

export async function buildExtension(browser, output) {
  if (!['chromium', 'firefox'].includes(browser)) throw new Error('Choose chromium or firefox.');
  output = resolve(output ?? resolve(project, '.tools/companion-extensions', browser));
  if (output === source || output === project)
    throw new Error('Choose a dedicated output directory.');
  const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'));
  if (browser === 'firefox') {
    delete manifest.key;
    delete manifest.minimum_chrome_version;
    manifest.background = { scripts: ['background.js'], type: 'module' };
    manifest.browser_specific_settings = JSON.parse(
      await readFile(resolve(source, 'firefox.json'), 'utf8'),
    );
  }
  await mkdir(output, { recursive: true });
  for (const file of files) await copyFile(resolve(source, file), resolve(output, file));
  await copyFile(resolve(project, 'LICENSE'), resolve(output, 'LICENSE'));
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return output;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({
    options: { browser: { type: 'string', default: 'firefox' }, output: { type: 'string' } },
  });
  console.log(await buildExtension(values.browser, values.output));
}
