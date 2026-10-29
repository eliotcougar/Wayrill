# Security

Wayrill changes Windows routing and runs a privileged service. Its desktop is
unprivileged; the service authenticates local callers and restricts operations.
Custom Xray and contained native helpers are part of the security boundary.
This beta has not had an independent security audit.

Report vulnerabilities privately using
[GitHub's security reporting form](https://github.com/eliotcougar/Wayrill/security/advisories/new).
Do not attach real server credentials, subscription tokens or raw private
profiles to issues.

The currently published beta is the supported reporting target. Include its
version, Windows version, relevant capture mode, expected/actual behavior and a
minimal sanitized reproduction. Distinguish ordinary routing/configuration errors
from crossing the local privilege or ownership boundary.

App protection is limited to routing transitions; it is not an always-on firewall
or a guarantee against all direct access. Review the [capture guide](docs/guide/capture.md)
and [beta boundaries](docs/BETA.md).

## Automated checks

CodeQL scans maintained sources on pull requests, main changes and a weekly
schedule. The contributor PR policy blocks new high/critical security findings and
CodeQL errors. Dependency review blocks newly introduced high/critical advisories
in runtime, development and unknown scopes. Secret scanning and push protection
are enabled; remove any actual leaked credential even if a scan has not found it.

Dependabot checks npm, the three Cargo workspaces and Actions weekly. Minor/patch
updates are grouped; major changes remain separate PRs. Security fixes are grouped
separately and can arrive before the routine schedule. Nothing is automatically
merged. The pinned Xray source, build toolchain and custom integrations need the
source, regression and integrity review in the core development guides.

Owner-authorized direct pushes remain possible and receive CI/scanning after the
push. The history protection has no administrator bypass. See
[Contributing](CONTRIBUTING.md) for the distinction.

The Rust extractor currently uses syntax-only fallback for the shared
`service/subscription_http.rs` path module; macro/semantic analysis there is
incomplete. Native checks still compile and test it in both consumers. Keep this
limitation visible when reviewing subscription and routing-rule downloads.

Go additions are injected into Xray by the core build. Scanning their checked-in
files does not replace validation in that exact patched source tree. These checks
do not constitute a security audit or analyze a downloaded upstream archive merely
because it is pinned. Review the actual changed source and test the relevant
privilege, lifecycle and routing behavior.
