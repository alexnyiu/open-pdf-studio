---
type: "query"
date: "2026-08-14T06:53:32.673636+00:00"
question: "Why does getActiveDocument() bridge so many UI and PDF subsystems?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["getActiveDocument()", "savePDF()", "redrawAnnotations()", "buildToolContext()", "updateAnnotProp()", "loadPDF()"]
---

# Q: Why does getActiveDocument() bridge so many UI and PDF subsystems?

## Answer

Expanded from original query via graph vocab: [get, active, document, bridge, pdf, renderer, loader, state, panel, annotation, tool, format]. The graph shows getActiveDocument() at open-pdf-studio/js/core/state.ts:L319 with degree 549: 400 call edges and 148 import edges. It is a shared accessor for state.documents[state.activeDocumentIndex], so tools, UI, PDF pipeline, panels, annotations, and undo flows use it to resolve the current document. Representative direct paths include savePDF(), redrawAnnotations(), buildToolContext(), updateAnnotProp(), and tabs.js; loadPDF() is two hops away through measurement.js.

## Outcome

- Signal: useful

## Source Nodes

- getActiveDocument()
- savePDF()
- redrawAnnotations()
- buildToolContext()
- updateAnnotProp()
- loadPDF()