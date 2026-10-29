# Testing

Run checks appropriate to the affected layer. `npm run check`, `npm test` and
`npm run build` cover frontend types/lint/default pins, regressions and production
bundling. Tests and synthetic fixtures are source for contributors, not shipped
user examples. Public examples have a separate catalog and acceptance tests.

Native work uses Rust format, strict Clippy and tests for the affected workspace.
Capture is a separate leaf workspace; check both WinDivert-enabled and
attribution-only features. The complete [installer build](building.md) exercises
its packaging guards and pinned core regressions.

Core configuration tests use WAYRILL_XRAY_TEST_EXE and an isolated
WAYRILL_XRAY_FIXTURE_DIR. Confirm the executable matches its intended pin.
Acceptance is not traffic evidence. Tests requiring private endpoints, native
mutation or a particular Windows state remain opt-in, with a documented reason.

## What deserves a regression test

Protect observable behavior: routing decisions and precedence, lossless imports
and saves, protected settings, cancellation, recovery, and bounded work with large
subscriptions. Prefer a complete workflow over several tests of the helpers it
calls. A test should fail when a supported feature breaks, not when an internal
representation changes without changing that behavior.

Use representative cases for distinct behaviors instead of exhaustive products
of equivalent inputs. Keep independent cases when they protect different failure
modes. Avoid assertions about exact labels, help text, CSS, control placement or
catalog counts; review presentation visually. Only assert a specific value or
structure when it is part of the behavior or an external compatibility contract.
Remove superseded tests and their unused fixtures rather than skipping them.

## Disposable Windows environment

Use an isolated Windows VM for service installation, proxy scopes, adapters,
sharing, WFP/WinDivert and restart/recovery cases. Never run the whole ignored
suite against a contributor's live workstation. No VM address, account, key or
remote-control endpoint is required by the public repository.

Record build hashes, initial graph/runtime and owned Windows settings. Back up
the authoritative Stash and workspace before modifying them. Validate expected
traffic separately from service/process health, then restore the initial fixture.
Include failure, rollback, service restart, interrupted shutdown, network change,
and explicit Stop where relevant. Do not claim physical-network or Internet
performance from a local relay measurement.

## Evidence

Keep logs, screenshots and private test graphs outside Git, such as `.local/`.
Summarize exact scenarios and limitations in a release report, with sanitized
attachments only. A passing older release is not current evidence. Do not add
timing sleeps or implementation-mirroring assertions solely to raise a test count.
