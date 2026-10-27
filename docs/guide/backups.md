# Backup and restore

Back up supports whole configuration, Graph, Stash and individual Traffic/DNS
filters. Portable backups differ from account-bound Windows protected storage.
Optional password encryption protects credentials; unencrypted copies are
indented readable JSON. Exported profiles/graphs may contain credentials too.
Keep the password separately; there is no recovery service.

Restore previews applicable merge/replace behavior and resolves dependencies.
Graph/filter edits are staged and undoable. It does not activate routing or
blindly restore Windows settings: Check/Validate/Apply afterward.
Source baselines/overrides survive backups, but external resources, drivers and
interfaces need separate provision. Keep an independent backup before replacing
a whole workspace.
