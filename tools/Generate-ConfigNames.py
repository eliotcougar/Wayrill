"""Generate schema-aware field-name repair from the embedded Xray source pin.

Run after reviewing an upstream update, alongside Generate-ProtocolSchema.py.
Only JSON-tagged structs are traversed. Raw extension bodies stay opaque unless
the pinned loader supplies a known schema; map keys are always user data.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True, type=Path)
parser.add_argument('--root', required=True, type=Path)
args = parser.parse_args()
pin = json.loads((args.root / 'service/dependencies.json').read_text(encoding='utf-8-sig'))['xray']
commit = subprocess.check_output(['git', '-C', str(args.source), 'rev-parse', 'HEAD'], text=True).strip()
if commit != pin['sourceCommit']:
    raise SystemExit('Use the reviewed embedded Xray source commit.')

structures, files = {}, {}
for path in sorted((args.source / 'infra/conf').glob('*.go')):
    if path.name.endswith('_test.go'):
        continue
    text = path.read_text(encoding='utf-8')
    for match in re.finditer(r'type (\w+) struct\s*\{(.*?)^\s*\}', text, re.M | re.S):
        fields, embedded = {}, []
        for line in match[2].splitlines():
            field = re.search(r'^\s*\w+\s+(.+?)\s+`json:"([^",]*)(?:,[^"]*)?"`', line)
            if field and field[2] and field[2] != '-':
                fields[field[2]] = field[1].strip()
            elif re.fullmatch(r'\s*\w+\s*', line):
                embedded.append(line.strip())
        if fields:
            structures[match[1]] = {'fields': fields, 'embedded': embedded}
            relative = path.relative_to(args.source).as_posix()
            files[relative] = hashlib.sha256(text.encode()).hexdigest()

for spec in structures.values():
    for child in spec.pop('embedded'):
        spec['fields'] = {**structures[child]['fields'], **spec['fields']}

# The graph/compiler/service use this established, Go-case-insensitive spelling.
structures['Config']['fields']['fakedns'] = structures['Config']['fields'].pop('fakeDns')

# Accounts use two JSON decoders (protocol.User plus protocol-specific account).
# Reuse their existing reviewed catalogue, rather than guessing at credential keys.
protocol_text = (args.root / 'src/graph/protocolSource.ts').read_text(encoding='utf-8')
protocol = json.loads(protocol_text[protocol_text.index('{'):protocol_text.rindex('}') + 1])
for name, spec in protocol.items():
    if name not in structures:
        structures[name] = {'fields': {f['key']: f['goType'] for f in spec['fields']}}

# Account reverse has different semantics from the global reverse module.
structures['AccountReverse'] = {'fields': {'tag': 'string', 'sniffing': 'json.RawMessage'}}

registries = {}
xray = (args.source / 'infra/conf/xray.go').read_text(encoding='utf-8')
for direction in ('inbound', 'outbound'):
    body = re.search(direction + r'ConfigLoader = .*?ConfigCreatorCache\{(.*?)\n\s*\}', xray, re.S)[1]
    registry = {}
    for line in body.splitlines():
        entry = re.search(r'"([^"]+)".*?(?:new\((\w+)\)|&(\w+)\{)', line)
        if entry:
            registry[entry[1]] = entry[2] or entry[3]
    registries[direction] = registry

# JSONConfigLoader's discriminator is outside the decoded authenticator struct.
structures['HeaderType'] = {'fields': {'type': 'string'}}
structures['HTTPHeader'] = {'fields': {'type': 'string', **structures['Authenticator']['fields']}}
masks = {}
mask_source = (args.source / 'infra/conf/transport_finalmask.go').read_text(encoding='utf-8')
for kind, loader in [('tcp', 'tcpmaskLoader'), ('udp', 'udpmaskLoader')]:
    body = re.search(loader + r' = .*?ConfigCreatorCache\{(.*?)\n\s*\}', mask_source, re.S)[1]
    masks[kind] = dict(re.findall(r'"([^"\n]+)".*?new\((\w+)\)', body))
    assert masks[kind] and all(name in structures for name in masks[kind].values())

assert structures['RawFieldRule']['fields']['outboundTag'] == 'string'
assert len(registries['inbound']) == 13 and len(registries['outbound']) == 15
assert all(name in structures for registry in registries.values() for name in registry.values())
result = {
    'version': 1,
    'core': {k: pin[k] for k in ('version', 'sourceCommit', 'executableSha256')},
    'protocolSchemaSha256': hashlib.sha256(protocol_text.encode()).hexdigest(),
    'sourceFiles': files,
    'protocols': registries,
    'masks': masks,
    'structures': {name: spec['fields'] for name, spec in sorted(structures.items())},
}
output = args.root / 'src/graph/xrayConfigNames.json'
output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'structures': len(structures), 'fields': sum(len(s['fields']) for s in structures.values()), 'output': str(output)}))
