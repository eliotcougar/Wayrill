# Resources and defaults

GeoSite/GeoIP tables edit filename, URL/preset, auto-update interval and download
path. Add URL/disk files. Select at most one default per type: plain geosite:/geoip:
uses it, explicit ext: selects a named file. Selecting a regional default does
not overwrite Original. Packaged names are fixed; custom rename moves the file
and updates direct references.

Update now updates all URL-backed rows, even non-default/auto-update-off files.
Disk files stay. Scheduling belongs to the service. Reload core after auto-updates
requests guarded refresh of changed referenced content. Updates do not dirty
the authored graph; unchanged/unused files avoid needless replacement.

Missing groups omit affected entries. An emptied positive rule is disabled or
skipped, never catch-all. Review warnings. Original XTLS, Russian RunetFreedom,
Iranian Chocolate4U and Chinese Loyalsoldier versions/hashes/licenses are pinned
in service/dependencies.json and manifests rather than repeated here.

The browser beside domain/IP fields preselects the relevant file. Search groups,
inspect attributes, preview expressions and insert after the saved cursor line.

Unset node fields inherit app defaults or the pinned core default. Pale italic
hints show the effective value. Unset global fields show core defaults. Overrides
are marked; Use default removes them. Omitted, zero and false differ; defaults
apply only to compatible fields/transports. See the [catalogue](../reference/defaults-catalog.md)
and [source maintenance](../development/core-defaults.md).
