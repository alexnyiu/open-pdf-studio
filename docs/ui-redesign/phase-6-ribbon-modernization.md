# Phase 6 ribbon modernization

The first Phase 6 slice modernizes the existing ribbon presentation without
reorganizing its command surface. The ribbon remains the same behavior owner
boundary: tab selection stays in `ribbonStore.js`, collapse state continues to
persist through `preferences.js`, contextual tabs remain store-driven, and
`AdaptiveGroups` still owns measurement and the `More` flyout.

## Implemented slice

- Replaced the stacked gradient treatment with the approved macOS-refined
  chrome, raised command surface, and restrained border system.
- Added a single blue active and selected-state vocabulary for light and dark
  mode. Dark mode uses neutral charcoal `#242424` ribbon chrome and `#2d2d2d`
  raised surfaces while the document canvas remains `#181818`.
- Neutralized the remaining dark-mode shell surfaces through the shared theme
  tokens, so the title bar, side panels, properties panel, and docked palettes
  now use grey surfaces instead of the legacy navy palette.
- Standardized tab height, command-group spacing, label treatment, button
  geometry, and outline-icon optical treatment.
- Kept frequent commands visible in their existing groups and retained the
  adaptive `More` flyout for narrow windows and rare commands.
- Preserved every existing ribbon button ID, translated label, tooltip,
  disabled/read-only guard, and callback. This slice does not shorten labels or
  move commands yet; those changes require usage evidence and a separate
  workflow review.

## Icon and interaction rule

Ribbon icons use the existing inline SVG source set on a shared 20–21 px
optical grid, with the existing SVG geometry preserved. The presentation layer
normalizes the visible stroke color, round joins, and command states:

| State | Light | Dark |
| --- | --- | --- |
| Default | muted slate icon/text | muted blue-grey icon/text |
| Hover | quiet grey surface, ink text | quiet dark surface, light text |
| Selected | blue-soft surface, strong blue text | blue selection surface, light blue text |
| Disabled | 40% opacity | 40% opacity |
| Focus | 2 px blue ring | 2 px light-blue ring |

Accessible names remain supplied by each button's existing `title`, and
icon-only buttons continue receiving `aria-label` through `RibbonButton`.

## Verification target

The Phase 6 contract covers the ribbon tab/collapse/overflow composition and
asserts that the new presentation stylesheet does not target protected PDF
viewport selectors. The live acceptance pass should cover the Home and View
tabs, collapse/reopen, light and dark mode, 1400×900 and 800×600, adaptive
icon-only/overflow behavior, keyboard focus, and zero new browser errors.

This is the first reviewable ribbon slice, not the final command-information
architecture. Label shortening, command-palette work, and usage-informed
reorganization remain follow-up work after the visual baseline is accepted.
