# Phase 5 shell modernization

The first Phase 5 slice modernizes the stable application frame around the PDF. It is a presentation migration: existing Solid components, stores, renderer calls, saver calls, Tauri window commands, and panel state owners remain in place.

## Implemented slice

- Title bar: compact raised surface, calmer icon-button states, preserved drag region, window controls, and feedback action.
- Document tabs: raised active tab, blue active indicator, restrained tab spacing, and preserved rename, close, reorder, detach, and compare behavior.
- Workspace chrome: neutral shell surfaces, a clearer left navigation rail, a larger resize hit target, and a quieter properties inspector.
- Empty document state: existing SVG and translated copy retained with a compact icon treatment and clearer type hierarchy.
- Status bar: grouped controls, blue selection feedback, and compact page/zoom fields.
- Responsive shell: at widths up to 960 px the primary panels step down to 168/190/260 px; at widths up to 820 px they step down to 152/180/240 px and optional docked palettes compress to 40/180 px so the document viewport remains usable.

## Width contract

| Surface | Default | Minimum | Maximum | Collapse |
| --- | ---: | ---: | ---: | ---: |
| Left panel | 200 px | 120 px | 500 px | 28 px rail |
| Properties panel | 300 px | 300 px | 300 px | 28 px rail |

The left-panel resize owner continues to clamp pointer resizing to 120–500 px. Collapse still removes the resize handle and restores the previous inline width when reopened. Properties-panel visibility and collapse remain owned by `propertiesStore.js`.

## Protected infrastructure

The Phase 5 stylesheet does not target `#pdf-container`, `#canvas-wrapper`, `#canvas-container`, `#pdf-canvas`, `#text-highlight-canvas`, `#annotation-canvas`, or `#continuous-container`. The existing App composition and canvas order remain covered by the UI contract test.

## Verification target

The required phase gate remains:

```text
npm run test:ui-contract
npm run typecheck
npm run test:unit
npm run test:quality
node tests/protocol/runner.mjs 00-ui-redesign-baseline
```

The live acceptance pass should cover light and dark shell states at 1400×900 and 800×600, left-panel resize/collapse/reopen, properties-panel collapse/reopen, tab interactions, and a PDF-open viewport check. Native macOS traffic-light clearance, drag regions, fullscreen, shortcuts, detached windows, Retina rendering, and native file/window commands remain explicit follow-up checks for this phase.
