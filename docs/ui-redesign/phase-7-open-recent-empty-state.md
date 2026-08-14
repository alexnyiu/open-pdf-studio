# Phase 7 — Open, recent documents, and empty state

## Scope

This is the first Phase 7 vertical slice only. It covers:

- the no-document empty state;
- a direct Open action;
- recent-file entry points when recent files exist; and
- the presentation of the existing File → Open surface.

It does not begin the later Phase 7 workflows for viewing, navigation, annotations, properties, drawing, text editing, page organization, forms, compare mode, printing/export, or preferences. Phase 8 interaction-quality work remains separate.

## Behavior ownership

The redesign is presentation-first and keeps the existing behavior boundaries:

- `EmptyState.jsx` owns the no-document presentation and delegates direct Open to `openPDFFile()`.
- `recent-file-opener.js` is the shared recent-file adapter. It preserves the existing Tauri scope check, missing-file cleanup, `createTab()`, and `loadPDF()` sequence.
- `recent-files.js` remains the local recent-file store.
- `OpenPanel.jsx` keeps the existing File → Open navigation and delegates recent-file opening through the shared adapter.
- `#placeholder` and the protected PDF viewport IDs remain unchanged for loader, tab, and renderer visibility behavior.

## Acceptance checks

- Empty state keeps a keyboard-focusable Open action and a Recent Files entry point.
- Recent files are limited to the four most recent entries shown in the empty state; the full existing list remains available in File → Open.
- Missing Tauri recent files are removed through the existing recent-file store before the list refreshes.
- The workflow uses the approved blue accent and neutral charcoal dark-mode surfaces, including the requested `#181818` canvas background.
- The layout has a compact-window treatment at 820px without changing PDF viewport geometry.

Automated and live verification results are recorded with the Phase 7 implementation handoff.
