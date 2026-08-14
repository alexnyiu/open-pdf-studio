# Phase 4 component gallery

The internal component gallery is available through the debug route:

```text
?view=component-gallery
```

For a Vite development session, open the app with:

```text
http://localhost:5173/?view=component-gallery
```

The gallery is intentionally separate from the document shell. `main.js` renders it before document initialization, so it cannot become a second PDF behavior path.

## Primitive set

- `UiButton`: primary, secondary, quiet, destructive, compact, comfortable, active, disabled, and busy states.
- `UiIconButton`: icon-only controls with explicit accessible names.
- `UiPanelHeader`: title, collapse action, and optional action slot.
- `UiToolbarGroup` and `UiButtonStack`: grouped command layout.
- `UiTab`: active and inactive tab states.
- `UiField`: text and numeric fields with warning, error, disabled, and read-only states.
- `UiSegmentedControl`: selected state with `aria-pressed`.

## Real-slice usage

The first production slice now consumes the primitives without moving behavior:

- `RibbonButton` delegates rendering to `UiButton` while preserving legacy IDs, classes, titles, labels, disabled guards, and callbacks.
- `RibbonGroup` and `RibbonButtonStack` use the toolbar group/stack primitives while preserving adaptive ribbon classes.
- `RibbonTab` uses `UiTab` while preserving legacy active/contextual classes and tab callbacks.
- `PanelHeader` uses `UiPanelHeader` while preserving `#prop-panel-header` and the existing `setPanelCollapsed(true)` owner.

## Verification

- UI contract: 3/3 passed.
- TypeScript check: passed.
- Direct Vite production build: passed.
- Gallery rendered with no browser console errors at 1400×900 and 800×600.
- Light/dark theme toggle, tab selection, busy state, panel callback, and segmented selection were exercised.
- Compact gallery viewport had no horizontal overflow.
- The gallery confirmed `#pdf-container` is absent, so it does not mount or duplicate the protected PDF viewport.

The gallery is a validation surface, not a replacement shell. Phase 4 can continue by migrating the next real primitive slice only after its existing command and state contracts are covered.
