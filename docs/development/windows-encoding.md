# Windows encoding boundaries

Use Unicode Windows APIs/UTF-16 conversion for process, adapter, registry,
package/service and COM names. Named-pipe/worker frames and saved JSON use UTF-8.
Parse complete bounded frames, not independently decoded arbitrary byte chunks.

Native command output is a separate boundary. Windows PowerShell 5 can decode
Rust UTF-8 stdout using its console page; CLI JSON escapes non-ASCII UTF-16 units
so ConvertFrom-Json restores names/errors, including surrogate pairs. Do not
change the machine's code page to work around one boundary.

Decode command diagnostics using explicit UTF-8/BOM-marked UTF-16/OEM fallbacks
where required. Do not parse localized labels to infer settings: legacy WinHTTP
uses the Windows API, advanced channels extract their structured JSON and keep
scope explicit. Unknown formats fail without replacing settings from a guess.

Installer service operations use a fixed temporary BOM-marked UTF-16LE log.
NSIS obtains exit status through nsExec, then reads text with FileReadUTF16LE;
it does not feed localized messages through the plugin's legacy output decoder.
Clear the log before each operation and reject a missing result rather than
displaying stale success.

Regression inputs should cover Cyrillic, Chinese, Japanese, Persian and four-byte
emoji, byte boundaries in bounded reads, malformed UTF-8, paths with spaces and
localized errors. Fixture success is not certification of every Windows locale.
