# Phase 3 design foundations

Phase 3 begins with a semantic token layer in `open-pdf-studio/styles/design-foundations.css`, imported immediately after `themes.css` from `styles.css`.

## Scope of this slice

- Adds semantic color, spacing, typography, control, icon, radius, shadow, panel, focus, and motion tokens.
- Keeps the existing component-specific theme variables available during incremental migration.
- Applies the system font token to the application stack without changing PDF page typography.
- Adds a shared `:focus-visible` treatment to application controls.
- Adds reduced-motion behavior for application animations, transitions, and scroll behavior.
- Keeps high-contrast borders literal and removes decorative shadows in that theme.

## Migration rule

New component work should consume `--ui-*` semantic roles. Existing components should migrate one surface at a time, with visual and protocol checks after each slice. Do not bulk-replace the legacy `--theme-*` variables or change viewport-adjacent selectors as part of token migration.

## Initial token groups

| Group | Examples |
| --- | --- |
| Color | surface, elevated surface, canvas surround, border, text, accent, selection, focus, success, warning, destructive, error |
| Spacing | 4px base unit through 32px grouping space |
| Typography | system family, 10–15px compact scale, tight and normal line heights |
| Sizing | 24/28/32px control heights, 20px icon grid, 24px icon box |
| Shape/elevation | 5–8px radii, floating/dialog shadows |
| Layout | existing 200px left panel, 300px properties panel, 28px collapsed panel |
| Interaction | focus ring width/offset, standard transition, reduced-motion override |

## Verification

- `npm run test:ui-contract`: 3/3 passed.
- `npm run typecheck`: passed.
- Direct Vite production build: passed. Existing Vite externalization and chunking warnings remain unchanged in scope.
- `git diff --check`: passed.
- No renderer, saver, store, Tauri, protected viewport, or command-owner files were changed by this slice.

The first presentation-only migration slice is complete: ribbon tabs, groups, buttons, and the properties-panel header now consume semantic sizing, typography, spacing, radius, border, icon, and motion roles. Icon-only ribbon buttons retain their existing tooltip and now also expose an explicit accessible label.

Phase 4 may now begin with reusable component extraction and gallery coverage. The full live screenshot matrix for every theme and window size remains a Phase 4/5 visual QA activity, not a reason to change PDF behavior or viewport infrastructure here.
