// Generated from Xray-core 0afec66085a85191e9dd2a4a6646c7c9a94688d1.
// Regenerate with the audited protocol-schema helper when upgrading the core.
export const protocolSource = {
  "DokodemoConfig": {
    "file": "dokodemo.go",
    "fields": [
      {
        "key": "allowedNetwork",
        "goType": "*NetworkList"
      },
      {
        "key": "rewriteAddress",
        "goType": "*Address"
      },
      {
        "key": "rewritePort",
        "goType": "uint16"
      },
      {
        "key": "network",
        "goType": "*NetworkList"
      },
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "portMap",
        "goType": "map[string]string"
      },
      {
        "key": "followRedirect",
        "goType": "bool"
      },
      {
        "key": "userLevel",
        "goType": "uint32"
      }
    ]
  },
  "HTTPServerConfig": {
    "file": "http.go",
    "fields": [
      {
        "key": "users",
        "goType": "[]*HTTPAccount"
      },
      {
        "key": "accounts",
        "goType": "[]*HTTPAccount"
      },
      {
        "key": "allowTransparent",
        "goType": "bool"
      },
      {
        "key": "userLevel",
        "goType": "uint32"
      }
    ]
  },
  "HTTPClientConfig": {
    "file": "http.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      },
      {
        "key": "user",
        "goType": "string"
      },
      {
        "key": "pass",
        "goType": "string"
      },
      {
        "key": "servers",
        "goType": "[]*HTTPRemoteConfig"
      },
      {
        "key": "headers",
        "goType": "map[string]string"
      }
    ]
  },
  "HTTPRemoteConfig": {
    "file": "http.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "users",
        "goType": "[]json.RawMessage"
      }
    ]
  },
  "HTTPAccount": {
    "file": "http.go",
    "fields": [
      {
        "key": "user",
        "goType": "string"
      },
      {
        "key": "pass",
        "goType": "string"
      }
    ]
  },
  "ShadowsocksServerConfig": {
    "file": "shadowsocks.go",
    "fields": [
      {
        "key": "method",
        "goType": "string"
      },
      {
        "key": "password",
        "goType": "string"
      },
      {
        "key": "level",
        "goType": "byte"
      },
      {
        "key": "email",
        "goType": "string"
      },
      {
        "key": "users",
        "goType": "[]*ShadowsocksUserConfig"
      },
      {
        "key": "clients",
        "goType": "[]*ShadowsocksUserConfig"
      },
      {
        "key": "network",
        "goType": "*NetworkList"
      }
    ]
  },
  "ShadowsocksClientConfig": {
    "file": "shadowsocks.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "level",
        "goType": "byte"
      },
      {
        "key": "email",
        "goType": "string"
      },
      {
        "key": "method",
        "goType": "string"
      },
      {
        "key": "password",
        "goType": "string"
      },
      {
        "key": "servers",
        "goType": "[]*ShadowsocksServerTarget"
      }
    ]
  },
  "ShadowsocksUserConfig": {
    "file": "shadowsocks.go",
    "fields": [
      {
        "key": "method",
        "goType": "string"
      },
      {
        "key": "password",
        "goType": "string"
      },
      {
        "key": "level",
        "goType": "byte"
      },
      {
        "key": "email",
        "goType": "string"
      },
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      }
    ]
  },
  "ShadowsocksServerTarget": {
    "file": "shadowsocks.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "level",
        "goType": "byte"
      },
      {
        "key": "email",
        "goType": "string"
      },
      {
        "key": "method",
        "goType": "string"
      },
      {
        "key": "password",
        "goType": "string"
      }
    ]
  },
  "SocksServerConfig": {
    "file": "socks.go",
    "fields": [
      {
        "key": "auth",
        "goType": "string"
      },
      {
        "key": "users",
        "goType": "[]*SocksAccount"
      },
      {
        "key": "accounts",
        "goType": "[]*SocksAccount"
      },
      {
        "key": "udp",
        "goType": "bool"
      },
      {
        "key": "ip",
        "goType": "*Address"
      },
      {
        "key": "userLevel",
        "goType": "uint32"
      }
    ]
  },
  "SocksClientConfig": {
    "file": "socks.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      },
      {
        "key": "user",
        "goType": "string"
      },
      {
        "key": "pass",
        "goType": "string"
      },
      {
        "key": "servers",
        "goType": "[]*SocksRemoteConfig"
      }
    ]
  },
  "SocksRemoteConfig": {
    "file": "socks.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "users",
        "goType": "[]json.RawMessage"
      }
    ]
  },
  "SocksAccount": {
    "file": "socks.go",
    "fields": [
      {
        "key": "user",
        "goType": "string"
      },
      {
        "key": "pass",
        "goType": "string"
      }
    ]
  },
  "VLessInboundConfig": {
    "file": "vless.go",
    "fields": [
      {
        "key": "users",
        "goType": "[]json.RawMessage"
      },
      {
        "key": "clients",
        "goType": "[]json.RawMessage"
      },
      {
        "key": "decryption",
        "goType": "string"
      },
      {
        "key": "fallbacks",
        "goType": "[]*VLessInboundFallback"
      },
      {
        "key": "flow",
        "goType": "string"
      },
      {
        "key": "testseed",
        "goType": "[]uint32"
      }
    ]
  },
  "VLessOutboundConfig": {
    "file": "vless.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      },
      {
        "key": "id",
        "goType": "string"
      },
      {
        "key": "flow",
        "goType": "string"
      },
      {
        "key": "seed",
        "goType": "string"
      },
      {
        "key": "encryption",
        "goType": "string"
      },
      {
        "key": "reverse",
        "goType": "*VLessReverseConfig"
      },
      {
        "key": "testpre",
        "goType": "uint32"
      },
      {
        "key": "testseed",
        "goType": "[]uint32"
      },
      {
        "key": "vnext",
        "goType": "[]*VLessOutboundVnext"
      }
    ]
  },
  "VLessOutboundVnext": {
    "file": "vless.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "users",
        "goType": "[]json.RawMessage"
      }
    ]
  },
  "VLessInboundFallback": {
    "file": "vless.go",
    "fields": [
      {
        "key": "name",
        "goType": "string"
      },
      {
        "key": "alpn",
        "goType": "string"
      },
      {
        "key": "path",
        "goType": "string"
      },
      {
        "key": "type",
        "goType": "string"
      },
      {
        "key": "dest",
        "goType": "json.RawMessage"
      },
      {
        "key": "xver",
        "goType": "uint64"
      }
    ]
  },
  "VLessUserConfig": {
    "file": "vless.go + proxy/vless/account.proto",
    "fields": [
      {
        "key": "id",
        "goType": "string"
      },
      {
        "key": "flow",
        "goType": "string"
      },
      {
        "key": "testseed",
        "goType": "[]uint32"
      },
      {
        "key": "reverse",
        "goType": "json.RawMessage"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      }
    ]
  },
  "VMessInboundConfig": {
    "file": "vmess.go",
    "fields": [
      {
        "key": "users",
        "goType": "[]json.RawMessage"
      },
      {
        "key": "clients",
        "goType": "[]json.RawMessage"
      },
      {
        "key": "default",
        "goType": "*VMessDefaultConfig"
      }
    ]
  },
  "VMessOutboundConfig": {
    "file": "vmess.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      },
      {
        "key": "id",
        "goType": "string"
      },
      {
        "key": "security",
        "goType": "string"
      },
      {
        "key": "experiments",
        "goType": "string"
      },
      {
        "key": "vnext",
        "goType": "[]*VMessOutboundTarget"
      }
    ]
  },
  "VMessOutboundTarget": {
    "file": "vmess.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "users",
        "goType": "[]json.RawMessage"
      }
    ]
  },
  "VMessUserConfig": {
    "file": "vmess.go + common/protocol/user.proto",
    "fields": [
      {
        "key": "id",
        "goType": "string"
      },
      {
        "key": "security",
        "goType": "string"
      },
      {
        "key": "experiments",
        "goType": "string"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      }
    ]
  },
  "VMessDefaultConfig": {
    "file": "vmess.go",
    "fields": [
      {
        "key": "level",
        "goType": "byte"
      }
    ]
  },
  "TrojanServerConfig": {
    "file": "trojan.go",
    "fields": [
      {
        "key": "users",
        "goType": "[]*TrojanUserConfig"
      },
      {
        "key": "clients",
        "goType": "[]*TrojanUserConfig"
      },
      {
        "key": "fallbacks",
        "goType": "[]*TrojanInboundFallback"
      }
    ]
  },
  "TrojanClientConfig": {
    "file": "trojan.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "level",
        "goType": "byte"
      },
      {
        "key": "email",
        "goType": "string"
      },
      {
        "key": "password",
        "goType": "string"
      },
      {
        "key": "flow",
        "goType": "string"
      },
      {
        "key": "servers",
        "goType": "[]*TrojanServerTarget"
      }
    ]
  },
  "TrojanServerTarget": {
    "file": "trojan.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "level",
        "goType": "byte"
      },
      {
        "key": "email",
        "goType": "string"
      },
      {
        "key": "password",
        "goType": "string"
      },
      {
        "key": "flow",
        "goType": "string"
      }
    ]
  },
  "TrojanUserConfig": {
    "file": "trojan.go",
    "fields": [
      {
        "key": "password",
        "goType": "string"
      },
      {
        "key": "level",
        "goType": "byte"
      },
      {
        "key": "email",
        "goType": "string"
      },
      {
        "key": "flow",
        "goType": "string"
      }
    ]
  },
  "TrojanInboundFallback": {
    "file": "trojan.go",
    "fields": [
      {
        "key": "name",
        "goType": "string"
      },
      {
        "key": "alpn",
        "goType": "string"
      },
      {
        "key": "path",
        "goType": "string"
      },
      {
        "key": "type",
        "goType": "string"
      },
      {
        "key": "dest",
        "goType": "json.RawMessage"
      },
      {
        "key": "xver",
        "goType": "uint64"
      }
    ]
  },
  "WireGuardConfig": {
    "file": "wireguard.go",
    "fields": [
      {
        "key": "noKernelTun",
        "goType": "bool"
      },
      {
        "key": "secretKey",
        "goType": "string"
      },
      {
        "key": "address",
        "goType": "[]string"
      },
      {
        "key": "peers",
        "goType": "[]*WireGuardPeerConfig"
      },
      {
        "key": "mtu",
        "goType": "int32"
      },
      {
        "key": "reserved",
        "goType": "[]byte"
      },
      {
        "key": "remoteDNS",
        "goType": "[]string"
      }
    ]
  },
  "WireGuardPeerConfig": {
    "file": "wireguard.go",
    "fields": [
      {
        "key": "publicKey",
        "goType": "string"
      },
      {
        "key": "preSharedKey",
        "goType": "string"
      },
      {
        "key": "endpoint",
        "goType": "string"
      },
      {
        "key": "keepAlive",
        "goType": "uint32"
      },
      {
        "key": "allowedIPs",
        "goType": "[]string"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      }
    ]
  },
  "HysteriaClientConfig": {
    "file": "hysteria.go",
    "fields": [
      {
        "key": "version",
        "goType": "int32"
      },
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      }
    ]
  },
  "HysteriaServerConfig": {
    "file": "hysteria.go",
    "fields": [
      {
        "key": "version",
        "goType": "int32"
      },
      {
        "key": "users",
        "goType": "[]*HysteriaUserConfig"
      },
      {
        "key": "clients",
        "goType": "[]*HysteriaUserConfig"
      }
    ]
  },
  "HysteriaUserConfig": {
    "file": "hysteria.go",
    "fields": [
      {
        "key": "auth",
        "goType": "string"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      }
    ]
  },
  "MasqueClientConfig": {
    "file": "masque.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "remoteDNS",
        "goType": "[]string"
      }
    ]
  },
  "MasqueServerConfig": {
    "file": "masque.go",
    "fields": [
      {
        "key": "users",
        "goType": "[]*MasqueUserConfig"
      },
      {
        "key": "clients",
        "goType": "[]*MasqueUserConfig"
      },
      {
        "key": "address",
        "goType": "[]string"
      },
      {
        "key": "mtu",
        "goType": "uint32"
      }
    ]
  },
  "MasqueUserConfig": {
    "file": "masque.go",
    "fields": [
      {
        "key": "pass",
        "goType": "string"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      }
    ]
  },
  "TunConfig": {
    "file": "tun.go",
    "fields": [
      {
        "key": "name",
        "goType": "string"
      },
      {
        "key": "desc",
        "goType": "string"
      },
      {
        "key": "mtu",
        "goType": "uint32"
      },
      {
        "key": "gateway",
        "goType": "[]string"
      },
      {
        "key": "dns",
        "goType": "[]string"
      },
      {
        "key": "userLevel",
        "goType": "uint32"
      },
      {
        "key": "autoSystemRoutingTable",
        "goType": "[]string"
      },
      {
        "key": "autoOutboundsInterface",
        "goType": "*string"
      },
      {
        "key": "autoSystemDnsToGateway",
        "goType": "bool"
      },
      {
        "key": "autoSystemWfpBlockLeak",
        "goType": "[]string"
      }
    ]
  },
  "LoopbackConfig": {
    "file": "loopback.go",
    "fields": [
      {
        "key": "inboundTag",
        "goType": "string"
      },
      {
        "key": "sniffing",
        "goType": "*SniffingConfig"
      }
    ]
  },
  "DNSOutboundConfig": {
    "file": "dns_proxy.go",
    "fields": [
      {
        "key": "rewriteNetwork",
        "goType": "Network"
      },
      {
        "key": "rewriteAddress",
        "goType": "*Address"
      },
      {
        "key": "rewritePort",
        "goType": "uint16"
      },
      {
        "key": "network",
        "goType": "Network"
      },
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "userLevel",
        "goType": "uint32"
      },
      {
        "key": "rules",
        "goType": "[]*DNSOutboundRuleConfig"
      },
      {
        "key": "nonIPQuery",
        "goType": "*string"
      },
      {
        "key": "blockTypes",
        "goType": "*[]int32"
      }
    ]
  },
  "DNSOutboundRuleConfig": {
    "file": "dns_proxy.go",
    "fields": [
      {
        "key": "action",
        "goType": "string"
      },
      {
        "key": "qType",
        "goType": "*PortList"
      },
      {
        "key": "domain",
        "goType": "*StringList"
      },
      {
        "key": "rCode",
        "goType": "uint32"
      }
    ]
  },
  "StreamConfig": {
    "file": "transport_internet.go",
    "fields": [
      {
        "key": "address",
        "goType": "*Address"
      },
      {
        "key": "port",
        "goType": "uint16"
      },
      {
        "key": "method",
        "goType": "*TransportProtocol"
      },
      {
        "key": "network",
        "goType": "*TransportProtocol"
      },
      {
        "key": "security",
        "goType": "string"
      },
      {
        "key": "finalmask",
        "goType": "*FinalMask"
      },
      {
        "key": "tlsSettings",
        "goType": "*TLSConfig"
      },
      {
        "key": "realitySettings",
        "goType": "*REALITYConfig"
      },
      {
        "key": "rawSettings",
        "goType": "*TCPConfig"
      },
      {
        "key": "tcpSettings",
        "goType": "*TCPConfig"
      },
      {
        "key": "xhttpSettings",
        "goType": "*SplitHTTPConfig"
      },
      {
        "key": "splithttpSettings",
        "goType": "*SplitHTTPConfig"
      },
      {
        "key": "kcpSettings",
        "goType": "*KCPConfig"
      },
      {
        "key": "grpcSettings",
        "goType": "*GRPCConfig"
      },
      {
        "key": "wsSettings",
        "goType": "*WebSocketConfig"
      },
      {
        "key": "httpupgradeSettings",
        "goType": "*HttpUpgradeConfig"
      },
      {
        "key": "hysteriaSettings",
        "goType": "*HysteriaConfig"
      },
      {
        "key": "masqueSettings",
        "goType": "*MasqueConfig"
      },
      {
        "key": "xdriveSettings",
        "goType": "*XDriveConfig"
      },
      {
        "key": "sockopt",
        "goType": "*SocketConfig"
      }
    ]
  },
  "SniffingConfig": {
    "file": "xray.go",
    "fields": [
      {
        "key": "enabled",
        "goType": "bool"
      },
      {
        "key": "destOverride",
        "goType": "StringList"
      },
      {
        "key": "domainsExcluded",
        "goType": "StringList"
      },
      {
        "key": "ipsExcluded",
        "goType": "StringList"
      },
      {
        "key": "metadataOnly",
        "goType": "bool"
      },
      {
        "key": "routeOnly",
        "goType": "bool"
      }
    ]
  },
  "MuxConfig": {
    "file": "xray.go",
    "fields": [
      {
        "key": "enabled",
        "goType": "bool"
      },
      {
        "key": "concurrency",
        "goType": "int16"
      },
      {
        "key": "xudpConcurrency",
        "goType": "int16"
      },
      {
        "key": "xudpProxyUDP443",
        "goType": "string"
      }
    ]
  },
  "TCPConfig": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "header",
        "goType": "json.RawMessage"
      },
      {
        "key": "acceptProxyProtocol",
        "goType": "bool"
      }
    ]
  },
  "SplitHTTPConfig": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "host",
        "goType": "string"
      },
      {
        "key": "path",
        "goType": "string"
      },
      {
        "key": "mode",
        "goType": "string"
      },
      {
        "key": "headers",
        "goType": "map[string]string"
      },
      {
        "key": "xPaddingBytes",
        "goType": "Int32Range"
      },
      {
        "key": "xPaddingObfsMode",
        "goType": "bool"
      },
      {
        "key": "xPaddingKey",
        "goType": "string"
      },
      {
        "key": "xPaddingHeader",
        "goType": "string"
      },
      {
        "key": "xPaddingPlacement",
        "goType": "string"
      },
      {
        "key": "xPaddingMethod",
        "goType": "string"
      },
      {
        "key": "uplinkHTTPMethod",
        "goType": "string"
      },
      {
        "key": "sessionIDPlacement",
        "goType": "string"
      },
      {
        "key": "sessionIDKey",
        "goType": "string"
      },
      {
        "key": "sessionIDTable",
        "goType": "string"
      },
      {
        "key": "sessionIDLength",
        "goType": "Int32Range"
      },
      {
        "key": "seqPlacement",
        "goType": "string"
      },
      {
        "key": "seqKey",
        "goType": "string"
      },
      {
        "key": "uplinkDataPlacement",
        "goType": "string"
      },
      {
        "key": "uplinkDataKey",
        "goType": "string"
      },
      {
        "key": "uplinkChunkSize",
        "goType": "Int32Range"
      },
      {
        "key": "noGRPCHeader",
        "goType": "bool"
      },
      {
        "key": "noSSEHeader",
        "goType": "bool"
      },
      {
        "key": "scMaxEachPostBytes",
        "goType": "Int32Range"
      },
      {
        "key": "scMinPostsIntervalMs",
        "goType": "Int32Range"
      },
      {
        "key": "scMaxBufferedPosts",
        "goType": "int64"
      },
      {
        "key": "scStreamUpServerSecs",
        "goType": "Int32Range"
      },
      {
        "key": "serverMaxHeaderBytes",
        "goType": "int32"
      },
      {
        "key": "xmux",
        "goType": "XmuxConfig"
      },
      {
        "key": "downloadSettings",
        "goType": "*StreamConfig"
      },
      {
        "key": "extra",
        "goType": "json.RawMessage"
      }
    ]
  },
  "KCPConfig": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "mtu",
        "goType": "*uint32"
      },
      {
        "key": "tti",
        "goType": "*uint32"
      },
      {
        "key": "uplinkCapacity",
        "goType": "*uint32"
      },
      {
        "key": "downlinkCapacity",
        "goType": "*uint32"
      },
      {
        "key": "cwndMultiplier",
        "goType": "*uint32"
      },
      {
        "key": "maxSendingWindow",
        "goType": "*uint32"
      },
      {
        "key": "header",
        "goType": "json.RawMessage"
      },
      {
        "key": "seed",
        "goType": "*string"
      }
    ]
  },
  "GRPCConfig": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "authority",
        "goType": "string"
      },
      {
        "key": "serviceName",
        "goType": "string"
      },
      {
        "key": "multiMode",
        "goType": "bool"
      },
      {
        "key": "idle_timeout",
        "goType": "int32"
      },
      {
        "key": "health_check_timeout",
        "goType": "int32"
      },
      {
        "key": "permit_without_stream",
        "goType": "bool"
      },
      {
        "key": "initial_windows_size",
        "goType": "int32"
      },
      {
        "key": "user_agent",
        "goType": "string"
      }
    ]
  },
  "WebSocketConfig": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "host",
        "goType": "string"
      },
      {
        "key": "path",
        "goType": "string"
      },
      {
        "key": "headers",
        "goType": "map[string]string"
      },
      {
        "key": "acceptProxyProtocol",
        "goType": "bool"
      },
      {
        "key": "heartbeatPeriod",
        "goType": "uint32"
      }
    ]
  },
  "HttpUpgradeConfig": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "host",
        "goType": "string"
      },
      {
        "key": "path",
        "goType": "string"
      },
      {
        "key": "headers",
        "goType": "map[string]string"
      },
      {
        "key": "acceptProxyProtocol",
        "goType": "bool"
      }
    ]
  },
  "HysteriaConfig": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "version",
        "goType": "int32"
      },
      {
        "key": "auth",
        "goType": "string"
      },
      {
        "key": "udpIdleTimeout",
        "goType": "int64"
      },
      {
        "key": "masquerade",
        "goType": "Masquerade"
      }
    ]
  },
  "MasqueConfig": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "host",
        "goType": "string"
      },
      {
        "key": "path",
        "goType": "string"
      },
      {
        "key": "user",
        "goType": "string"
      },
      {
        "key": "pass",
        "goType": "string"
      },
      {
        "key": "headers",
        "goType": "map[string]string"
      },
      {
        "key": "warp",
        "goType": "*MasqueWarpConfig"
      },
      {
        "key": "xmux",
        "goType": "XmuxConfig"
      }
    ]
  },
  "MasqueWarpConfig": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "privateKey",
        "goType": "string"
      },
      {
        "key": "publicKey",
        "goType": "string"
      },
      {
        "key": "address",
        "goType": "[]string"
      }
    ]
  },
  "XDriveConfig": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "remoteFolder",
        "goType": "string"
      },
      {
        "key": "service",
        "goType": "string"
      },
      {
        "key": "secrets",
        "goType": "[]string"
      },
      {
        "key": "segmentBytes",
        "goType": "uint32"
      },
      {
        "key": "flushIntervalMs",
        "goType": "uint32"
      },
      {
        "key": "pollIntervalMs",
        "goType": "uint32"
      },
      {
        "key": "maxPollIntervalMs",
        "goType": "uint32"
      },
      {
        "key": "sessionTtlSeconds",
        "goType": "uint32"
      },
      {
        "key": "concurrency",
        "goType": "uint32"
      },
      {
        "key": "eagerWindowMs",
        "goType": "uint32"
      },
      {
        "key": "holeTimeoutMs",
        "goType": "uint32"
      },
      {
        "key": "template",
        "goType": "json.RawMessage"
      },
      {
        "key": "s3",
        "goType": "*XDriveS3Config"
      },
      {
        "key": "xmux",
        "goType": "XmuxConfig"
      }
    ]
  },
  "TLSConfig": {
    "file": "transport_security.go",
    "fields": [
      {
        "key": "allowInsecure",
        "goType": "bool"
      },
      {
        "key": "certificates",
        "goType": "[]*TLSCertConfig"
      },
      {
        "key": "serverName",
        "goType": "string"
      },
      {
        "key": "alpn",
        "goType": "*StringList"
      },
      {
        "key": "enableSessionResumption",
        "goType": "bool"
      },
      {
        "key": "disableSystemRoot",
        "goType": "bool"
      },
      {
        "key": "minVersion",
        "goType": "string"
      },
      {
        "key": "maxVersion",
        "goType": "string"
      },
      {
        "key": "cipherSuites",
        "goType": "string"
      },
      {
        "key": "fingerprint",
        "goType": "string"
      },
      {
        "key": "rejectUnknownSni",
        "goType": "bool"
      },
      {
        "key": "curvePreferences",
        "goType": "*StringList"
      },
      {
        "key": "masterKeyLog",
        "goType": "string"
      },
      {
        "key": "pinnedPeerCertSha256",
        "goType": "string"
      },
      {
        "key": "verifyPeerCertByName",
        "goType": "string"
      },
      {
        "key": "echServerKeys",
        "goType": "string"
      },
      {
        "key": "echConfigList",
        "goType": "string"
      },
      {
        "key": "echSockopt",
        "goType": "*SocketConfig"
      },
      {
        "key": "useSystemCA",
        "goType": "bool"
      }
    ]
  },
  "TLSCertConfig": {
    "file": "transport_security.go",
    "fields": [
      {
        "key": "certificateFile",
        "goType": "string"
      },
      {
        "key": "certificate",
        "goType": "[]string"
      },
      {
        "key": "keyFile",
        "goType": "string"
      },
      {
        "key": "key",
        "goType": "[]string"
      },
      {
        "key": "usage",
        "goType": "string"
      },
      {
        "key": "ocspStapling",
        "goType": "uint64"
      },
      {
        "key": "oneTimeLoading",
        "goType": "bool"
      },
      {
        "key": "buildChain",
        "goType": "bool"
      }
    ]
  },
  "REALITYConfig": {
    "file": "transport_security.go",
    "fields": [
      {
        "key": "masterKeyLog",
        "goType": "string"
      },
      {
        "key": "show",
        "goType": "bool"
      },
      {
        "key": "target",
        "goType": "json.RawMessage"
      },
      {
        "key": "dest",
        "goType": "json.RawMessage"
      },
      {
        "key": "type",
        "goType": "string"
      },
      {
        "key": "xver",
        "goType": "uint64"
      },
      {
        "key": "serverNames",
        "goType": "[]string"
      },
      {
        "key": "privateKey",
        "goType": "string"
      },
      {
        "key": "minClientVer",
        "goType": "string"
      },
      {
        "key": "maxClientVer",
        "goType": "string"
      },
      {
        "key": "maxTimeDiff",
        "goType": "uint64"
      },
      {
        "key": "shortIds",
        "goType": "[]string"
      },
      {
        "key": "mldsa65Seed",
        "goType": "string"
      },
      {
        "key": "limitFallbackUpload",
        "goType": "LimitFallback"
      },
      {
        "key": "limitFallbackDownload",
        "goType": "LimitFallback"
      },
      {
        "key": "fingerprint",
        "goType": "string"
      },
      {
        "key": "serverName",
        "goType": "string"
      },
      {
        "key": "password",
        "goType": "string"
      },
      {
        "key": "publicKey",
        "goType": "string"
      },
      {
        "key": "shortId",
        "goType": "string"
      },
      {
        "key": "mldsa65Verify",
        "goType": "string"
      },
      {
        "key": "spiderX",
        "goType": "string"
      }
    ]
  },
  "SocketConfig": {
    "file": "transport_sockopt.go",
    "fields": [
      {
        "key": "mark",
        "goType": "int32"
      },
      {
        "key": "tcpFastOpen",
        "goType": "interface{}"
      },
      {
        "key": "tproxy",
        "goType": "string"
      },
      {
        "key": "acceptProxyProtocol",
        "goType": "bool"
      },
      {
        "key": "domainStrategy",
        "goType": "string"
      },
      {
        "key": "dialerProxy",
        "goType": "string"
      },
      {
        "key": "tcpKeepAliveInterval",
        "goType": "int32"
      },
      {
        "key": "tcpKeepAliveIdle",
        "goType": "int32"
      },
      {
        "key": "tcpCongestion",
        "goType": "string"
      },
      {
        "key": "tcpWindowClamp",
        "goType": "int32"
      },
      {
        "key": "tcpMaxSeg",
        "goType": "int32"
      },
      {
        "key": "penetrate",
        "goType": "bool"
      },
      {
        "key": "tcpUserTimeout",
        "goType": "int32"
      },
      {
        "key": "v6only",
        "goType": "bool"
      },
      {
        "key": "interface",
        "goType": "string"
      },
      {
        "key": "tcpMptcp",
        "goType": "bool"
      },
      {
        "key": "customSockopt",
        "goType": "[]*CustomSockoptConfig"
      },
      {
        "key": "addressPortStrategy",
        "goType": "string"
      },
      {
        "key": "happyEyeballs",
        "goType": "*HappyEyeballsConfig"
      },
      {
        "key": "trustedXForwardedFor",
        "goType": "[]string"
      }
    ]
  },
  "HappyEyeballsConfig": {
    "file": "transport_sockopt.go",
    "fields": [
      {
        "key": "prioritizeIPv6",
        "goType": "bool"
      },
      {
        "key": "tryDelayMs",
        "goType": "uint64"
      },
      {
        "key": "interleave",
        "goType": "uint32"
      },
      {
        "key": "maxConcurrentTry",
        "goType": "uint32"
      }
    ]
  },
  "CustomSockoptConfig": {
    "file": "transport_sockopt.go",
    "fields": [
      {
        "key": "system",
        "goType": "string"
      },
      {
        "key": "network",
        "goType": "string"
      },
      {
        "key": "level",
        "goType": "string"
      },
      {
        "key": "opt",
        "goType": "string"
      },
      {
        "key": "value",
        "goType": "string"
      },
      {
        "key": "type",
        "goType": "string"
      }
    ]
  },
  "Masquerade": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "type",
        "goType": "string"
      },
      {
        "key": "dir",
        "goType": "string"
      },
      {
        "key": "url",
        "goType": "string"
      },
      {
        "key": "rewriteHost",
        "goType": "bool"
      },
      {
        "key": "xForwarded",
        "goType": "bool"
      },
      {
        "key": "insecure",
        "goType": "bool"
      },
      {
        "key": "content",
        "goType": "string"
      },
      {
        "key": "headers",
        "goType": "map[string]string"
      },
      {
        "key": "statusCode",
        "goType": "int32"
      }
    ]
  },
  "FreedomConfig": {
    "file": "freedom.go",
    "fields": [
      {
        "key": "targetStrategy",
        "goType": "string"
      },
      {
        "key": "domainStrategy",
        "goType": "string"
      },
      {
        "key": "redirect",
        "goType": "string"
      },
      {
        "key": "userLevel",
        "goType": "uint32"
      },
      {
        "key": "fragment",
        "goType": "*Fragment"
      },
      {
        "key": "noise",
        "goType": "*Noise"
      },
      {
        "key": "noises",
        "goType": "[]*Noise"
      },
      {
        "key": "proxyProtocol",
        "goType": "uint32"
      },
      {
        "key": "ipsBlocked",
        "goType": "*StringList"
      },
      {
        "key": "finalRules",
        "goType": "[]*FreedomFinalRuleConfig"
      }
    ]
  },
  "BlackholeConfig": {
    "file": "blackhole.go",
    "fields": [
      {
        "key": "response",
        "goType": "*ResponseConfig"
      }
    ]
  },
  "FinalMask": {
    "file": "transport_finalmask.go",
    "fields": [
      {
        "key": "tcp",
        "goType": "[]Mask"
      },
      {
        "key": "udp",
        "goType": "[]Mask"
      },
      {
        "key": "quicParams",
        "goType": "*QuicParamsConfig"
      }
    ]
  },
  "Mask": {
    "file": "transport_finalmask.go",
    "fields": [
      {
        "key": "type",
        "goType": "string"
      },
      {
        "key": "settings",
        "goType": "*json.RawMessage"
      }
    ]
  },
  "QuicParamsConfig": {
    "file": "transport_finalmask.go",
    "fields": [
      {
        "key": "congestion",
        "goType": "string"
      },
      {
        "key": "debug",
        "goType": "bool"
      },
      {
        "key": "bbrProfile",
        "goType": "string"
      },
      {
        "key": "brutalUp",
        "goType": "Bandwidth"
      },
      {
        "key": "brutalDown",
        "goType": "Bandwidth"
      },
      {
        "key": "brutalDisableLossCompensation",
        "goType": "bool"
      },
      {
        "key": "initStreamReceiveWindow",
        "goType": "uint64"
      },
      {
        "key": "maxStreamReceiveWindow",
        "goType": "uint64"
      },
      {
        "key": "initConnectionReceiveWindow",
        "goType": "uint64"
      },
      {
        "key": "maxConnectionReceiveWindow",
        "goType": "uint64"
      },
      {
        "key": "maxIdleTimeout",
        "goType": "int64"
      },
      {
        "key": "keepAlivePeriod",
        "goType": "int64"
      },
      {
        "key": "disablePathMTUDiscovery",
        "goType": "bool"
      },
      {
        "key": "disableChromeParrot",
        "goType": "bool"
      },
      {
        "key": "disableGSO",
        "goType": "bool"
      },
      {
        "key": "maxIncomingStreams",
        "goType": "int64"
      },
      {
        "key": "disableStatelessReset",
        "goType": "bool"
      }
    ]
  },
  "VLessOutboundUserConfig": {
    "file": "vless.go + proxy/vless/account.proto",
    "fields": [
      {
        "key": "id",
        "goType": "string"
      },
      {
        "key": "flow",
        "goType": "string"
      },
      {
        "key": "encryption",
        "goType": "string"
      },
      {
        "key": "testpre",
        "goType": "uint32"
      },
      {
        "key": "testseed",
        "goType": "[]uint32"
      },
      {
        "key": "reverse",
        "goType": "json.RawMessage"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      }
    ]
  },
  "HTTPUserConfig": {
    "file": "http.go + common/protocol/user.proto",
    "fields": [
      {
        "key": "user",
        "goType": "string"
      },
      {
        "key": "pass",
        "goType": "string"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      }
    ]
  },
  "SocksUserConfig": {
    "file": "socks.go + common/protocol/user.proto",
    "fields": [
      {
        "key": "user",
        "goType": "string"
      },
      {
        "key": "pass",
        "goType": "string"
      },
      {
        "key": "level",
        "goType": "uint32"
      },
      {
        "key": "email",
        "goType": "string"
      }
    ]
  },
  "XDriveS3Config": {
    "file": "transport_method.go",
    "fields": [
      {
        "key": "endpoint",
        "goType": "string"
      },
      {
        "key": "region",
        "goType": "string"
      },
      {
        "key": "bucket",
        "goType": "string"
      },
      {
        "key": "pathStyle",
        "goType": "*bool"
      }
    ]
  }
} as const;
