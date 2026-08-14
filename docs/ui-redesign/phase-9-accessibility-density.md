# Phase 9 — Accessibility and density

Status: complete on 2026-08-14.

Phase 9 closes the shared UI accessibility and density gaps without changing
the protected PDF viewport IDs or renderer-owned geometry.

## Delivered

- Added a persisted `density` preference with `compact` as the default and
  `comfortable` as the user-selectable alternative.
- Applied density consistently to shell panel widths, ribbon controls,
  preference controls, spacing, type scale, and icon sizing.
- Added the same density choice to the mobile preferences surface.
- Reworked preference and language dropdowns as keyboard-operable comboboxes
  with listbox options, selected-state semantics, and Escape/arrow/Home/End
  handling.
- Added Preferences tablist/tabpanel semantics and arrow-key tab navigation.
- Added accessible-name fallback for legacy icon-only controls whose visible
  name previously existed only in `title`.
- Added explicit state cues for selected/pressed controls, focus scroll
  margins, forced-colors handling, reduced-motion coverage, and a 2× display
  rule for crisp vector controls.
- Added solid secondary-text tokens for the shipped themes and a static WCAG
  AA contrast contract for normal interface text.
- Added 800×600 responsive rules that keep overflow local to scrollable ribbon
  content and keep the shell/dialog usable.

## Verification

Static gates passed:

- `npm run typecheck`
- `npm run test:ui-contract` — 9/9
- `npm run test:unit` — 87/87
- `npm run test:quality` — 32/32
- `npm run build`

Live app checks passed in the Codex in-app browser at `http://localhost:3041/`:

- Default 1280×720 viewport: compact density loaded, no document-level
  horizontal overflow, and title-only icon controls received accessible names.
- Explicit 800×600 viewport: no document-level horizontal or vertical overflow;
  the Preferences dialog fit within the viewport and focused tabs remained
  visible.
- Keyboard ArrowDown moved the density listbox focus from Compact to
  Comfortable; saving changed the root density from compact to comfortable,
  changed the shared control/panel metrics, and reload restored comfortable.
- The test preference was restored to compact before the viewport override was
  reset.

The remaining continuous work is a broader content-level contrast audit for
user-provided PDF content and third-party/plugin surfaces; the shared shell
and preference surfaces are covered by this phase’s gate.
