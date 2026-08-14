A modern UI overhaul is very achievable, but it should be done as a controlled migration rather than a single rewrite. For a beginner working part-time, expect roughly 3–6 months for a thorough redesign while continuing to preserve and test existing functionality.

The recommended direction is a “professional document workspace”: calm visual chrome, high information density, clear hierarchy, restrained color, strong typography, and contextual tools that keep the PDF canvas dominant.

## Target layout

Preserve the application’s basic workspace model:

- Compact title and document-tab area.
- Modern command bar or streamlined ribbon across the top.
- Narrow navigation rail and resizable panel on the left.
- PDF canvas as the largest visual area.
- Contextual properties inspector on the right.
- Minimal status and navigation bar along the bottom.
- Floating controls only when they relate to the current tool.

This preserves users’ existing mental model while making the interface feel considerably cleaner.

## Phase 0: Freeze the behavioral contract — completed

Phase 0 is complete and is the binding compatibility contract for every later phase. See [phase-0-behavioral-contract.md](/Users/alexander/Personal%20Projects/open-pdf-studio/docs/ui-redesign/phase-0-behavioral-contract.md).

Every redesign phase must preserve:

- The protected PDF viewport IDs, hierarchy, canvas order, and viewport boundary.
- Existing visible-command callbacks and their renderer, saver, undo, tool, store, and Tauri owners.
- Keyboard behavior, disabled and read-only guards, document-state semantics, and panel or tool side effects.
- The existing zoom source-of-truth behavior, including the raster viewport path.
- The Phase 0 smoke-test expectations and known-issues ledger.

No phase may attribute the recorded Solid disposal warnings, startup jank warning, PDFium worker recovery, Node module warning, or large-screenshot timeout to redesign work unless current evidence demonstrates a regression.

## Phase 1: Build an architecture-aware visual inventory — completed

Estimated time: 3–5 days.

Phase 1 is complete. Its screen-state archive, component and coupling matrix, icon audit, CSS and selector audit, measurements, sidebar behavior, properties-panel state matrix, migration decision, and later-phase acceptance checklist are recorded in [phase-1-visual-inventory.md](/Users/alexander/Personal%20Projects/open-pdf-studio/docs/ui-redesign/phase-1-visual-inventory.md). The selected migration is incremental restyling and recomposition of the existing shell in place; Phase 1 made no production UI or behavior changes.

Phase 0 already captured the main behavioral baseline. Phase 1 must remain read-only and document the visual system, component boundaries, coupling, and states that were not covered by Phase 0.

Capture the important interface states:

- No document open.
- PDF open in single-page mode.
- Continuous view.
- Annotation selected.
- Text being edited.
- Drawing tool active.
- Properties panel open.
- Compare mode.
- Organize-pages workflow.
- Print and preferences dialogs.
- Light and dark themes.
- Minimum supported window size.
- Context menus, dropdown menus, popovers, notifications, loading states, and disabled commands.
- Multiple annotations selected, mixed annotation types selected, and read-only states.
- Left panel, right properties panel, and docked or floating palettes in representative combinations.

Create the following inventories:

- Every reusable interface pattern: buttons, dropdowns, panels, tabs, dialogs, tool groups, menus, inputs, notifications, and status indicators.
- Every icon source, icon size, stroke or fill style, text glyph, and inconsistent icon treatment.
- Current typography, control heights, toolbar and tab heights, spacing, panel widths, borders, radii, and shadows.
- Global CSS import order, broad selectors, hard-coded colors, and selectors or classes referenced by behavior code.
- Existing sidebar minimum, default, and maximum widths; collapse behavior; persistence; resize handles; and viewport reflow behavior.

Classify each visible component into one of four coupling levels:

| Level | Meaning | Redesign rule |
| --- | --- | --- |
| Presentation-only | Receives data and emits an existing callback without owning document behavior | Safe to restyle and recompose while preserving its public inputs and outputs |
| Stateful UI adapter | Owns UI state or coordinates stores but does not directly mutate PDF content | Redesign carefully and preserve state transitions and side effects |
| PDF-coupled | Calls renderer, saver, page, tool, annotation, selection, or undo logic directly | Preserve callback delegation; do not move or duplicate document logic during visual work |
| Tauri-coupled | Calls platform wrappers or Tauri commands for windows, files, dialogs, or native behavior | Preserve command names, arguments, error handling, and macOS behavior |

Document the contextual properties-panel states for:

- No document and no selection.
- One annotation selected.
- Multiple compatible annotations selected.
- Mixed annotation types selected.
- Text editing, measurements, form fields, and read-only operations.

Choose the migration strategy before implementation begins: either incrementally restyle the existing shell in place or temporarily place new shell presentation behind a UI flag. Prefer incremental replacement unless a short prototype proves that maintaining two shells is worth the additional testing and coupling cost.

Phase 1 is complete only when the screen-state archive, component and coupling matrix, icon audit, CSS and selector audit, measurements, sidebar behavior, properties-panel state matrix, migration decision, and per-phase acceptance checklist are recorded. No production UI or behavior changes belong in this phase.

## Phase 2: Choose a visual direction

Estimated time: 3–5 days.

The Phase 2 kickoff direction is recorded in [phase-2-visual-direction.md](/Users/alexander/Personal%20Projects/open-pdf-studio/docs/ui-redesign/phase-2-visual-direction.md). The selected direction is a macOS-refined compact workspace; its acceptance gate must pass before Phase 3 production token work begins.

Create three variations within the already selected product direction rather than three unrelated styles:

1. Acrobat-inspired compact workspace — dense, neutral, contextual, and optimized for expert document work.
2. Balanced professional workspace — the same information architecture with slightly clearer grouping and breathing room.
3. macOS-refined compact workspace — restrained surfaces, platform-familiar controls, and careful integration with native window chrome.

Test each concept against the same representative screen: a PDF open with an annotation selected and both side panels visible.

Choose one direction and define:

- Typography.
- Color roles.
- Spacing scale.
- Corner radii.
- Borders and elevation.
- Control sizes.
- Icon style.
- Panel density.
- Light and dark appearances.
- Focus, hover, selected, disabled, loading, warning, and error states.
- Minimum and maximum sidebar behavior.
- Empty, single-selection, multi-selection, mixed-selection, and read-only properties-panel states.
- Toolbar overflow and narrow-window behavior.
- A consistent icon grid, optical size, stroke or fill rule, and accessible naming convention.

Avoid copying Acrobat directly. Its workflow can inform the information architecture, but Open PDF Studio should have its own identity.

Phase 2 is complete when one direction is approved using the same representative states in light and dark mode at 1400×900 and 800×600. Record the decision before production styling begins.

## Phase 3: Establish design foundations

Estimated time: 1–2 weeks.

Turn the chosen direction into shared design tokens in the existing theme system:

```text
Color
├── surface
├── elevated surface
├── canvas surround
├── border
├── primary text
├── secondary text
├── accent
├── selection
├── success
├── warning
└── destructive

Sizing
├── spacing
├── typography
├── control height
├── icon size
├── radius
├── shadow
└── panel width
```

Centralize these values in [themes.css](/Users/alexander/Personal%20Projects/open-pdf-studio/open-pdf-studio/styles/themes.css). Remove hard-coded colors gradually rather than attempting a repository-wide replacement.

Create both light and dark tokens from the beginning. Do not design light mode first and bolt dark mode on afterward.

Define interaction and accessibility states as part of the foundations rather than postponing them:

- Hover, pressed, selected, disabled, busy, warning, error, and read-only states.
- Visible keyboard focus and focus order.
- WCAG AA contrast for normal interface text.
- Accessible names for icon-only controls.
- Reduced-motion behavior.
- Comfortable pointer targets without oversized visual controls.

Because [styles.css](/Users/alexander/Personal%20Projects/open-pdf-studio/open-pdf-studio/styles.css) imports the application styles globally, introduce tokens first and migrate one component-specific stylesheet at a time. Do not begin with a broad rewrite of `base.css` or `layout.css`; global selectors can affect dialogs, overlays, panels, and viewport geometry.

Phase 3 is complete when the semantic tokens, typography scale, density rules, icon rules, and complete interaction-state specification work in light and dark mode without changing document behavior.

## Phase 4: Build reusable UI components

Estimated time: 2–4 weeks.

The first Phase 4 slice and its internal validation surface are recorded in [phase-4-component-gallery.md](/Users/alexander/Personal%20Projects/open-pdf-studio/docs/ui-redesign/phase-4-component-gallery.md).

Build only the reusable primitives required by the first real shell slice, then expand the set as workflows migrate. Start with:

- Primary, secondary, quiet, and destructive buttons.
- Icon buttons.
- Text fields and numeric inputs.
- Segmented controls.
- Tabs.
- Tooltips.
- Panel headers.
- Toolbar groups.
- Separators and resize handles.

Add split buttons, selects, color controls, menus, dialog shells, notifications, empty states, progress indicators, and status chips only when a migrated workflow needs them. This avoids creating speculative abstractions that do not match the application’s real states.

Keep business behavior separate from appearance. A redesigned Save button should call the existing Save action rather than implementing another saving path.

An internal component-gallery screen should validate components already used by a real application slice in light, dark, hover, pressed, selected, focus, disabled, busy, warning, error, and read-only states. It must not become an alternative implementation of document behavior.

Phase 4 is complete when the minimum shell primitives are used by one real slice, have accessible states, and delegate to the existing command owners.

## Phase 5: Modernize the application shell

Estimated time: 2–3 weeks.

The first shell modernization slice is recorded in [phase-5-shell-modernization.md](/Users/alexander/Personal%20Projects/open-pdf-studio/docs/ui-redesign/phase-5-shell-modernization.md). It modernizes the stable frame with preserved component behavior, responsive panel widths, and an explicit protected-viewport boundary.

Start with [App.jsx](/Users/alexander/Personal%20Projects/open-pdf-studio/open-pdf-studio/js/solid/App.jsx:67) and modernize the stable frame around the document:

- Title bar.
- Document tabs.
- Main workspace layout.
- Left navigation and panels.
- Properties inspector.
- Status bar.
- Empty-document screen.
- Panel resizing and collapsing.

Treat sidebar and palette behavior as measurable application behavior:

- Define minimum, default, and maximum widths for both primary sidebars.
- Preserve collapse and reopen behavior and decide whether widths persist between launches.
- Keep resize targets easy to acquire without making them visually heavy.
- Verify pointer feedback and keyboard accessibility where practical.
- Remeasure the PDF viewport during and after resizing without shifting annotation geometry.
- Verify combinations of the left panel, right properties panel, and docked or floating tool, symbol, and extension palettes.
- Keep the workspace usable at 800×600.

Do not change the PDF canvases, their IDs, or their stacking order during this phase. Treat the canvas region as protected infrastructure.

Validate macOS-specific shell behavior during this phase rather than postponing it to final rollout: traffic-light clearance, drag regions, title-bar double-click behavior, fullscreen, native shortcuts, detached document windows, Retina rendering, and native file or window commands.

The first major milestone should be: “The app looks modern with a PDF open, but all existing tools still work.”

## Phase 6: Replace the ribbon carefully

Estimated time: 2–4 weeks.

The first presentation slice is recorded in [phase-6-ribbon-modernization.md](/Users/alexander/Personal%20Projects/open-pdf-studio/docs/ui-redesign/phase-6-ribbon-modernization.md). It modernizes the existing command surface in place with the approved blue macOS-refined palette, consistent spacing, icon treatment, states, and retained adaptive overflow. Command labels, IDs, callbacks, and tab ownership remain unchanged until usage evidence supports a later information-architecture pass.

The current ribbon contains many commands, so removing it outright would create discoverability problems. Modernize it in stages:

- Reduce visual borders and background blocks.
- Establish consistent group spacing.
- Use one coherent icon family.
- Shorten labels where meaning remains clear.
- Move rare actions into overflow menus.
- Keep frequent actions visible.
- Show formatting and arrangement controls contextually.
- Add clear tooltips and keyboard shortcuts.
- Consider a searchable command palette for infrequent actions.

Use one documented icon system with a consistent grid, optical size, stroke or fill treatment, selected and disabled states, and accessible names. Maintain an explicit mapping from every legacy icon to its replacement so commands are not lost or accidentally duplicated.

Preserve the existing action wiring and command names. Change presentation first; reorganize functionality only after usage patterns are understood.

## Phase 7: Redesign one workflow at a time

Estimated time: 4–8 weeks.

Migrate complete vertical slices rather than disconnected components. A sensible order is:

1. Open, recent documents, and empty state.
2. Basic viewing and navigation.
3. Comment and annotation workflow.
4. Properties inspector.
5. Drawing and measurement tools.
6. Text editing.
7. Page organization.
8. Forms.
9. Compare mode.
10. Printing and export.
11. Preferences and account features.

The first slice is documented in [phase-7-open-recent-empty-state.md](./phase-7-open-recent-empty-state.md); completing it does not mark the remaining Phase 7 workflows complete.

For the properties-inspector workflow, implement and test every documented Phase 1 context: no document, no selection, one annotation, compatible multi-selection, mixed selection, text editing, measurement, form field, and read-only states. Contextual presentation must continue delegating edits to the existing properties store and undo path.

For each workflow:

- Capture the current state.
- Define the improved flow.
- Update its components and styles.
- Test mouse and keyboard interactions.
- Test narrow and large windows.
- Test light and dark mode.
- Save, reopen, and confirm the document result is unchanged.
- Verify translated and long labels where the workflow contains visible text.
- Commit the completed vertical slice independently before starting the next one.

## Required gate for every implementation phase

Do not wait until final rollout to test the redesign. Every independently committed implementation slice must pass the checks relevant to its surface.

Always run:

```sh
npm run test:ui-contract
npm run typecheck
npm run test:unit
npm run test:quality
```

Run the live Phase 0 protocol after shell, tabs, toolbar, panels, properties, status-bar, or viewport-adjacent work:

```sh
node tests/protocol/runner.mjs 00-ui-redesign-baseline
```

Also run:

- `a-home` after Home toolbar, common command, zoom, navigation, Find, or related dialog changes.
- `a-view` after document-tab, view-mode, panel, compare, fullscreen, or window changes.
- Deterministic screenshots at 1400×900 and 800×600 in light and dark mode.
- Mouse, keyboard, focus, disabled, read-only, overflow, and narrow-window checks for the changed surface.
- Save As and reopen whenever a changed workflow can mutate document state.

Each phase should end with a small, reviewable commit and a recorded test result. If a gate fails, fix or revert that slice before beginning the next phase.

## Phase 8: Improve interaction quality — completed

Estimated time: 2–3 weeks.

Phase 8 is complete. The shared interaction layer, workflow-wide confirmations,
Escape/focus behavior, tooltip metadata, busy/progress semantics, and reduced
motion support passed the recorded static and live gates in
[phase-8-interaction-quality.md](/Users/alexander/Personal%20Projects/open-pdf-studio/docs/ui-redesign/phase-8-interaction-quality.md).

Interaction states and accessibility begin in Phase 3 and are required by every implementation gate. This phase is a cross-workflow consistency pass for behavior that could not be resolved inside an individual slice:

- Consistent hover and pressed feedback.
- Clearly visible keyboard focus.
- Predictable panel animation.
- Tooltips with shortcut labels.
- Larger hit targets without oversized visuals.
- Proper disabled and busy states.
- Non-blocking progress feedback.
- Useful empty states.
- Reduced-motion support.
- Consistent confirmation for destructive actions.
- Escape-to-cancel behavior.
- Native-feeling macOS keyboard conventions.

Keep animation restrained. A document editor should feel fast and stable, not theatrical.

## Phase 9: Accessibility and density — completed

Estimated time: 1–2 weeks initially, then continuous.

Phase 9 is complete. The shared accessibility and density implementation and
its recorded static/live gates are documented in
[phase-9-accessibility-density.md](phase-9-accessibility-density.md).

Audit the measurable requirements already applied throughout the earlier phases and close remaining gaps:

- At least WCAG AA contrast for normal interface text.
- All major commands keyboard-accessible.
- Focus never hidden.
- Icons have accessible names.
- Color is not the only status indicator.
- Controls remain usable at the minimum 800×600 window size.
- Interface remains comfortable on Retina and non-Retina displays.
- Users can choose comfortable or compact density later.

Professional users often prefer density. “Modern” should not mean excessive whitespace or hiding important commands.

## Phase 10: Rollout and cleanup

Estimated time: 2–4 weeks.

Use the migration strategy selected in Phase 1. If a temporary “Modern interface” flag was chosen, remove it only after the replacement has passed the full rollout gate. Do not introduce a second-shell strategy for the first time during cleanup.

Before making it the default:

- Run existing unit and render tests.
- Add screenshot checks for core UI states.
- Run the MCP-driven interaction scenarios.
- Test every ribbon action.
- Verify canvas sizing after panel changes.
- Test window resizing and restoration.
- Test detached document windows.
- Test multiple languages and long translated labels.
- Test light, dark, system, and high-contrast themes.
- Remove the old styles only after the replacement is stable.

## Code areas to change first

The safest initial scope is deliberately narrow:

- [themes.css](/Users/alexander/Personal%20Projects/open-pdf-studio/open-pdf-studio/styles/themes.css)
- The dedicated stylesheet for the one component currently being migrated.
- Presentation-only components identified by the Phase 1 coupling matrix.
- Thin visual wrappers that delegate to existing callbacks without duplicating behavior.

Treat these as coupled rather than automatically safe:

- [base.css](/Users/alexander/Personal%20Projects/open-pdf-studio/open-pdf-studio/styles/base.css) and [layout.css](/Users/alexander/Personal%20Projects/open-pdf-studio/open-pdf-studio/styles/layout.css), because their global selectors can affect many surfaces and viewport geometry.
- `js/solid/stores/`, because some stores mutate annotations, record undo, recalculate measurements, redraw, or coordinate platform behavior.
- Shell components that import renderer, saver, tool, undo, document-state, or Tauri APIs directly.
- DOM IDs and classes queried by imperative modules.

Avoid changing these during the first visual passes:

- `js/pdf/renderer.js`
- `js/pdf/pdf-viewport.js`
- `js/pdf/progressive-render.js`
- `js/annotations/rendering.js`
- Rust rendering code
- PDF saving logic

## Major risks

The main danger is accidentally treating the UI as independent from application behavior. Older modules locate elements through fixed IDs and classes, so renaming or restructuring markup can break functionality without producing a compiler error.

Other risks include:

- Global CSS rules leaking into unrelated dialogs or canvases.
- Panel changes producing incorrect canvas measurements.
- Removing expert commands in the name of simplicity.
- Inconsistent old and new components during migration.
- Hard-coded annotation colors being mistaken for theme colors.
- Custom title-bar behavior conflicting with macOS window controls.
- Translated labels overflowing redesigned controls.
- Visual improvements proceeding without interaction regression tests.
- Treating all Solid stores as presentation state when some are document-behavior owners.
- Building a speculative component library that does not support real application states.
- Maintaining two complete shells longer than necessary and doubling the regression surface.

Maintain the Phase 0 known-issues ledger throughout the redesign. Existing Solid disposal warnings, startup jank, PDFium shared-memory worker recovery, Node module warnings, and screenshot timing limitations are baseline evidence. Record any changed frequency, severity, or new error separately.

The best first implementation milestone is a modern application shell, Home ribbon tab, and properties panel using shared design tokens while leaving every PDF and annotation behavior unchanged.
