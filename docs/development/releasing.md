# Release checklist

1. Review the README, beta notes, supported scope and current documentation.
   Update versions/pins together; do not copy historical validation claims.
2. Run `npm ci`, check, tests and production build from an exported source tree.
   Build the complete Windows installer with the maintained `tools/` scripts.
3. Run `tools/Prepare-ThirdPartySources.ps1` and retain its supplemental router
   source assets with the release. Verify dependency hashes, patched core/worker archives, vendor licenses,
   resource selection and complete service payload. Keep pinned Go/patch bytes
   unchanged by Git line-ending conversion.
4. Test clean installation and an in-place upgrade in a disposable Windows VM.
   Check saved data, service startup, graph activation, Stop/restoration, tray,
   enabled capture combinations and recovery for affected changes.
5. Audit `git ls-files`: no profiles, tokens, keys, VM files, logs, caches,
   generated executables, downloaded DATs or local research reports. Keep useful
   synthetic regression tests and source/build inputs.
6. Inspect `git archive` from the intended release commit, not an unfiltered ZIP
   of the development directory. Recheck links and secrets in the exact archive.
7. Review release notes, checksums and known limits. Attach the complete installer
   and required source/license payloads as release assets. Identify signing status
   honestly; a checksum is not an Authenticode signature.
8. Publish only after the repository owner approves the final reviewed contents.

Source exports exclude generated/private files through Git ignore rules and an
explicit content review. `.gitignore` does not protect a secret already committed.
If one is found in history, stop publication and address both history and the
credential itself.
