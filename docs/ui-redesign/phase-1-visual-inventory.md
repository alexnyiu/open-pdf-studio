# Phase 1 visual inventory and migration decision

Phase 1 is a documentation-only inventory of the current desktop interface. It does not change production markup, styling, rendering, saving, stores, or platform behavior. The Phase 0 behavioral contract remains binding.

## Evidence boundary

This inventory combines source inspection with the existing live Tauri protocol. On 2026-08-13 the current debug app was rechecked at 1400 x 900 with `00-ui-redesign-baseline`: all 16 assertions passed. The no-document state was also live-probed after closing the test tabs, and the fixture was reopened afterward. At 800 x 600 the ribbon remained visible and interactive, but Phase 1 does not claim that every ribbon group, panel combination, or translated label fits at that size; those remain explicit acceptance checks for later implementation phases.

The protocol's `app_screenshot_view` endpoint captures the PDF viewport rather than the complete native window. Current generated captures remain under ignored `tests/protocol/results/` directories and are reproducible evidence, not source-controlled design assets. The archive below therefore records each state, its current owner, and the strongest available evidence instead of presenting viewport-only images as full-window screenshots.

Phase 1 completion checks produced the following honest baseline:

- `npm run test:ui-contract`: 3/3 passed.
- `00-ui-redesign-baseline`: 16/16 passed.
- `a-home`: 29/31 passed. Its two zoom-button assertions read legacy `doc.scale`, which remained 1.5 before and after the clicks.
- `a-view`: 27/28 passed. Its rotation assertion also expected legacy `doc.scale` to change, but it remained 1.5.

Those three live failures are not attributed to Phase 1 because Phase 1 changed documentation only, and the Phase 0 contract already records that the raster viewport's `window.__pdfViewport.zoom` can be authoritative while `doc.scale` remains unchanged. The failing assertions should be audited against the active viewport in a separate test-maintenance task; Phase 1 does not alter either the tests or zoom behavior.

## Screen-state archive

| State | Current presentation and behavior | Primary owner | Evidence |
| --- | --- | --- | --- |
| No document | Title bar, ribbon, empty document-tabs row, empty placeholder, side panels, and status bar remain mounted. The center says “No PDF Selected” and offers Open PDF. | `App.jsx`, `DocumentTabs.jsx`, `StatusBar.jsx` | Live-probed; `#placeholder` visible after the final tab closed |
| PDF open, single page | `#pdf-container` replaces the placeholder; the protected three-canvas stack is centered inside `#canvas-wrapper`. | `App.jsx`, `pdf/renderer.js` | Phase 0 live baseline |
| Continuous view | `#continuous-container` owns per-page wrappers while the same surrounding shell stays mounted. | `pdf/renderer.js`, `progressive-render.js` | Phase 0 live baseline |
| Book and facing views | Both are continuous variants with spread flags; ribbon and status controls mirror the active mode. | `ViewTab.jsx`, `StatusBar.jsx`, `pdf/renderer.js` | Phase 0 live baseline and `a-view` |
| One annotation selected | Selection handles appear on the annotation canvas; Format/Arrange contextual tabs and the properties panel become relevant. | selection helpers, `ribbonStore.js`, `propertiesStore.js` | Phase 0 live baseline |
| Compatible multi-selection | Shared values are shown; differing values use `mixed`; compatible appearance and text groups remain editable. | `propertiesStore.storeShowMultiSelection` | Source-verified; later workflow capture required |
| Mixed annotation types | Type label becomes a translated multi-select label; controls are restricted to properties supported by every selected item. | `propertiesStore.storeShowMultiSelection` | Source-verified; later workflow capture required |
| Text editing | The PDF text editor overlay appears; the properties panel switches to `textEdit` and shows only text-format controls. | `text-edit-tool.js`, `PdfTextEditOverlay.jsx`, `propertiesStore.js` | Source-verified; later workflow capture required |
| Drawing tool active | The selected ribbon button and `currentTool` change; canvas cursor, pointer routing, and contextual controls are tool-owned. | Drawing/Comment tabs, `tools/manager.js` | Existing `a-drawing` and `a-comment` protocol coverage |
| Measurement selected | General, appearance, line-ending/dimension as applicable, and measurement controls are shown. Scale, unit, and precision write through the properties store. | `MeasurementSection.jsx`, `propertiesStore.js` | Source-verified |
| Form field | The form layer is above the page canvas; the left Form Fields panel groups fields. Form editing does not use the annotation properties state matrix consistently. | `pdf/form-layer.js`, `FormFieldsPanel.jsx` | Source-verified; workflow capture required |
| Read-only or locked item | Locked items disable most property controls. `readOnly` is represented as annotation metadata, but most panel disable guards currently check `locked`, not `readOnly`. | property sections, `propertiesStore.js` | Source-verified; this mismatch is a redesign constraint, not a Phase 1 fix |
| Properties panel open/collapsed | Expanded width is 300 px; collapsed width is 28 px with vertical text. Visibility and collapse are separate signals. | `PropertiesPanel.jsx`, `properties-panel.css` | Source-verified and `a-view` |
| Left navigation open/collapsed | Expanded default is 200 px plus a 4 px handle; collapsed width is 32 px and the resize handle disappears. | `LeftPanel.jsx`, `leftPanelStore.js`, `ui/setup.js` | Source-verified and `a-view` |
| Docked/floating palettes | Tool, symbol, and extension palettes can be ordered and docked left or right, or float over the main view. | `App.jsx`, palette components and stores | Source-verified and partial `a-view` coverage |
| Compare | A compare dialog chooses documents; active compare adds a separate `CompareView` inside the protected PDF container and a compare document tab. | `CompareDialog.jsx`, `CompareView.jsx`, compare store | Dialog live-covered by `a-view`; active comparison needs a later workflow capture |
| Organize pages | Organize ribbon exposes edit, crop, resize, rotate, insert, delete, extract, reorder, merge, watermark, and header/footer commands. Reorder opens the left thumbnail panel. | `OrganizeTab.jsx`, page manager, dialogs | Existing `a-organize` coverage |
| Print dialog | Modal shell with printer, range, copies, layout, preview, and native print delegation. | `PrintDialog.jsx`, platform wrapper | Source-verified; native printer-dependent states remain environment-specific |
| Preferences dialog | Modal with General, Page Display, Annotations, Behavior, language, file association, and virtual printer sections. | preferences components and store | Live-covered by `a-home` |
| Menus, dropdowns, popovers | App menu, context menus, split-button menus, color pickers, hatch picker portal, tab menu, and tooltips use separate positioning and styling conventions. | `AppMenu.jsx`, `ContextMenu.jsx`, ribbon primitives, panel sections | Source-verified; representative menu live-covered by existing scenarios |
| Notifications/loading | Notification, PDF/A, form-fields, loading, print-progress, schedule, assistant, and message surfaces use several bar, overlay, toast, and modeless-panel patterns. | corresponding shell components and stores | Source-verified |
| Light/dark/other themes | Seven selectors exist: default, light, dark, blue, amber navy, warm ember, and high contrast. Theme selection is global on the document element. | `themes.css`, `ThemePicker.jsx` | Light and dark live-covered by Phase 0 |
| Minimum 800 x 600 | The shell and ribbon remain mounted. Width pressure is handled by adaptive ribbon groups and horizontal tab overflow, but combined side panels can leave too little viewport space. | shell CSS, `AdaptiveGroups.jsx` | Live-probed at 800 x 600; full combination matrix is a later gate |

## Reusable interface-pattern inventory

| Pattern | Current implementations | Consolidation boundary |
| --- | --- | --- |
| Command buttons | `RibbonButton`, quick-access buttons, status navigation buttons, panel toolbar buttons, `pref-btn`, icon-only close buttons | Preserve callback owners, disabled guards, IDs, titles, and accessible names before restyling |
| Grouped commands | `RibbonGroup`, `RibbonButtonStack`, adaptive/overflow ribbon groups, status control groups | Ribbon grouping is behavior-aware because overflow measures live widths |
| Split buttons/dropdowns | `SplitButton`, screenshot menu, style menus, color picker, native/select-like preference controls | Portal/positioning and outside-click behavior must be retained |
| Tabs | Ribbon tabs, document tabs, preference tabs, left-panel icon tabs, app-menu panels | These share a visual concept but have different state owners and keyboard behavior |
| Panels/inspectors | Left navigation, properties, element visibility, schedule, assistant, tool/symbol/extension palettes | Panel presence changes the PDF viewport and must trigger correct remeasurement |
| Dialogs | Shared `Dialog` shell plus specialized modal/modeless dialog layouts | Preserve platform calls, focus/escape behavior, and native-dialog boundaries |
| Menus | App menu, annotation/page/text context menus, document-tab menu, palette context menu | Imperative callers rely on existing selectors and event coordinates |
| Inputs | Text/number fields, textarea, select, editable combo, checkboxes, sliders, color inputs | Mixed, locked, read-only, validation, units, and undo semantics vary by workflow |
| Notifications/status | Notification bars, PDF/A and form bars, loading overlay, status bar, print toast, message dialog | Do not merge blocking, persistent, transient, and informational semantics |
| Empty/loading states | Main no-document placeholder, empty left-panel collections, dialog empty states, loading overlay | Empty state copy and enabled command behavior depend on document state |
| Resize/dock affordances | Left-panel handle, dialog edges, floating palette drag/dock targets | These are behavioral hit targets, not decoration |

## Component and coupling matrix

Classification uses the highest coupling present in the current component. A visually simple component is not “presentation-only” when it owns state transitions or calls document/platform code.

| Surface or component family | Level | Current dependency boundary | Redesign rule |
| --- | --- | --- | --- |
| `RibbonButton`, `RibbonGroup`, `RibbonButtonStack`, `CollapsibleSection`, `PanelHeader` | Presentation-only | Props, children, and existing callbacks | Safe first candidates for visual tokens if IDs, events, and semantics stay stable |
| `Ribbon`, `AdaptiveGroups`, `ThemePicker`, `FindBar`, `LoadingOverlay`, `NotificationBar` | Stateful UI adapter | UI stores, measured overflow, visibility and theme state | Preserve transitions, outside-click behavior, and store ownership |
| `App` desktop shell | Stateful UI adapter | Composes every panel, palette, overlay, and protected viewport | Recompose only around the Phase 0 viewport boundary |
| Home/View/Organize/Comment/Drawing/Format/Arrange tabs | PDF-coupled | Renderer, page manager, tools, selection, annotations, undo, dialogs | Restyle in place; keep command IDs and delegate to existing owners |
| `StatusBar` | PDF-coupled | Page navigation, view mode, zoom, active document state | Do not create a second navigation or zoom state path |
| `PropertiesPanel` and sections | PDF-coupled | `propertiesStore` mutates annotations, records undo, recalculates measurements, and redraws | Presentation may change; all edits must continue through the store |
| Left-panel collections and thumbnails | PDF-coupled | Page navigation, thumbnail generation, page manager, selection, annotation lists | Preserve lazy loading, active-page sync, and resize/collapse behavior |
| `ContextMenu`, sticky note, text and box overlays | PDF-coupled | Selection, tools, annotations, undo, page geometry | Keep canvas-coordinate and event-routing assumptions intact |
| Tool, symbol, and extension palettes | PDF-coupled | Tool manager, symbol/plugin stores, docking order | Preserve tool activation and dock/floating state; avoid duplicate palettes |
| `TitleBar` | Tauri-coupled | Native window controls plus save/open/undo/redo shortcuts | Preserve drag/no-drag regions and macOS window behavior |
| `DocumentTabs` | Tauri-coupled | Tab/document state plus detached-window `invoke` | Preserve file identity, dirty state, drag/re-dock, and native window calls |
| `AppMenu` and Open/Import/Export panels | Tauri-coupled | Saver, loader, platform filesystem/dialog wrappers, sessions/places | Keep native dialog and error paths unchanged |
| Print, update, file-association, feedback and native preferences surfaces | Tauri-coupled | `invoke`, relaunch, external URLs, filesystem and print services | Style only after platform-specific acceptance tests exist |

## Icon audit

The three shared icon modules contain 181 exported SVG constants: 116 ribbon, 52 context-menu, and 13 left-panel icons. The system is visibly mixed:

- Left-panel icons are consistently 24 x 24, outline, `fill="none"`, and `stroke="currentColor"`.
- Context-menu icons mix 16 x 16 and 24 x 24 sources and mix filled with outlined forms.
- Ribbon icons use at least six viewBox shapes (`16 x 16`, `24 x 24`, `24 x 26`, `32 x 32`, `8 x 14`, and `8 x 5`) and both fill and stroke conventions.
- Inline SVGs also exist in components, so the three modules are not the complete icon set.
- Text glyphs are used as controls for close, add, expand, zoom, and formatting (`×`, `✕`, `x`, `+`, `−`, `B`, `I`, `U`, `S`). Their weight and optical alignment depend on the current font.
- Common rendered sizes include 12, 14, 16, 18, 20, 22, 24, 28, and 32 px, with no single optical-size rule.

Phase 2 must choose one base grid, stroke/fill policy, optical sizes, selected/disabled treatment, and accessible-name convention. Migration needs an explicit legacy-name-to-new-icon map; no command may disappear because two old icons look similar.

## CSS and selector audit

`styles.css` imports 24 global stylesheets in this order:

1. `base.css`, `fonts.css`, `themes.css`
2. `titlebar.css`, `app-menu.css`, `ribbon.css`, `document-tabs.css`, `layout.css`
3. `text-layer.css`, `form-layer.css`, `properties-panel.css`, `panels.css`, `page-controls.css`, `context-menu.css`, `dialogs.css`
4. `tool-palette.css`, `symbol-palette.css`, `schedule-panel.css`, `assistant.css`, `mini-log.css`, `status-bar.css`, `find-bar.css`
5. `rtl.css`, then `mobile.css`

Current lexical snapshot:

| Measure | Count | Meaning |
| --- | ---: | --- |
| CSS source lines | 14,993 | The styling surface is large enough that broad rewrites are high risk |
| Unique theme variables | 133 | There is a substantial token base, but naming is component-oriented and incomplete |
| Hard-coded color tokens outside `themes.css` | 1,126 | Includes fallbacks and PDF/content colors as well as UI colors; migration must classify rather than bulk-replace |
| `!important` declarations | 20 | Several protect display state or override injected text-layer rules |
| Inline `style=` uses in Solid JS/JSX | 330 | Some are geometry-dependent and some are presentation debt |
| DOM lookup calls in behavior JS | 268 across 52 files | IDs/classes are compatibility surface, not free-to-rename CSS hooks |

High-risk global rules include the universal box-model/scrollbar reset, the global `body` application shell, broad cursor forcing across shell descendants, global dialog/input selectors, and final RTL/mobile overrides. `base.css` and `layout.css` must not be the first visual migration target. `text-layer.css`, `form-layer.css`, viewport IDs, page-wrapper classes, annotation canvases, and dialog positioning rules are protected behavior-adjacent CSS.

The most common font sizes are 11 px (184 declarations), 12 px (148), 10 px (65), and 13 px (31). Border radii are mostly square: `0` appears 80 times, followed by 3 px (24), 2 px (15), and 4 px (11). Shadows use many one-off values. These observations support a later compact density scale, not an immediate global replacement.

## Measurements and sidebar behavior

| Element | Current measurement or rule |
| --- | --- |
| Title bar | 30 px high; quick actions 22 px; native window buttons 40 x 30 px |
| Ribbon tabs/content | 28 px tab row plus 94 px content row; total about 122 px before borders |
| Document tabs | 28 px high; tabs 140–240 px wide; horizontal overflow |
| Status bar | 22 px high; main navigation targets 20 x 20 px |
| Left navigation | 200 px default; 120–500 px drag clamp; 32 px collapsed; 4 px resize handle |
| Element visibility panel | Fixed 230 px |
| Properties inspector | Fixed 300 px expanded; 28 px collapsed; no resize handle |
| Context menu | 220 px minimum for the main menu; 150 px for submenu variants |
| Main shell typography | Segoe UI-first stack; most dense controls 10–12 px |
| Minimum target window | 800 x 600 per redesign plan; no existing CSS `min-width` prevents narrower native windows |

Left-panel collapse preserves only the current inline width in `data-prev-width` for the current mounted element. Width is not saved to preferences or local storage, so it does not survive a restart. The resize code accounts for RTL and clamps at 120 and 500 px. Collapsing clears the inline width, hides the body and resize handle, and reopening restores the remembered inline value when present.

The properties panel has separate `panelVisible` and `panelCollapsed` signals. Its width is fixed rather than resizable. Collapsed property *sections* persist through `state.preferences.collapsedPropSections`, but the panel width/collapse state is not documented as restart-persistent. Later shell work should keep viewport remeasurement explicit for every left/right/docked-palette combination.

## Properties-panel state matrix

| Context | Mode/visibility | Sections and edit behavior | Required redesign treatment |
| --- | --- | --- | --- |
| No document, no selection | `none`; panel may remain visible | `DocInfoView` shows no-file placeholders; annotation sections hidden | Deliberate empty inspector, not a broken-looking blank panel |
| Document, no selection | `none` | Document filename, path, page, size, metadata, and annotation counts | Keep document info distinct from selection properties |
| One annotation | `annotation` | Sections computed from annotation type; values write through `updateAnnotProp` | Preserve undo, redraw, measurement recalculation, and plugin hooks |
| Compatible multi-selection | `multi` | Shared values or `mixed`; only universally compatible controls shown | Make mixed values explicit and avoid implying destructive normalization |
| Mixed annotation types | `multi` | General, appearance subset, actions; type-specific sections suppressed | Explain limited shared editing and preserve all-selection guards |
| PDF text editing | `textEdit` | Text format only; pseudo annotation `_pdfTextEdit` | Visually distinguish content editing from annotation formatting |
| Measurement | `annotation` | Measurement plus relevant appearance/dimension sections | Keep unit, scale, precision, and dependent recalculation visible |
| Form field | separate form-layer path | Left-panel/form UI rather than a unified inspector state | Phase 7 must choose a consistent presentation without moving form logic |
| Locked | `annotation` or `multi` | Most controls disabled; lock control can still unlock | Clear disabled reason and retain current unlock path |
| Read-only | metadata may be true or mixed | Current disable guards generally key off `locked`, not `readOnly` | Treat as a documented gap; define and test read-only semantics before styling it as enforced |
| Plugin annotation | `annotation` | Registry may mount `CustomPluginPanel` | New inspector composition must retain plugin extension points |

## Migration decision

Use **incremental restyling and recomposition of the existing shell in place**. Do not introduce a second full shell or a “Modern interface” feature flag during the initial migration.

Reasons:

- The current shell is deeply coupled to renderer, saver, undo, tool, store, and Tauri owners. Two shells would double the compatibility surface.
- Fixed IDs/classes are used by 52 behavior files, so a parallel shell would either duplicate those hooks or require premature behavior extraction.
- The protected viewport can stay untouched while presentation-only primitives and one real shell slice adopt tokens.
- Existing protocol tests already exercise the current callback paths and are most valuable when the same paths remain in place.

A temporary flag is allowed only for a narrowly scoped visual primitive or prototype that does not mount a second document shell, duplicate document state, or alter the protected viewport.

## Acceptance checklist for later phases

Every implementation phase must first pass the common gate in `phased-redesign-plan.md`. The phase-specific evidence is:

- Phase 2: one direction approved on the same PDF-open/annotation-selected/both-panels state at 1400 x 900 and 800 x 600, in light and dark, including overflow and all inspector contexts.
- Phase 3: semantic tokens, density, typography, icon, focus, disabled, loading, warning, error, read-only, and reduced-motion specifications work in all themes without viewport drift.
- Phase 4: only primitives required by one real slice are added; the slice delegates to existing callbacks and has accessible names and keyboard focus.
- Phase 5: shell, panel collapse/resize, docked/floating palettes, tabs, status bar, empty state, macOS drag regions, fullscreen, detached windows, and Retina behavior pass; protected canvas IDs/order are unchanged.
- Phase 6: every legacy ribbon command has a mapped destination and icon; frequent commands stay visible; overflow works at 800 px; keyboard shortcuts and disabled states are unchanged.
- Phase 7: each workflow covers mouse, keyboard, narrow/large windows, light/dark, translated labels, save/reopen when applicable, and the complete properties-state matrix above.
- Phase 8: hover, pressed, focus, busy, cancellation, destructive confirmation, tooltip, and reduced-motion behavior is consistent across migrated workflows.
- Phase 9: WCAG AA text contrast, visible focus, accessible icon names, non-color status cues, minimum-size usability, and compact/comfortable density are measured rather than assumed.
- Phase 10: full ribbon coverage, live protocol suite, deterministic full-window screenshots, resizing/restoration, detached windows, all supported themes, long translations, and old-style cleanup pass before the migration is made final.

## Phase 1 completion record

Phase 1 is complete when this file and the Phase 0 contract are reviewed together. The recorded decision is incremental in-place migration. No production UI or behavior was changed in Phase 1.
