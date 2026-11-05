# Conventional configuration forms

The editor presents the task rather than the JSON object tree. It does not ask users to create `settings`, `streamSettings`, `log`, or other native properties before editing a field. The old recursive property builder and its unused numeric-input component/styles have been removed.

## Forms

| Editor | Primary controls |
| --- | --- |
| Core settings | Logging; Routing; Connections; Statistics & API; Resources; Advanced |
| Outbound | Server and credentials; Transport & security where applicable; connection, chain, mux and socket options |
| DNS handler | General options; resolver list; static hosts; Advanced |
| DNS server | Address, port, preferred domains, expected IPs and inherited options |
| Observatory | Probe settings; candidate selection and preview |
| Policy group | Candidate selection, strategy, fallback; named least-load tuning fields |

Common fields are visible without adding properties. Native enumeration names have descriptive labels where their behavior is otherwise unclear. Enable switches govern optional subsystems. Add/Remove actions operate on actual items, such as servers, policy levels, resource files and FakeDNS pools. Optional fields use a reset-to-default action instead of a trash icon. Standard tabs remain navigable while a draft is incomplete; validation directs the user to the relevant section and field.

A single-section editor has no redundant tab strip. Simple outbounds do not offer unrelated transport controls. Per-user counters can enable their statistics prerequisite in place. The Properties pane reserves its space while visible, including when nothing is selected, so selecting a node does not move or cover it halfway through a double-click.

## Configuration preservation

- Opening a form, visiting its tabs and saving without edits preserves the imported configuration exactly. Defaults are hints, not generated data.
- Local editors retain imported property spelling; compiled Xray exports use canonical property capitalization. Dictionary keys such as environment-variable names remain exact.
- Unknown and currently dormant options survive edits to neighboring fields. JSON is an explicit fallback for those options.
- Compact DNS strings and single-object FakeDNS pools remain unchanged on a no-op save. Adding DNS options or an additional pool changes their shape deliberately.
- Optional subsystems retain their draft values when disabled and re-enabled within a dialog. Cancelling retains the existing unsaved-draft confirmation.
- API tag renames update routing references. Dedicated API listeners and their internal routes are edited through Core settings and hidden from the normal graph. Disabling API removes only its dedicated plumbing; ambiguous listeners that also serve ordinary traffic remain visible and protected.

## Xray-specific details

Xray distinguishes an absent logging block (access logging off) from an empty block (access logging to console). Creating a log block through another setting preserves the original disabled access log. Choosing a File destination offers an explicit server path, and a blank file path is reported rather than silently becoming console logging.

Connection buffer defaults depend on the Linux server and its environment, so the form does not claim the main Windows application's buffer size as the server default. Core resource schedules use server time. Settings do not activate or deploy a server configuration; Apply changes edits the local draft only.

The forms use the existing field renderer, with an ordered presentation registry in `settingsFields.ts`. Core subsystem controls live in `RemoteCoreSettings.tsx`; protocol, DNS and observatory organization lives in `RemoteNodeSettings.tsx`. Inbound forms continue to use their existing server-specific registry. These are presentation layers over native JSON, not new configuration formats.

Logging semantics, connection-policy limits, resource scheduling, probe defaults and REALITY alias precedence were checked against Xray 26.10.29, source commit `0afec66085a85191e9dd2a4a6646c7c9a94688d1`. Recheck these hints and precedence rules when updating the schema/core reference. Form tests also compare native field names with the existing imported schema; unfamiliar newer options remain available through JSON.

## Shared dimensions and setup

Core settings uses the main app's 1050 by 760 dialog; node and User set editors use 1060 by 730; Stash uses 1120 by 840; Server status uses 1080 by 740. All shrink to the viewport. Ordinary setup/help dialogs use the main app's 490-pixel width, 36-pixel controls and consistent headers/footers. WinSCP setup is a separate dialog under Settings; changing its executable or session store preserves the loaded graph draft.
