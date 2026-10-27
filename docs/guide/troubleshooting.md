# Troubleshooting

Read Runtime's stage/error, then Check/Validate. Confirm the matching complete
service is installed. Inspect missing resources, interfaces, capture conflicts
and unsupported conditions. For TUN check upstream/routes/DNS; for sharing check
remembered identities/intent. Windows Internet indicators do not prove a route.

For one failing app/destination: test the intended outbound and inspect exit
IP/interface; find it in Traffic log with filters reset. Present requests point
to rule/output issues; absent requests suggest capture, DNS or attribution.
Check explicit proxies and loopback resolver bypass. Existing connections may
outlive a change that breaks new ones. Ambiguous ownership differs from unmatched
traffic; shared clients have no host process identity.

## Logs and reports

Application logs has Sources/Levels with All/Reset. Pause affects display, not
collection. Open folder/Save diagnostics work without service connectivity.
Desktop logs: `%LOCALAPPDATA%\app.wayrill.desktop\Logs`.
Service/sharing: `%ProgramData%\Wayrill\Logs`. The installed owner can read logs;
protected profiles remain restricted. Logs rotate.

WinHTTP diagnostics must identify the selected channel: legacy machine and
advanced user/machine states are independent.

Reports should include app/core/Windows versions, time, steps and a minimal
sanitized graph. For lifecycle issues name sources and whether failure followed
Apply, Stop, update, reboot or network change. Export All components around it.
Review attachments for credentials, subscription tokens, paths and destinations.
Bulk masking is configurable; selected text stays raw. Do not publish a private
graph merely because it reproduces the problem.
