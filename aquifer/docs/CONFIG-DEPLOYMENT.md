# Configuration deployment

Read a server configuration, edit its graph, then open **Apply…**, or use **Validate on server…** after Check. Applying a local/new draft first reads the displayed remote target path, preserving the draft while capturing the actual source and companion hashes. Server-side validation and explicit confirmation still precede every mutation. The server/file identity and original byte hash travel with the loaded snapshot.

Choose the file's owning Xray service. **Validate on server** uploads a private draft through SFTP and runs the installed core with `run -test -format json -config stdin:`. It uses the daemon's effective user/group, supplementary groups, environment, working directory and mount namespace. This checks real certificate/resource access. The daemon stays running. Native test mode can initialize configured log destinations; it is not a traffic/connectivity test.

A successful validation stores a root-private plan for 15 minutes. **Apply… → Apply & restart** confirms the server and service before starting a detached job. The worker:

1. Checks the server boot ID, service/process/binary identity, source inode/metadata/hash and validated draft hash. Revalidates with the installed core. Changed or expired inputs require validation again.
2. Saves the exact original Xray bytes in `/var/lib/wayrill-remote/JOB_ID/config.backup` and checkpoints a durable transaction journal. Backups have mode 0600 inside root-owned 0700 directories.
3. Backs up an existing companion as `wayrill.backup`, or records its absence. A companion is named after the canonical config (`config.json` and `config.wayrill.json`). Its executable graph, User sets and layout travel through the private SFTP upload, never command arguments or browser storage. Saved companion files have mode 0600 and belong to the connected SSH account, including when deployment uses sudo. Rollback preserves the previous ownership and mode. Source hashes and file stamps are checked for both files.
4. Arms recovery for Xray changes, writes and fsyncs a temporary file beside the real target, preserves owner/group/mode and extended attributes, then atomically replaces the target. A symlink continues to point at its canonical target; hard-linked files are rejected.
5. Restarts only the selected Xray service, checks that it remains active with a stable PID for five seconds, and confirms its execution settings and installed bytes. A durable commit marks success. The app then updates its source snapshot and draft baseline.
6. On failure after replacement, restores the exact backup and restarts/checks the previous configuration. If an outside edit or failed backup-integrity check makes restoration unsafe, it preserves the external file and backup and reports that recovery needs attention.

Layout-only saves keep the original Xray bytes, inode and PID. They do not restart Xray, install a boot guard or reload systemd. They still use a serialized detached job, exact backups, source checks and durable checkpoints. Completed drags, keyboard node moves, panning/zooming, User set names and explicit Stash placement are saved. Reconnecting restores a saved viewport instead of fitting over it.

Before uploading or restoring a companion, the frontend parses its graph through the shared graph validator, validates its User sets and layout, compiles the executable graph and compares every JSON value with the current server config. Object-key order/formatting is irrelevant; array order and values remain significant. Known Xray property names are canonicalized before export and equivalence checks; dictionary keys retain their exact spelling. It does not use the original JSON as a replacement for compilation. Missing files are normal; malformed, mismatched or inaccessible files produce a visible import note and retain the Xray-derived graph. An inaccessible companion blocks saving until it can be inspected, so an unknown file cannot be overwritten. A stale or invalid readable companion can be replaced with a fresh verified graph on Apply, using its current byte hash.

The native reader follows the config's symlink to locate its companion. It rejects companion symlinks, hard links and non-regular files. Config and companion reads are each limited to 16 MiB; the encoded two-file upload is limited to 64 MiB. Neither config nor graph contents are cached in the browser. Reading a server changes no remote files.

Rollback preflights both files before restoring either. It restores the previous companion bytes and metadata, or removes a newly created companion if none existed before. A crash between the two atomic replacements is covered by the same journal/recovery path. On next boot, a partially installed native configuration and its companion are restored together before Xray starts. An external edit to either file stops automatic rollback and retains both backups for inspection.

The job uses the existing server-action serializer and stable request ID. Retrying a lost response cannot apply twice. The UI stores only the job/plan identifiers, never configuration credentials. Closing the dialog/app or losing SSH does not cancel an accepted job. Reopen Apply or Server status to reconnect to its result. Failed applies keep the local draft available for correction and fresh validation.

## Recovery and storage

The detached unit's `ExecStopPost` invokes recovery even if the worker is killed. Before mutation, Wayrill also installs a transaction-specific `wayrill-remote-recover-JOB_ID.service` under `/etc/systemd/system` and links it into the owning Xray unit's wants directory. It is ordered before Xray and restores an uncommitted backup on a later boot, without trying to start the service that is waiting for it. During the normal same-boot restart it is a no-op. Completed transactions remove this unit/link. A leftover completed guard is harmless because the journal is terminal.

The journal records file restoration separately from daemon recovery, preventing a process crash between those operations from being reported as success. Recovery and apply share a file lock. The boot guard never waits on that lock during a normal restart, and a reboot guard can recognize a durable restoration performed by a reconnecting client without deadlocking systemd startup.

Server plans and candidate files are root-private. Expired staging data older than one day is removed during a later validation. Backups remain available until an administrator removes them; job-output retention does not delete them. Credentials are not passed in remote process arguments. SFTP uses short-lived files in the Windows user's Local AppData and a private server temporary directory; successful uploads are removed after reading, and abandoned uploads are cleaned after one hour on a subsequent upload. No credentials enter browser storage or SSH console logs.

Root works directly; other accounts need existing noninteractive `sudo -n` permission. Python 3, systemd/systemd-run and util-linux `setpriv` are required; mount-isolated services also require `nsenter`. The current workflow intentionally rejects merged/directory/implicit configs, container/chroot/image services and private mounts that resolve the requested path to a different file. It does not infer a deployment layout for those cases.

Daemon health verifies startup, stable execution and configuration identity. It cannot prove that every remote outbound, DNS resolver or user-defined route is reachable.

## Verification

Ordinary frontend tests cover validation lifetime, confirmation, draft/source separation and companion round trips. Python worker contracts use synthetic temporary files and mocked service control; run `python -m unittest discover -s aquifer/tests -v`. The explicit `tools/Check-AquiferCore.ps1` suite validates generated server configurations with the pinned real Xray binary, without starting networking.

Any live deployment test must use a disposable server or explicit authorization for the named production server. Keep credentials, snapshots and server-specific evidence outside published source. Fixture isolation is separate from a claim about production service-manager behavior or live traffic.
