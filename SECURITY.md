# Security

Wayrill changes Windows routing and runs a privileged service. Its desktop is
unprivileged; the service authenticates local callers and restricts operations.
Custom Xray and contained native helpers are part of the security boundary.
This beta has not had an independent security audit.

Report vulnerabilities privately to the repository owner using GitHub's private
security reporting when enabled. If no private channel is available, request a
contact method without publishing exploit details or secrets. Do not attach
real server credentials, subscription tokens or raw private profiles to issues.

The currently published beta is the supported reporting target. Include its
version, Windows version, relevant capture mode, expected/actual behavior and a
minimal sanitized reproduction. Distinguish ordinary routing/configuration errors
from crossing the local privilege or ownership boundary.

App protection is limited to routing transitions; it is not an always-on firewall
or a guarantee against all direct access. Review the [capture guide](docs/guide/capture.md)
and [beta boundaries](docs/BETA.md).
