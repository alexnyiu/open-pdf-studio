# Phase 0: behavioral contract

This baseline freezes the current desktop UI-to-document behavior before any redesign. It is a compatibility contract, not a visual specification. Phase 0 must not change rendering, editing, saving, command semantics, or layout styling.

## Clean starting point

The Phase 0 work started on 2026-08-13 on branch `ui-overhaul`, tracking `origin/ui-overhaul`. `git status --short --branch` showed no modified or untracked files before the first change.

## Protected PDF viewport

The following structure in `open-pdf-studio/js/solid/App.jsx` is behavior-sensitive and must be preserved through the redesign unless a separate PDF-behavior change is explicitly planned and tested:

```text
#pdf-container
└── #canvas-wrapper
    ├── #canvas-container.single-page-container
    │   ├── canvas#pdf-canvas
    │   ├── canvas#text-highlight-canvas
    │   └── canvas#annotation-canvas
    └── #continuous-container.continuous-container
    + CanvasScrollbars
    + CompareView
```

| ID / node | Existing responsibility | Protection rule |
| --- | --- | --- |
| `pdf-container` | Scrollable viewport, pointer/zoom coordinate frame, screenshot and MCP viewport probe target | Keep the ID and its role as the viewport boundary |
| `canvas-wrapper` | Groups single-page and continuous render roots | Keep it inside `pdf-container` |
| `canvas-container` | Single-page canvas stacking and page-relative geometry | Keep the ID and `single-page-container` class |
| `pdf-canvas` | PDF page pixels and the exported `pdfCtx` 2D context | Keep exactly one single-page base canvas |
| `text-highlight-canvas` | Search/text-selection highlight overlay | Keep stacked after the PDF canvas |
| `annotation-canvas` | Annotation rendering and hit-testing overlay | Keep stacked after the highlight canvas |
| `continuous-container` | Continuous, book, and facing page render host | Keep the ID and `continuous-container` class |
| `CanvasScrollbars` | Custom viewport scroll controls | Keep attached to the viewport rather than a redesigned shell wrapper |
| `CompareView` | Alternate compare presentation in the viewport | Keep attached to the same viewport boundary |

`open-pdf-studio/js/ui/dom-elements.js` resolves these IDs directly and exports live references and 2D contexts. PDF rendering, annotations, tools, screenshots, scroll/zoom, and test instrumentation also query this structure. The automated `test:ui-contract` guard fails if these IDs, their order, or the direct DOM bindings drift.

## Visible command callback contract

The UI may be restyled or recomposed later, but visible commands must continue delegating to these existing owners. Redesign components should call these functions rather than duplicating their logic.

| Visible surface | Commands | Existing callback / behavior owner |
| --- | --- | --- |
| Title bar quick actions | Open, Save, Save As, Print, raster export | `pdf/loader.openPDFFile`, `pdf/saver.savePDF`, `pdf/saver.savePDFAs`, `ui/chrome/dialogs.showPrintDialog`, export helper |
| Title bar history | Undo, Redo | `core/undo-manager.undo`, `core/undo-manager.redo` |
| File menu | New, Open, Save, Save As, Print, document properties, preferences, exit | Existing dialog, loader, saver, preferences, tab-unsaved-check, and platform callbacks in `components/app-menu/AppMenu.jsx` |
| Document tabs | Activate, close, add/open, rename, reorder, detach/re-dock, reveal in Finder | `ui/chrome/tabs` callbacks plus the existing `invoke` calls for Tauri window/file operations |
| Home toolbar | Hand/select tools, zoom in/out, actual size, Fit Width, Fit Page, page navigation, Find | `tools/manager.setTool`, `pdf/renderer` functions, `search/find-bar.openFindBar` |
| View toolbar | Single, continuous, book, facing, rotate, panel toggles, compare, fullscreen | `pdf/renderer.setViewMode` / `rotatePage`, undo rotation recording, existing panel stores/helpers, compare store, platform fullscreen |
| Status bar | First/previous/next/last page, page input, view modes, zoom input/in/out | The same `pdf/renderer.goToPage`, `setViewMode`, `setZoom`, `zoomIn`, and `zoomOut` paths used elsewhere |
| Thumbnail panel/items | Select/navigate, reorder, insert, context actions | Thumbnail store plus `pdf/renderer.goToPage`, page manager, existing dialogs/context actions |
| Organize toolbar | Text edit/add, crop/resize, rotate, insert/delete/extract/reorder/merge, watermark/header-footer | Existing tool manager, PDF renderer/page manager, undo manager, and dialogs |
| Comment toolbar | Annotation tools, clear/apply redactions, schedules and defaults | Existing tool manager, annotation collections/renderers, selection helpers, undo manager, saver/redaction functions |
| Properties panel | Annotation text, appearance, geometry, measurement, metadata and multi-selection edits | `solid/stores/propertiesStore.updateAnnotProp`; this records undo, mutates the selected annotation(s), recalculates dependent measurements where needed, and redraws |
| Window/platform actions | Minimize, maximize, close, detached tabs, reveal file | Existing `core/platform` wrappers and Tauri `invoke` commands |

## Coupling boundaries

The protected viewport and the callback owners above are tightly coupled to PDF behavior. The shell components are also stateful adapters rather than presentation-only components: many import renderer, saver, tool, undo, state, and Tauri APIs directly. Later phases may extract thin command adapters, but must not move or rewrite document logic while changing the visuals.

Zoom state has an important dual-path detail. When the raster viewport is active, `window.__pdfViewport.zoom` is the rendered zoom source of truth; the legacy document `scale` can remain unchanged. Tests and redesigned zoom controls must use the existing renderer API and must not infer the rendered zoom from `doc.scale` alone.

Safe redesign scope after this baseline includes CSS tokens, typography, icon presentation, toolbar and tab chrome, panel headers, separators, hover/selected/disabled/focus styling, and shell composition around the protected viewport. Changes are safe only while preserving the IDs, callback delegation, state ownership, keyboard behavior, disabled/read-only guards, and panel/tool side effects documented here.

## Core interaction smoke test

Run the focused protocol scenario against a live debug Tauri app:

```sh
node tests/protocol/runner.mjs 00-ui-redesign-baseline
```

The scenario uses the committed 14-page PDF.js fixture as read-only input and writes its Save As round-trip only to `/private/tmp/open-pdf-studio-phase-0-roundtrip.pdf`. It checks:

- opening an existing PDF and navigating to page 2;
- explicit zoom, Fit Page, and Fit Width;
- single, continuous, book, and facing modes;
- textbox creation, selection, property editing, undo, and redo;
- Save As followed by reopening the output;
- switching between the source and reopened document tabs;
- applying light and dark themes, then restoring the default theme;
- the existing render-observability console buffer at open and at the end;
- baseline screenshots for the open document, selected annotation, light theme, and dark theme.

The generated reports and screenshots live under ignored `tests/protocol/results/` directories. They are evidence for a run, not source-controlled visual redesign assets.

Run the static contract guard independently with:

```sh
npm run test:ui-contract
```

It is also part of `npm run test:quality` so protected viewport or callback drift is caught by the normal quality suite.

## Baseline result

Verified on 2026-08-13 with the existing debug Tauri binary at a deterministic 1400 x 900 window size:

- `npm run test:ui-contract`: passed, 3/3 checks.
- `npm run typecheck`: passed.
- `npm run test:unit`: passed, 87/87 tests.
- `npm run test:quality`: passed, 26/26 tests, including the 3 new UI contract checks.
- `00-ui-redesign-baseline`: passed, 16/16 assertions. The 14-page fixture opened, page 2 loaded, zoom reached 125%, Fit Page returned 84.47%, Fit Width returned 97.22%, all four view modes activated, an annotation was edited and survived undo/redo, Save As succeeded, and the 14-page output reopened with its annotation present.
- Existing `a-home` visible-command smoke scenario: passed, 31/31 assertions, including toolbar page navigation, zoom, actual size, Fit Page, Fit Width, tool selection, Find, and dialogs.
- Existing `a-view` visible-command smoke scenario: passed, 28/28 assertions, including document tabs, all view modes, rotation, panel toggles, compare dialog, fullscreen availability, and the keystroke overlay.
- Light and dark theme selectors both applied successfully; the scenario restored the default theme afterward.
- Four 1200-pixel viewport captures were generated in the ignored protocol-results directory: open document, selected edited annotation, light theme, and dark theme.
- `/private/tmp/open-pdf-studio-phase-0-roundtrip.pdf` was independently inspected as a readable 14-page, 612 x 792 point PDF.

### Existing issues and evidence limits

- The browser-mode shell emitted no error-level console messages, but emitted 13 repeated Solid warnings: `computations created outside a createRoot or render will never be disposed`. These warnings existed before any visual redesign.
- The live native render-observability buffer emitted one startup `[JANK] Main thread was blocked for 1074ms!` warning in the passing run. The remaining captured entries were normal render, thumbnail, and performance logs; no error-level entry was captured.
- After the visible-command scenarios, the native terminal reported one PDFium worker crash and recovery. A 128,253,440-byte bitmap exceeded the 67,108,864-byte shared-memory cap, so rendering fell back to the in-process path and the worker respawned. Both UI scenarios still passed. This is an existing renderer resilience/performance issue and must not be attributed to a shell redesign.
- The unit suite emits Node `MODULE_TYPELESS_PACKAGE_JSON` warnings for ES-module source files because the package does not declare `"type": "module"`. Tests still pass. Phase 0 deliberately does not change package module semantics.
- A 2000-pixel protocol viewport screenshot timed out once while the initial thumbnail work was active. The baseline scenario now waits for settling and captures at 1200 pixels, which passed on a clean run. This is a test-instrumentation/performance limitation, not evidence of a PDF behavior regression.
- The in-app render buffer intentionally captures render-related patterns rather than every console message. The separate browser-mode console check covers shell initialization, while the native terminal and render buffer cover the Tauri run; together they found warnings but no errors.
- Protocol runner ribbon coverage output is partial by design when one filtered scenario is run. The reported untested ribbon IDs are not failures of this focused baseline; the existing wider scenario set remains the full button inventory.

The repository is ready for Phase 1 within the documented boundaries. Phase 1 should treat the warnings above as pre-existing, preserve the protected viewport and callback contracts, and rerun the static guard plus the three live scenarios before attributing any change to the redesign.
