# Resource files and defaults

Resource files define the contents of GeoSite domain groups and GeoIP address
groups. Global defaults define settings inherited by compatible nodes. Both
belong to the configuration you are building; changing a default can affect many
rules or outbounds at once.

## Choose the resource files used by your rules

Open **Settings → Resource files…**. The GeoSite and GeoIP tables show each file,
its source, size, update time, default selection and auto-update setting.

Select one default file for each type. A plain `geosite:` expression uses the
selected GeoSite file; `geoip:` uses the selected GeoIP file. An explicit `ext:`
expression names a particular file and does not follow that selection.

For example, selecting Russian GeoSite makes plain GeoSite rules use that set.
It does not replace the Original row's contents. Other files remain available
for explicit references. The runtime aliases point ordinary rules to the
selected file without requiring you to rename every rule.

The installer offers Original, Russian, Iranian and Chinese sets. They use XTLS,
RunetFreedom, Chocolate4U and Loyalsoldier sources respectively. Choose files that
contain the groups used by your presets; a group present in one source may be
absent from another.

## Add, edit and update files

1. Use the add button in the relevant table, or Edit on a row.
2. Set **Filename** and choose a **Resource URL** preset or enter your own URL.
   Use **Choose DAT file** for a file from disk.
3. If wanted, enable **Auto-update**, set **Every (hours)** and choose
   **Download through Wayrill**. That download path needs a working running proxy.
4. Save the file settings and accept the enclosing resource/default changes.
   Check/Apply when changing the graph's selected resources.

Packaged filenames are fixed. Renaming a custom file renames the stored file and
updates its direct `ext:` references in filters. Review the graph afterward if
you also maintain copies outside Wayrill.

**Update now** updates every URL-backed row, including files that are not the
default and rows whose Auto-update switch is off. It does not replace a disk-only
file from the Internet. Progress and errors are reported per file.

The service owns the schedule. With **Reload core after auto-updates** enabled,
changed resources used by the running configuration trigger the supported reload
or guarded activation path. An automatic content refresh does not make the
authored graph appear changed. Unused or unchanged content avoids unnecessary
runtime replacement. If automatic reload is off, inspect the reported reload
requirement and restart routing when ready.

If a provider removes a referenced group, Wayrill omits the unavailable entry and
reports it. A positive rule that loses all its match entries is skipped or
disabled, rather than becoming a catch-all. Review those warnings: routing can
continue through later rules or fallback, which may differ from your intention.

## Browse a GeoSite or GeoIP group

Use the resource-browser button beside a filter's domain/IP field. It is also
available in the expanded field editor.

1. Confirm the selected resource file; the browser initially selects the file
   relevant to the field.
2. Search the groups and click a row to inspect its entries.
3. For GeoSite, choose attributes when needed, or edit the supported expression.
   The preview shows the resulting contents before insertion.
4. Choose **Insert expression** for a group/expression, or insert an individual
   preview entry.

Insertion adds a new line after the saved cursor line and preserves surrounding
text. A GeoSite expression can include an attribute, such as
`geosite:group@attribute`; selected attributes must all be present. A `!` in a
GeoSite attribute is part of its name, not general negation. GeoIP also supports
negated group expressions. Use the preview to inspect exactly the supported
expression against the selected file rather than guessing a provider's names.

## Change a shared setting

Open **Settings → Global defaults…**. Search by setting name, transport or scope,
or browse categories such as TLS & User-Agent, Multiplexing and Fragmentation.
Common feature switches are visible; detailed tuning is in Advanced sections.

1. Change the shared value, for example Client fingerprint.
2. Choose **Save defaults**. This edits the graph's defaults.
3. Check/Validate, then Apply/Start to change running routing.

An unset node field shows a pale italic hint for the value it will use: the
configured app default, or the embedded Xray default when no app value is set.
An unset global field shows the Xray default.

Node overrides are marked. **Use default** removes one override; **Use all global
defaults** clears the node's inheritable overrides. Its address, credentials,
identity and connections remain specific to that node. Zero, false and an
explicit empty value can be meaningful; clearing a value and overriding it with
zero are not interchangeable.

**Use Xray default** clears a shared app value. **Factory defaults** restores
Wayrill's presets. For scope, buffering and native-import details, see
[Defaults and inheritance](../reference/defaults-catalog.md).
