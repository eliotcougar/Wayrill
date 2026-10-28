# Styling

`src/main.tsx` loads `src/styles.css`, the single stylesheet entry point. Its
explicit import order keeps the cascade independent of React component imports.
Add feature sheets there rather than importing CSS from components.

## Shared foundation

- `tokens.css` defines semantic colors, spacing, control dimensions and the
  monospace font. Light/dark and forced-color themes share the same dimensions.
  Use the semantic token directly rather than adding aliases or unused palettes.
- `styles/base.css` owns element defaults, focus, native checkbox/radio accents,
  scrollbars, reduced motion and visually hidden content.
  Ordinary `h3`/`h4` content headings have explicit size, weight, line height and
  spacing, using zero specificity. Deliberate hierarchy in dialog titles, graph
  cards and workspace chrome remains feature-owned.
- `styles/controls.css` owns buttons, fields, toggles, editable selects and
  disclosure controls. Use `text-control` for standalone inputs, selects and
  textareas. `field` and `editor-field` style their direct controls and immediate
  control wrappers, without reaching into nested editors/dialogs. Use
  `search-control` for an icon and input sharing one border and focus ring.
  `check-control` lays out a native checkbox/radio and its label; its compact
  variant is for dense option lists. Keep text fields in explicit `editor-field`
  wrappers rather than styling every label inside a dialog.
  `popover-surface` shares the border, background, typography and shadow of
  menus, editable preset lists and checkbox filters; each component retains its
  placement, scrolling limits, semantics and keyboard behavior.
  Inline utilities use `secondary-button button--small` (24px, 10px text),
  inheriting normal button alignment, disabled, hover and focus behavior. Actions
  beside form fields use ordinary secondary buttons at the field's density.
  Use `button--danger` on a secondary button for an explicit destructive action;
  features retain only its placement. Menu actions keep their menu-specific hit
  area and destructive state styling.
- `styles/layout.css` owns wrapping action and form rows. Use `action-row` for
  buttons/status controls and `form-row` for labeled controls with adjacent
  actions. `action-row--spread` separates the leading and trailing content.
  Use `section-heading` for a content heading with adjacent actions; it shares
  row layout, wraps long titles and keeps the heading's margins out of the row.
  Feature sheets retain placement, widths and margins rather than repeating the
  flex layout, alignment and gap.
  Use `inline-field` for a label beside a control, with `text-control` on the
  input/select itself. Its density follows `compact-controls` where appropriate;
  feature sheets retain width constraints rather than duplicating field borders,
  colors, padding or label alignment. Standalone native controls need an explicit
  shared class when they are outside a `field` or `editor-field` wrapper.
  `field-grid` supplies two equal columns, a shared column gap and single-column
  reflow at the common narrow breakpoint. Normal fields keep their own vertical
  spacing; grids of defaults metadata that clear field margins own their row gap.
  `wide-option` spans both columns. Native editors expand only their direct
  textarea fields, so that rule cannot change nested editors' layouts.
- `styles/panels.css` owns the `editor-panel` frame for grouped settings and
  status summaries. The subtle variant sits at the surrounding editor's surface
  level; the outlined variant gives standalone Runtime and traffic summaries a
  stronger boundary. Features own layout, density, placement and scrolling limits,
  keeping the hierarchy of live rates distinct from ordinary runtime values.
  Use notices for explanatory messages and choice lists for selectable rows
  rather than creating another panel type.
- `styles/dialogs.css` owns dialog/editor shells, title bars, tabs and footers.
  `dialog--compact` reduces header/footer spacing for dense working views, such
  as statistics and policy editors. Tab appearance targets `role="tab"` inside
  `editor-tab-list`; trailing actions keep normal button styles. Keep scrolling,
  focus and selected/disabled states here rather than in individual windows.
  Titles with a direct icon share its alignment and spacing here; plain titles
  retain inline text layout, including mixed-direction subscription names.
  The dialog body owns its outer gutter; its final child's trailing margin is
  removed so notices and option groups do not add a second bottom gap.
- `styles/code.css` owns `code-block` previews and the `code-control` monospace
  field modifier. Combine `text-control code-control` for standalone structured
  textareas. Use `code-block--compact` in the inspector; features retain their
  height limits and scrolling layout. Keep diagnostic logs that depend on column
  alignment unwrapped, while configuration previews wrap long values.
- `styles/lists.css` owns `item-row` spacing and dividers for name/details/action
  lists, and `item-content` typography and wrapping. Use `item-list` around rows
  to omit the final divider; features retain scrolling limits and responsive
  action placement. The inline content variant keeps names and details on one
  wrapping line. Selectable rows reuse this content without becoming action rows.
  `key-value-list` styles native `dl` summaries with direct `dt`/`dd` pairs,
  aligned label/value columns and safe wrapping. Use its compact variant for
  source counts. Features keep placement, numeric alignment and deliberate
  column constraints, without repeating the label/value appearance.
- `styles/choices.css` owns rich checkbox/radio lists. Combine `check-control`
  with `choice-row` inside `choice-list`; use the compact row variant for dense
  catalogs. `item-content` lays out a name and details, with an inline
  variant for compact lists. Native checked/disabled state drives row appearance.
  Features retain scrolling limits, truncation and multi-action row layouts.
  Use `choice-group` for a fieldset of options and `check-control choice-card`
  for separately framed options, such as themes and WinHTTP scopes. Cards share
  selected, hover, focus and disabled styling; features own the column layout.
- `styles/tables.css` owns native `data-table` cell spacing, dividers and headers.
  Use `data-table--compact` for dense lists and `data-table--sticky` when a table
  scrolls inside a constrained viewport. Features own column widths, numeric
  alignment and the scrolling container. Virtualized/grid lists retain their
  layout because their fixed row geometry is part of the rendering contract.
- `styles/feedback.css` owns inheritance badges, `notice` panels and their
  success, warning and error variants. Use the neutral panel for information,
  and `notice--compact` for dense diagnostic rows. Features own placement and
  actions; keep severity, content spacing and wrapping in the shared stylesheet.
  `empty-state` shares typography and wrapping for empty/no-match results. Use
  its centered variant for large lists and inline variant in already padded
  panels. Keep larger illustrated canvas/editor prompts feature-owned.
  Field help, validation messages and resolved default hints also live here.
  Use `field-message error`/`warning` for field validation, including native
  protocol fields. Plain help styles reach only a field's direct `small` child,
  allowing named default/validation styles to take precedence without affecting
  nested editors. A flex-column `editor-field` supplies its own feedback gap;
  do not add a paragraph margin to that gap. Invalid controls and composite
  secret fields use their `aria-invalid` state for the shared error border.

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

Field and standalone text-control appearance, including textarea defaults, uses
zero-specificity selectors so feature sizing, validation, inherited-value hints
and composite controls can specialize it without escalating specificity.
The element font reset must also have zero specificity; a type selector with
`font: inherit` would defeat the field's font size and line height.
Preserve visible focus on every keyboard-operable control.

Use `disclosure` for native `details` that expand ordinary content, such as
process choices, help, diagnostics or nested protocol fields. `editor-advanced`
shares the same summary treatment and adds its settings separator. Both use one
chevron, minimum hit area, typography and open-state gap. Keep framed inspector
sections and popover triggers distinct; their structure and placement differ.
`AdvancedSettings` keeps its children mounted when collapsed, preserving drafts
and validity. Do not reintroduce closed-summary margins or separate trigger
sizing in feature sheets. Features own spacing between expanded content rows.

## Feature ownership

The sheets under `styles/` separate workspace chrome/library/inspector, menus,
graph cards/canvas, routing/DNS editors, runtime, resources and protocol editors.
The remaining feature sheets cover Stash, policies, traffic, system capture and
other individual dialogs. Feature sheets should define their own layout and
states, reusing shared control appearance and semantic tokens.

Keep graph card states together in `styles/graph.css`. Selection owns elevation
and its outline; validation and the Main role share a separate ring so that
errors cannot remove selection feedback. Neither changes card or port geometry.
Node cards use named output rows. Handle colors come from connection-type
metadata, also used by the editor and connection checks; do not duplicate that
mapping in port-name CSS classes. Keep the semantic data attributes for inspection.
Workspace runtime indicators belong in `styles/workspace.css`, runtime dialog
content in `styles/runtime.css`, and rule-field expansion in `styles/rules.css`.
Feature sheets such as Stash and traffic units must not style these unrelated
components. Use an explicit action-row class instead of styling every direct
`div` in an expanded field; the field heading has its own alignment.

Before adding an override, change the owning rule or shared primitive if that is
where the behavior belongs. Keep intentional responsive or state variants beside
their base rule. Avoid appending a second definition of the same selector, copying
input appearance into a dialog sheet, or using `!important` to fix precedence.
Existing vendor/platform overrides are narrow exceptions.

`accessibility.css` is loaded last for cross-feature reflow, forced colors and
keyboard behavior. Check it when changing shell dimensions or overflow. Scope
main-workspace reflow to the app shell: dialogs reuse the progress overlay's
workspace wrapper and must retain their bounded, scrolling content area.

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
