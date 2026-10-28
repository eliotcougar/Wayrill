# Backup and restore

Portable backups let you move a configuration to another PC, keep a recovery
copy before an experiment, or share a reusable filter. They are separate from
the normal workspace storage protected by your Windows account.

## Choose what to save

Open **File → Back up…** and choose a scope:

| Scope | Contents |
| --- | --- |
| **Full configuration** | Graph, Stash, defaults, resource sources, appearance, test settings and statistics preferences. |
| **Graph** | The graph and linked Stash definitions needed by it. |
| **Stash** | The reusable library of profiles, subscriptions, policy groups and chains. |
| **Filter nodes** | Selected Traffic/DNS filters, including supported source and override data. |

For one filter, its right-click menu also offers **Back up filter…**.

Resource-source settings are included where applicable; external DAT files,
drivers and Windows interfaces are not copied into a portable backup. Recreate
or download those resources on the destination PC. Windows proxy assignments,
startup policy and app-protection policy are not restored from a backup.

## Save with a password

1. Choose the scope and any filters to include.
2. Enable **Encrypt with a password** when the backup contains private profiles
   or subscription URLs.
3. Enter and confirm a password of at least eight characters.
4. Choose **Save backup…** and keep the resulting file somewhere independent
   of the workspace you may overwrite.

Keep the password separately. Wayrill has no password recovery service. Without
encryption, backups are readable, indented JSON and can contain credentials.
Ordinary graph and Xray configuration exports can contain those credentials too.
The fact that Windows protects the working workspace does not protect a
plaintext file you deliberately export.

## Restore a setup

1. Open **File → Restore backup…** and choose the file.
2. For an encrypted backup, enter its password and use **Unlock backup**.
3. Review the listed contents. Choose Graph, Stash, application preferences or
   filters as available. For Stash, choose whether to merge or replace it.
   Replacement retains outbounds used by the remaining graph as manual entries.
4. For filter backups, choose a compatible existing filter to replace or add
   new filter nodes. Matching output names keep their connections; removed
   outputs disconnect links. New filter nodes start unconnected.
5. Choose **Restore to draft**. Review the resulting graph, supply any external
   resources and run Check/Validate before Start/Apply.

Restoring does not activate the graph or blindly restore Windows settings.
Undo can restore the previous Graph and Stash after restoration. An independent
backup remains useful before replacing a whole workspace or library.

## Export rules for another app

**Export rules…** on a Traffic filter provides Wayrill and Compatible v2rayN
formats. That is the rule-exchange workflow, with output mapping and an omission
report; see [Traffic rules](traffic-rules.md). Use a filter backup when moving the
filter within Wayrill, especially when you want source/override relationships.

For a complete Xray configuration, use
[Import/export Xray configuration](../reference/xray-import.md). It represents
routing behavior rather than a copy of the original canvas layout.
