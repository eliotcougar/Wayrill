# Styling

`src/main.tsx` loads `src/styles.css`, the single stylesheet entry point. Its
explicit import order keeps the cascade independent of React component imports.
Add feature sheets there rather than importing CSS from components.

## Shared foundation

- `tokens.css` defines semantic colors, spacing, control dimensions and the
  monospace font. Light/dark and forced-color themes share the same dimensions.
- `styles/base.css` owns element defaults, focus, native checkbox/radio accents,
  scrollbars, reduced motion and visually hidden content.
- `styles/controls.css` owns buttons, fields, toggles, editable selects and
  disclosure controls. Use `text-control` for standalone inputs, selects and
  textareas. `field` and `editor-field` style their direct controls and immediate
  control wrappers, without reaching into nested editors/dialogs. Use
  `search-control` for an icon and input sharing one border and focus ring.
  `check-control` lays out a native checkbox/radio and its label; its compact
  variant is for dense option lists. Keep text fields in explicit `editor-field`
  wrappers rather than styling every label inside a dialog.
- `styles/layout.css` owns wrapping action and form rows. Use `action-row` for
  buttons/status controls and `form-row` for labeled controls with adjacent
  actions. `action-row--spread` separates the leading and trailing content.
  Feature sheets retain placement, widths and margins rather than repeating the
  flex layout, alignment and gap.
- `styles/dialogs.css` owns dialog/editor shells, title bars, tabs and footers.
- `styles/tables.css` owns native `data-table` cell spacing, dividers and headers.
  Use `data-table--compact` for dense lists and `data-table--sticky` when a table
  scrolls inside a constrained viewport. Features own column widths, numeric
  alignment and the scrolling container. Virtualized/grid lists retain their
  layout because their fixed row geometry is part of the rendering contract.
- `styles/feedback.css` owns inheritance badges, `notice` panels and their
  success, warning and error variants. Use the neutral panel for information,
  and `notice--compact` for dense diagnostic rows. Features own placement and
  actions; keep severity, content spacing and wrapping in the shared stylesheet.

Normal form controls and action buttons use `--control-size` (36px). Compact
inspector fields and icon buttons use `--control-size-compact` (32px). A `field`
selects the compact density; an `editor-field` selects the normal density.
Use `compact-controls` for a group of compact inputs and action buttons, as in
pagination. Its padding and font size change together with the minimum height.
Filter sidebars use the same compact density; dialog searches use normal density
and the node-library search uses compact density.
Keep checkbox, radio and file inputs distinct from text controls. Composite
secret fields and editable selects own one outer border and one focus treatment.
Native checkboxes and radios share `--choice-size`; rich selectable rows and
theme cards retain their own layout around those controls.
Choice rows follow the normal control height; `check-control--compact` uses a
24px row for options that already live in a dense list or wrapping group.

Field appearance uses low-specificity selectors so validation, inherited-value
hints and composite controls can specialize it without escalating specificity.
The element font reset must also have zero specificity; a type selector with
`font: inherit` would defeat the field's font size and line height.
Preserve visible focus on every keyboard-operable control.

`AdvancedSettings` uses a native `details` element and the shared `editor-advanced`
appearance. Collapsing keeps its children mounted, preserving drafts and validity.
The summary owns its chevron, minimum hit area and open-state spacing; do not
reintroduce closed-summary margins or add separate sizing rules in each editor.

## Feature ownership

The sheets under `styles/` separate workspace chrome/library/inspector, menus,
graph cards/canvas, routing/DNS editors, runtime, resources and protocol editors.
The remaining feature sheets cover Stash, policies, traffic, system capture and
other individual dialogs. Feature sheets should define their own layout and
states, reusing shared control appearance and semantic tokens.

Before adding an override, change the owning rule or shared primitive if that is
where the behavior belongs. Keep intentional responsive or state variants beside
their base rule. Avoid appending a second definition of the same selector, copying
input appearance into a dialog sheet, or using `!important` to fix precedence.
Existing vendor/platform overrides are narrow exceptions.

`accessibility.css` is loaded last for cross-feature reflow, forced colors and
keyboard behavior. Check it when changing shell dimensions or overflow.

## Verification

`npm run check` includes TypeScript/React linting, CSS error checks and formatting.
Stylelint rejects duplicate rules/declarations, unknown CSS and invalid values;
Prettier owns formatting. Descending-specificity linting is disabled because it
cannot distinguish unrelated component subtrees.

Run the frontend checks, tests and build described in [building](building.md).
Also inspect affected views in light and dark themes, including keyboard focus,
validation/default hints, open popovers and overflow at a laptop viewport. Assess
the rendered result after each styling round; compilation alone cannot establish
layout correctness. Measure actual control dimensions when changing density;
padding or native form metrics can exceed a declared minimum height.
