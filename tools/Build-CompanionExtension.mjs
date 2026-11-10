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
    // Firefox remains its independently signed release. Shared source still
    // passes the exact signed-source check; Chromium-only files stay separate.
    manifest.version = JSON.parse(
      await readFile(resolve(project, 'extensions/signed/firefox.json'), 'utf8'),
    ).version;
    manifest.permissions = manifest.permissions.filter((permission) => permission !== 'debugger');
  } else {
    manifest.background.service_worker = 'background-chromium.js';
    manifest.permissions.push('alarms');
  }
  await mkdir(output, { recursive: true });
  const browserFiles =
    browser === 'chromium'
      ? [
          ...files,
          'background-chromium.js',
          'timezone.js',
          'timezone-popup.js',
          'timezone-popup.css',
        ]
      : files;
  for (const file of browserFiles) await copyFile(resolve(source, file), resolve(output, file));
  if (browser === 'chromium') {
    let html = await readFile(resolve(source, 'popup.html'), 'utf8');
    const fragment = await readFile(resolve(source, 'timezone-popup.html'), 'utf8');
    for (const [marker, addition] of [
      [
        '</head>',
        '<link rel="stylesheet" href="timezone-popup.css" />\n<script type="module" src="timezone-popup.js"></script>\n',
      ],
      ['<div id="domains"', fragment + '\n'],
    ]) {
      if (html.split(marker).length !== 2)
        throw new Error('Companion popup insertion point changed: ' + marker);
      html = html.replace(marker, addition + marker);
    }
    await writeFile(resolve(output, 'popup.html'), html);
  }
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
