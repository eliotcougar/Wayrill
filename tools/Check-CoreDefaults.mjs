import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

function expectedFields(schema, audit) {
  const fields = {};
  for (const [structure, spec] of Object.entries(schema)) for (const field of spec.fields) {
    const go = field.goType;
    const entry = go === 'bool' ? { value: false, hint: 'Disabled' }
      : /^u?int(?:8|16|32|64)?$|^byte$/.test(go) ? { value: 0, hint: '0' }
      : go === 'string' ? { value: '', hint: 'Empty — no value' }
      : go.startsWith('[]') || go.replace(/^\*+/, '') === 'StringList' ? { hint: 'None — empty list' }
      : { hint: 'Not configured' };
    const key = `${structure}.${field.key}`;
    fields[key] = { ...entry, sources: ['infra/conf/' + spec.file.split(' + ')[0]], ...audit.overrides[key] };
  }
  const sourceFiles = { DNSConfig: 'dns.go', NameServerConfig: 'dns.go', Policy: 'policy.go', SystemPolicy: 'policy.go', LogConfig: 'log.go', RouterConfig: 'router.go', MetricsConfig: 'metrics.go', FragmentMask: 'transport_finalmask.go', UDPHop: 'transport_finalmask.go' };
  for (const [key, entry] of Object.entries(audit.overrides)) if (!(key in fields)) {
    const structure = key.split('.')[0];
    if (structure in schema) throw new Error(`Unknown audited field: ${key}`);
    fields[key] = { ...entry, sources: entry.sources ?? ['infra/conf/' + (sourceFiles[structure] ?? 'xray.go')] };
  }
  return fields;
}

export function checkCoreDefaults(root, source) {
  const read = name => readFileSync(resolve(root, name));
  const hash = bytes => createHash('sha256').update(bytes.toString().replace(/\r\n/g, '\n')).digest('hex');
  const store = JSON.parse(read('src/graph/xrayCoreDefaults.json'));
  const auditBytes = read('tools/core-defaults-audit.json'), audit = JSON.parse(auditBytes);
  const pin = JSON.parse(read('service/dependencies.json')).xray;
  for (const [key, expected] of [['version',pin.version],['sourceCommit',pin.sourceCommit],['executableSha256',pin.executableSha256.toLowerCase()]]) {
    if (store.core[key] !== expected) throw new Error(`Xray ${key} changed: review and regenerate the core defaults store before building.`);
  }
  if (audit.coreVersion !== pin.version || audit.sourceCommit !== pin.sourceCommit || audit.executableSha256 !== pin.executableSha256.toLowerCase() || store.core.platform !== audit.platform) throw new Error('Core pin changed: review and regenerate the core defaults audit.');
  if (store.auditSha256 !== hash(auditBytes) || store.schemaSha256 !== hash(read('src/graph/protocolSource.ts'))) throw new Error('Core defaults audit/schema changed: regenerate the store from the pinned source.');
  const schemaText = read('src/graph/protocolSource.ts').toString();
  const schema = JSON.parse(schemaText.slice(schemaText.indexOf('{'), schemaText.lastIndexOf('}') + 1));
  if (store.version !== 1 || !isDeepStrictEqual(store.externalSources, audit.externalSources ?? {}) || !isDeepStrictEqual(store.globals, audit.globals) || !isDeepStrictEqual(store.fields, expectedFields(schema, audit))) throw new Error('Core defaults store differs from the reviewed audit: regenerate the store.');
  const names = JSON.parse(read('src/graph/xrayConfigNames.json'));
  if (names.version !== 1 || ['version', 'sourceCommit', 'executableSha256'].some(key => names.core[key] !== pin[key]) || names.protocolSchemaSha256 !== hash(read('src/graph/protocolSource.ts'))) throw new Error('Xray field-name schema changed: review/regenerate the capitalization schema with the pinned source.');
  if (source) for (const [name, digest] of Object.entries(names.sourceFiles)) {
    const path = resolve(source, name);
    if (!existsSync(path) || hash(readFileSync(path)) !== digest) throw new Error(`Xray field-name source changed: ${name}`);
  }
  if (source) for (const [name, digest] of Object.entries(audit.auditedFiles)) {
    const path=resolve(source,name);
    if (!existsSync(path) || hash(readFileSync(path))!==digest) throw new Error(`Audited Xray source changed: ${name}`);
  }
  return store.core;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
  try { const core=checkCoreDefaults(root,process.env.WAYRILL_XRAY_SOURCE); console.log(`Xray ${core.version} defaults match the embedded core pin${process.env.WAYRILL_XRAY_SOURCE?' and audited source':''}.`); }
  catch (error) { console.error(error.message); process.exitCode=1; }
}
