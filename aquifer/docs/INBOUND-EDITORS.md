# Inbound editor maintenance

The forms in `RemoteInboundSettings.tsx` edit native Xray objects. `inboundFields.ts` owns their order, labels, applicability and validation. `ServerFields.tsx` renders optional values, lists, nested objects and ordered collections. Unconfigured controls never write defaults merely by opening the editor.

The protocol and property registry is pinned in `graph/xrayConfigNames.json`; default hints come from `graph/xrayCoreDefaults.json`. Server/client behavior was checked against the available upstream `infra/conf`, protocol handlers and transport listeners. When updating the model, review those implementations as well as the JSON structures: a property can deserialize successfully while doing nothing on an inbound.

| Protocol | Common settings | Less common settings |
| --- | --- | --- |
| VLESS | Decryption, default flow, connected User sets | Ordered fallbacks, test seed |
| VMess | Connected User sets | Dynamic-user default policy level |
| Trojan | Connected User sets, transport security | Ordered fallbacks |
| SOCKS / Mixed | Authentication, UDP, connected User sets | Advertised UDP address, policy level |
| HTTP | Connected User sets | Transparent HTTP requests, policy level |
| Shadowsocks | Cipher, server key or connected User sets, TCP/UDP | Policy level, user label |
| Tunnel / dokodemo-door | Destination address/port, TCP/UDP, original destination | Port map, policy level |
| WireGuard | Private key, interface addresses, peers and allowed IPs | MTU, peer endpoint/keepalive, labels/policy levels |
| Hysteria 2 | Connected User sets, Hysteria transport, TLS certificates | Version fields, UDP timeout, masquerade |
| MASQUE | Client prefixes, connected User sets, MASQUE transport and TLS | MTU |
| Linux TUN | Interface name/addresses, DNS and system routes | MTU, policy level |

Only the selected transport/security block is presented. Switching a transport retains dormant blocks. Server REALITY uses target, server names, private key and short IDs; client fingerprints/public keys are not server controls. TLS certificate entries support server file paths and inline PEM. gRPC's client-only authority, Multi mode and User-Agent are not exposed. TCP-only socket controls are omitted on UDP-only listeners. Windows TUN descriptions/WFP controls and WireGuard's client TUN/DNS/reserved-byte settings are not presented.

The existing User-set model remains the owner of multi-user credentials. The settings editor does not duplicate account lists. Manage users opens the assignment dialog over the mounted settings editor, preserving an unfinished inbound draft. It does not require saving or validating unrelated fields first. No editor action deploys a config or changes a server.

Server key generation and public-key derivation use WebCrypto X25519 locally. REALITY uses base64url; WireGuard uses padded base64. RFC 8410 PKCS#8 import allows the crypto provider to derive a public key for an existing private key. Keys are not logged or persisted by these helpers. Async results are ignored after unmount or competing edits. Older WebView2 versions may require entering keys manually.

The editor keeps tabs and actions visible while the form scrolls. Tab arrows/Home/End follow the tab pattern; validation keeps unresolved issues visible and directs focus to fields. Switching away from REALITY to an incompatible transport selects TLS and offers certificate fields, while preserving dormant REALITY settings. Referenced inbound tag removal and duplicate tags are rejected; renaming updates exact routing inboundTag references without broadening rules.

## Validation

- `RemoteSettings.test.tsx` exercises all protocols in the independently generated Xray registry, graph export after edits, optional-value removal, Unix sockets, aliases, numeric arrays, empty short IDs, server/client field applicability, sniffing checkboxes, credential handoff and error navigation.
- The private local snapshot harness additionally validates and round-trips the four previously audited real configurations. It decrypts snapshots in memory; do not print the configurations or package private fixtures.
- JSON stays available for extensions. Form validation checks common requirements and shapes, not certificate-file existence or the remote daemon's runtime environment.
