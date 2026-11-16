import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(project, 'extensions/companion');
const files = [
  'api.js',
  'background.js',
  'background-timezone.js',
  'capture.js',
  'native.js',
  'popup.js',
  'popup.html',
  'popup.css',
  'timezone.js',
  'timezone-popup.js',
  'timezone-popup.css',
  'mark.svg',
  'icon.png',
];

export async function buildExtension(browser, output) {
  if (!['chromium', 'firefox'].includes(browser)) throw new Error('Choose chromium or firefox.');
  output = resolve(output ?? resolve(project, '.tools/companion-extensions', browser));
  if (output === source || output === project)
    throw new Error('Choose a dedicated output directory.');
  const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'));
  const firefox = browser === 'firefox';
  if (firefox) {
    delete manifest.key;
    delete manifest.minimum_chrome_version;
    manifest.background = { scripts: ['background-firefox.js'], type: 'module' };
    manifest.browser_specific_settings = JSON.parse(
      await readFile(resolve(source, 'firefox.json'), 'utf8'),
    );
  } else {
    manifest.background.service_worker = 'background-chromium.js';
    manifest.permissions.push('alarms');
  }
  await mkdir(output, { recursive: true });
  const browserFiles = [...files, firefox ? 'background-firefox.js' : 'background-chromium.js'];
  for (const file of browserFiles) await copyFile(resolve(source, file), resolve(output, file));
  let html = await readFile(resolve(source, 'popup.html'), 'utf8');
  const fragment = await readFile(resolve(source, 'timezone-popup.html'), 'utf8');
  for (const [marker, addition] of [
    [
      '</head>',
      '<link rel="stylesheet" href="timezone-popup.css" />\n<script type="module" src="timezone-popup.js"></script>\n</head>',
    ],
    [
      '<!-- timezone-button -->',
      '<button id="timezone-button" class="quiet" aria-expanded="false" aria-controls="timezone-settings">Time Zone</button>',
    ],
    ['<!-- timezone-panel -->', fragment],
    ['<!-- timezone-apply-label -->', firefox ? 'Save timezone' : 'Apply and reload web tabs'],
  ]) {
    if (html.split(marker).length !== 2)
      throw new Error('Companion popup insertion point changed: ' + marker);
    html = html.replace(marker, addition);
  }
  await writeFile(resolve(output, 'popup.html'), html);
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
