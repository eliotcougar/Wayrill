from pathlib import Path
import re, json, argparse, subprocess
parser=argparse.ArgumentParser(description='Regenerate the audited Xray protocol field catalogue.')
parser.add_argument('--source',type=Path,required=True,help='Pinned Xray-core checkout root')
parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parent.parent/'src/graph/protocolSource.ts')
args=parser.parse_args()
commit=subprocess.check_output(['git','-C',str(args.source),'rev-parse','HEAD'],text=True).strip()
if commit!='1b1647cd9ddf0abc34b981d4611fc03bcac1ca74':raise SystemExit('Audit a new core revision before regenerating the field catalogue.')
source=args.source/'infra/conf'
target=args.output
structs={}
for path in sorted(source.glob('*.go')):
    text=path.read_text(encoding='utf-8')
    for match in re.finditer(r'type (\w+) struct \{\n(.*?)\n\}',text,re.S):
        fields=[]
        for line in match[2].splitlines():
            field=re.search(r'^\s*\w+\s+(.+?)\s+`json:"([^",]*)(?:,[^"]*)?"`',line)
            if field and field[2]: fields.append({'key':field[2],'goType':field[1].strip()})
        if fields: structs[match[1]]={'file':path.name,'fields':fields}
# Account fields unmarshalled from protocol.User and native account messages.
structs['VLessUserConfig']={'file':'vless.go + proxy/vless/account.proto','fields':[
    {'key':k,'goType':t} for k,t in [('id','string'),('flow','string'),('testseed','[]uint32'),('reverse','json.RawMessage'),('level','uint32'),('email','string')]]}
structs['VMessUserConfig']={'file':'vmess.go + common/protocol/user.proto','fields':[
    {'key':k,'goType':t} for k,t in [('id','string'),('security','string'),('experiments','string'),('level','uint32'),('email','string')]]}
structs['VLessOutboundUserConfig']={'file':'vless.go + proxy/vless/account.proto','fields':[
    {'key':k,'goType':t} for k,t in [('id','string'),('flow','string'),('encryption','string'),('testpre','uint32'),('testseed','[]uint32'),('reverse','json.RawMessage'),('level','uint32'),('email','string')]]}
for account in ['HTTP','Socks']:
    structs[account+'UserConfig']={'file':account.lower()+'.go + common/protocol/user.proto','fields':[
        {'key':k,'goType':t} for k,t in [('user','string'),('pass','string'),('level','uint32'),('email','string')]]}
required=['DokodemoConfig','HTTPServerConfig','HTTPClientConfig','HTTPRemoteConfig','HTTPAccount',
'ShadowsocksServerConfig','ShadowsocksClientConfig','ShadowsocksUserConfig','ShadowsocksServerTarget',
'SocksServerConfig','SocksClientConfig','SocksRemoteConfig','SocksAccount','VLessInboundConfig','VLessOutboundConfig','VLessOutboundVnext','VLessInboundFallback','VLessUserConfig',
'VMessInboundConfig','VMessOutboundConfig','VMessOutboundTarget','VMessUserConfig','VMessDefaultConfig','TrojanServerConfig','TrojanClientConfig','TrojanServerTarget','TrojanUserConfig','TrojanInboundFallback',
'WireGuardConfig','WireGuardPeerConfig','HysteriaClientConfig','HysteriaServerConfig','HysteriaUserConfig','MasqueClientConfig','MasqueServerConfig','MasqueUserConfig','TunConfig','LoopbackConfig','DNSOutboundConfig','DNSOutboundRuleConfig',
'StreamConfig','SniffingConfig','MuxConfig','TCPConfig','SplitHTTPConfig','KCPConfig','GRPCConfig','WebSocketConfig','HttpUpgradeConfig','HysteriaConfig','MasqueConfig','MasqueWarpConfig','XDriveConfig','TLSConfig','TLSCertConfig','REALITYConfig','SocketConfig','HappyEyeballsConfig','CustomSockoptConfig','Masquerade','FreedomConfig','BlackholeConfig','FinalMask','Mask','QuicParamsConfig','VLessOutboundUserConfig','HTTPUserConfig','SocksUserConfig']
missing=[name for name in required if name not in structs]
if missing: raise SystemExit('Missing audited structures: '+repr(missing))
result={name:structs[name] for name in required}
target.write_text('// Generated from Xray-core 1b1647cd9ddf0abc34b981d4611fc03bcac1ca74.\n// Regenerate with the audited protocol-schema helper when upgrading the core.\nexport const protocolSource = '+json.dumps(result,indent=2)+' as const;\n',encoding='utf-8')
print(json.dumps({'structures':len(result),'fields':sum(len(v['fields']) for v in result.values()),'output':str(target)}))
