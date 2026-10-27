"""Regenerate defaults only after reviewing the pinned source audit.

The Go zero value is the fallback for unchanged scalar fields. Build(), runtime,
platform, required-field and context-dependent exceptions are explicitly audited
in core-defaults-audit.json; this is intentionally not a regex inference of Go.
"""
from pathlib import Path
import argparse, hashlib, json, re, subprocess

root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',type=Path,required=True)
parser.add_argument('--check',action='store_true')
args=parser.parse_args()
audit_bytes=(root/'tools/core-defaults-audit.json').read_bytes()
audit=json.loads(audit_bytes)
deps=json.loads((root/'service/dependencies.json').read_text())['xray']
if deps['version']!=audit['coreVersion'] or deps['executableSha256'].lower()!=audit['executableSha256'] or deps.get('sourceCommit')!=audit['sourceCommit']:
    raise SystemExit('Core pin changed. Audit defaults before updating the embedded Xray core.')
commit=subprocess.check_output(['git','-C',str(args.source),'rev-parse','HEAD'],text=True).strip()
if commit!=audit['sourceCommit']:raise SystemExit('The source checkout does not match the defaults audit.')
for name,digest in audit['auditedFiles'].items():
    p=args.source/name
    if not p.is_file() or hashlib.sha256(p.read_bytes().replace(b'\r\n',b'\n')).hexdigest()!=digest:
        raise SystemExit('Source changed; review the defaults audit: '+name)
schema_bytes=(root/'src/graph/protocolSource.ts').read_bytes().replace(b'\r\n',b'\n')
text=schema_bytes.decode('utf-8')
schema=json.loads(text[text.index('{'):text.rindex('}')+1])
fields={}
for structure,spec in schema.items():
    for field in spec['fields']:
        go=field['goType']
        if go=='bool': entry={'value':False,'hint':'Disabled'}
        elif re.fullmatch(r'u?int(?:8|16|32|64)?|byte',go):entry={'value':0,'hint':'0'}
        elif go=='string':entry={'value':'','hint':'Empty — no value'}
        elif go.startswith('[]') or go.lstrip('*')=='StringList':entry={'hint':'None — empty list'}
        else:entry={'hint':'Not configured'}
        file=spec['file'].split(' + ')[0]
        entry['sources']=['infra/conf/'+file]
        key=structure+'.'+field['key']
        entry.update(audit['overrides'].get(key,{}))
        fields[key]=entry
for key,value in audit['overrides'].items():
    if key.split('.')[0] in schema and key not in fields:raise SystemExit('Unknown audited field: '+key)
    if key not in fields:fields[key]=value|{'sources':value.get('sources',['infra/conf/'+({'DNSConfig':'dns.go','NameServerConfig':'dns.go','Policy':'policy.go','SystemPolicy':'policy.go','LogConfig':'log.go','RouterConfig':'router.go','MetricsConfig':'metrics.go','FragmentMask':'transport_finalmask.go','UDPHop':'transport_finalmask.go'}.get(key.split('.')[0],'xray.go'))])}
for entry in fields.values():
    for name in entry['sources']:
        if name not in audit.get('externalSources',{}) and not (args.source/name).is_file():raise SystemExit('Missing provenance: '+name)
for key,binding in audit['globals'].items():
    if binding['field'] not in fields:raise SystemExit('Uncatalogued global default: '+key)
result={'version':1,'core':{'version':audit['coreVersion'],'sourceCommit':commit,'executableSha256':audit['executableSha256'],'platform':audit['platform']},'auditSha256':hashlib.sha256(audit_bytes.replace(b'\r\n',b'\n')).hexdigest(),'schemaSha256':hashlib.sha256(schema_bytes).hexdigest(),'externalSources':audit.get('externalSources',{}),'fields':fields,'globals':audit['globals']}
generated=json.dumps(result,indent=2,ensure_ascii=False)+'\n'
target=root/'src/graph/xrayCoreDefaults.json'
if args.check:
    if not target.is_file() or target.read_text(encoding='utf-8')!=generated:raise SystemExit('Regenerate the Xray defaults store.')
else:target.write_text(generated,encoding='utf-8')
print(json.dumps({'core':audit['coreVersion'],'fields':len(fields),'globals':len(audit['globals']),'sourceFilesChecked':len(audit['auditedFiles']),'check':args.check}))
