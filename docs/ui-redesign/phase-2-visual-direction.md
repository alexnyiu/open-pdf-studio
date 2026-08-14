# Phase 2 visual direction: macOS-refined compact workspace

## Decision

Open PDF Studio will use a **macOS-refined compact workspace** as the visual direction for the redesign.

This is a restrained desktop document editor: native-feeling surfaces, quiet chrome, compact controls, and strong separation between application controls and the PDF page. It should feel at home on macOS without imitating a specific Apple application or replacing the existing workspace model.

Phase 2 changes the visual target only. It does not authorize production markup, CSS, renderer, saver, store, Tauri, or viewport changes. Production styling begins in Phase 3 after this direction has passed the validation gate below.

## Non-negotiable structure

- Keep the current title/document-tab area, command ribbon, left navigation and thumbnail panel, dominant PDF viewport, right properties inspector, and status/navigation bar.
- Keep the protected PDF viewport IDs, hierarchy, canvas order, and boundary from the Phase 0 contract.
- Keep existing command IDs, accessible names, keyboard shortcuts, disabled guards, callbacks, and state owners.
- Keep the left panel and properties panel independently collapsible; do not combine their state signals.
- Preserve floating and docked palettes, detached documents, fullscreen, and macOS drag-region behavior.

## Visual language

### Surfaces and color roles

- Use a quiet system-like background for application chrome and a slightly distinct canvas surround so the page remains the focal surface.
- Use translucent or softly tinted chrome only where it improves hierarchy; avoid decorative glass effects over the PDF page.
- Use one restrained accent for active tabs, selected tools, focus, links, and primary actions.
- Use semantic roles for success, warning, destructive, and error states; never communicate state by color alone.
- Light mode should be warm-neutral rather than stark white. Dark mode should use layered charcoal surfaces rather than pure black.
- Keep PDF content colors, annotation colors, and user-selected document colors independent from application chrome tokens.

### Typography

- Prefer the existing macOS-compatible system stack and preserve readable text at compact sizes.
- Use a small, deliberate scale: 11–12px for dense controls, 13px for labels and inspector values, and 15–16px for primary empty-state or document-context text.
- Use weight and spacing to establish hierarchy; do not rely on large headings inside the editing workspace.
- Long translated labels must remain readable and must be allowed to truncate or overflow into existing command menus rather than being clipped invisibly.

### Geometry and density

- Use a 4px base grid with 8px grouping increments.
- Retain compact desktop targets while keeping pointer targets practical: approximately 24–28px visual controls and at least 28px for frequently used toolbar actions where space allows.
- Use small radii, generally 4–6px for grouped controls and 6–8px for dialogs or inspector groups. Avoid rounded-card styling throughout the shell.
- Prefer hairline separators and alignment over heavy borders and shadows.
- Use elevation sparingly for floating palettes, menus, and dialogs only.

### Icons

- Standardize migrated application icons on a 20px optical grid inside 24px control boxes.
- Use outline icons with a consistent current-color stroke for navigation and command chrome; reserve filled treatment for selected or status-critical icons.
- Normalize legacy icons by optical size and baseline, not by changing command meaning.
- Keep an explicit legacy icon-to-command map during Phase 6. Similar-looking icons must never cause a command to disappear.
- Every icon-only control retains a stable accessible name from its current command contract.

## State treatment

- Hover: subtle surface tint, no layout shift.
- Pressed: darker or more opaque tint with the same geometry.
- Selected: accent edge, tint, or filled icon treatment plus a non-color cue such as weight or outline.
- Keyboard focus: clearly visible two-layer focus ring that remains visible in light and dark modes.
- Disabled: reduced contrast and pointer affordance, while retaining enough contrast to identify the command and its reason where applicable.
- Busy/loading: preserve layout and show progress without blocking unrelated document navigation unless the existing behavior is blocking.
- Warning/error/destructive: pair semantic color with text, iconography, or confirmation.
- Read-only/locked: make the reason legible in the inspector; do not imply stronger enforcement than the current behavior contract provides.
- Mixed selection: display `mixed` values explicitly and avoid silently normalizing different annotation values.

## Responsive and overflow rules

At 1400×900, both side panels may be visible with the PDF canvas remaining dominant. At 800×600:

- Keep the title/document context and essential command access visible.
- Use the existing adaptive ribbon and overflow behavior rather than shrinking labels below usable sizes.
- Keep the left and right panel collapse affordances discoverable.
- Prefer reducing panel content density and moving secondary commands into overflow before reducing the PDF viewport below a usable working area.
- Preserve horizontal document-tab overflow and keyboard access.
- Never hide a command solely because its icon was visually consolidated with another command.

## Inspector direction

The properties inspector should feel like a native macOS utility panel: calm header, clear selection context, compact grouped sections, and restrained separators. It must support the full Phase 1 matrix:

- no document;
- document with no selection;
- one annotation;
- compatible multi-selection with mixed values;
- mixed annotation types;
- PDF text editing;
- measurements;
- locked items;
- read-only states;
- plugin annotations.

The inspector remains a presentation layer over `propertiesStore`; it must not create a second mutation, undo, redraw, or measurement path.

## Direction alternatives considered

The compact expert and balanced professional directions remain useful as reference points, but are not selected:

- Compact expert: useful density target, but risks feeling like a cross-platform enterprise ribbon and too close to Acrobat-like chrome.
- Balanced professional: easier onboarding, but risks spending too much vertical space and weakening the canvas-first editing focus.
- macOS-refined compact: best fit for the target platform while retaining expert density and the existing document-workspace mental model.

## Phase 2 acceptance gate

The direction is approved for Phase 3 only after the same PDF-open, annotation-selected, both-panels-visible state is checked at:

- 1400×900, light mode;
- 1400×900, dark mode;
- 800×600, light mode;
- 800×600, dark mode;

The check must include ribbon overflow, document-tab overflow, collapsed and expanded left/right panels, no-selection inspector, single-selection inspector, compatible multi-selection, mixed selection, text-editing, locked, read-only, and loading/disabled states. The check must confirm that the Phase 0 viewport contract and existing command behavior are unchanged.

## Current status

The visual direction is selected from the user’s instruction to proceed with a macOS-refined design. The acceptance captures and production token implementation remain Phase 3 work. No production UI or behavior files were changed in Phase 2 kickoff.
