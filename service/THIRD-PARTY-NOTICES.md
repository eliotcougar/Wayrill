# Networking components

The exact versions, upstream sources and hashes are recorded in dependencies.json
and the package manifests. Xray is built from the pinned upstream source under
MPL-2.0 with the initializer, shared patch and private TUN additions described in
[the inventory](../docs/development/xray-customizations.md). Complete corresponding
source and Go module pins are packaged in xray/source.zip and tun-core/source.zip.

WinDivert is the unmodified LGPL-3.0-or-later vendor distribution. Retain its
LICENSE/header and upstream source reference: https://github.com/basil00/WinDivert.
The runtime does not unload the shared driver as automatic cleanup. Wintun and
upstream notices come from the verified Xray vendor archive.

Capture and attribution are separate GPL-3.0-only Rust executables derived from
the v2rayN application-routing work identified in service/capture/provenance.json.
Their corresponding source, locked/vendored dependencies, notices and rebuild
instructions are in capture-source.zip. Neither .NET nor TraceEvent ships.

Original XTLS DATs are bundled. Optional Russian, Iranian and Chinese DATs are
downloaded when selected during fresh/clean installation. Their GPL notices are
in routing-assets. All are byte-identical to immutable upstream assets selected
by the manifest; no subset extraction is performed. Sources include XTLS,
RunetFreedom, Chocolate4U and Loyalsoldier; URLs/licenses belong to the manifest.

The adapted Tauri NSIS template retains its MIT license in
[installer notices](../docs/licenses/tauri-installer.md). gRPC dependency licenses
are retained in [gRPC notices](../docs/licenses/grpc.md). The HTTP test client uses
Windows WinHTTP rather than shipping curl/OpenSSL as a runtime dependency.

Checksums establish payload integrity, not code-signing identity. Preserve all
component licenses and corresponding source when redistributing packages.

## Subscription engine

The service embeds QuickJS-NG through rquickjs 0.14.0 (MIT). Sources and exact
versions/checksums are pinned by service/Cargo.lock:
https://github.com/DelSkayn/rquickjs and https://github.com/quickjs-ng/quickjs.
The fixed application bundle contains no subscription-provided executable code.
Unicode grapheme segmentation uses unicode-segmentation 1.13.3 (MIT/Apache-2.0):
https://github.com/unicode-rs/unicode-segmentation.

### rquickjs license

MIT License

Copyright (c) 2020 Mees Delzenne
Copyright (c) 2025 Rquickjs Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### QuickJS-NG license

The MIT License (MIT)

Copyright (c) 2017-2026 Fabrice Bellard
Copyright (c) 2017-2024 Charlie Gordon
Copyright (c) 2023-2026 Ben Noordhuis
Copyright (c) 2023-2026 Saúl Ibarra Corretgé

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

### unicode-segmentation MIT license

Copyright (c) 2015 The Rust Project Developers

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
