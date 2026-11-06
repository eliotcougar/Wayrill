# Shared Wayrill packages

These private npm workspaces are consumed from source by Wayrill and Aquifer. Run `npm ci` at the repository root. Each executable bundles what it uses; installed apps require neither Node nor a shared runtime directory.

- `@wayrill/core`: strict JSON/JSONC parsing/helpers, protocol catalog and kind types, native property/path projection, schema-driven field discovery and nested validation, native DNS/policy/log field metadata and editing, settings contracts/validation, IP/domain/resolver validation, port ranges, policy-prefix selection and Unicode-safe text handling.
- `@wayrill/ui`: the visual foundation (semantic theme tokens, controls, forms, dialogs, tables, lists, feedback, node icons/type captions, library rows and graph-card decoration), menus/context menus, focus boundaries, editor tabs and schematic connections. The schematic module owns obstacle routing, drag previews, worker lifecycle, the pinned libavoid binding, shared wire rendering and connection-kind presentation. Wayrill supplies its traffic-activity overlay through a renderer slot; Aquifer uses the same edge view directly.

## Boundaries

Shared code must not import either app, Tauri IPC, Windows service operations, SSH credentials or server deployment logic. Both apps import `@wayrill/ui/styles.css` before their own layouts. Branding, additional semantic colors and app-specific controls stay in the apps; the common appearance has one owner in `packages/ui/src/styles/`. React and React Flow are peers supplied by the root workspace lock, avoiding duplicate contexts.

The protocol field engine accepts the owning app's versioned schema. Native field editing accepts its bounded JSON parser. Config byte budgets and reserved runtime tag prefixes remain explicit app adapters. Do not silently substitute the client core schema for a remote server schema or add app-name switches to the shared engine.

Schematic workers live beside their shared client and are bundled by Vite's static worker URL handling. Both apps resolve the same pinned WASM dependency. Changes here require production builds and worker/drag interaction checks in both apps; ordinary unit tests alone cannot verify emitted worker/WASM paths.

Editors that reuse one live panel pass its stable `panelId` to `EditorTabList`; every tab must reference an existing panel. Editors with retained panels use the per-tab IDs from `useEditorTabs`.

Editor tabs use manual activation: arrows/Home/End explore; Enter/Space activate. Tab switching preserves unfinished drafts where panels are retained. Settings and Stash in Aquifer use the same list control as Wayrill editors.

`OrderedEntries` and `OutputList` share pointer dragging and keyboard reordering between the apps. Entries need stable IDs so selection and focus follow a moved row. Keep routing semantics and saved metadata in the owning app.

## Checks

`npm run check:all`, `npm run test:all` and `npm run build:all` check both adapters. The main check also type-checks all shared source/tests using `packages/tsconfig.json`; the main suite runs shared package regressions. Production lint rules include shared source. The small browser test setup supplies only missing jsdom geometry methods.

## Remaining consolidation

1. Reconcile versioned protocol/default catalogs and their generation guards. The actual generated catalogs still reflect separate core snapshots; their interpreter is shared.
2. Reconcile graph import/export behavior with client graph and real server round-trip cases before extracting the compiler. Preserve API and VLESS reverse-user targets, native field preservation, disabled inbounds and Windows capture extensions.
3. Reconcile rule-list editing and Stash selection models. Keep client inheritance and server configuration semantics explicit; use the shared visual primitives for their controls.
4. Consolidate remaining protocol-link import and outbound/policy resolution helpers in cohesive modules, with shared acceptance cases before replacing either implementation.

The graph compilers still differ. `aquifer/vendor-source.json` records the imported baseline. Prefer moving a cohesive implementation over copying fixes or introducing a universal editor with app-specific branches.
