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
  textareas; controls within `field` or `editor-field` inherit this appearance.
- `styles/dialogs.css` owns dialog/editor shells, title bars, tabs and footers.

Normal form controls and action buttons use `--control-size` (36px). Compact
inspector fields and icon buttons use `--control-size-compact` (32px). A `field`
selects the compact density; an `editor-field` selects the normal density.
Keep checkbox, radio and file inputs distinct from text controls. Composite
secret fields and editable selects own one outer border and one focus treatment.

Field appearance uses low-specificity selectors so validation, inherited-value
hints and composite controls can specialize it without escalating specificity.
Preserve visible focus on every keyboard-operable control.

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
layout correctness.
