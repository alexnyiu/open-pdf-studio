# Editor, save, render, and lifecycle contracts

This document defines the production ownership boundaries for macOS text editing and saving. The central rule is that model mutation, visible publication, durable persistence, PDF proxy adoption, and view restoration are separate stages. No stage may infer another stage's success from a boolean.

## Immutable owner identity

Asynchronous work is owned by the tuple:

```text
documentId + lifecycleGeneration + pageNum + target revision
```

Document-scoped work omits `pageNum`; view-only work also captures the relevant activation or field revisions. A request must stop before publication when its owner tuple is no longer current. Active-tab state is never a substitute for the captured owner.

## Revision model

Every live document has one `revisionState`. Its main clocks are:

| Field | Meaning |
| --- | --- |
| `contentRevision` | Latest committed model mutation. |
| `serializedRevision` | Latest revision represented by validated candidate bytes. |
| `persistedRevision` | Latest revision durably written to the requested destination. |
| `livePdfRevision` | Latest revision represented by the installed PDF.js proxy. |
| `visibleRenderRevision` | Latest required revision visibly published. |
| `visibleSemanticRevision` | Latest required revision published to semantic text surfaces. |

The persistence clocks must preserve:

```text
livePdfRevision <= persistedRevision <= serializedRevision <= contentRevision
```

`pageContentRevisions`, `pageRenderReadyRevisions`, and `pageSemanticReadyRevisions` apply the same rule per page. `visibleRequiredPages`, `pendingChangedPages`, and `pendingStructuralChange` define what must be synchronized after persistence. A document is clean only when the required persistence debt is zero; an installed proxy or a visible preview alone cannot mark it clean.

## Text Apply

Every editor completion returns an immutable `TextApplyResult` with one of four statuses:

- `noop`: the interaction completed without a semantic mutation;
- `applied`: the owner model committed a mutation and assigned revisions;
- `rejected`: validation retained the draft and exposes bounded recovery actions;
- `superseded`: the captured document lifecycle no longer owns the operation.

Only `noop` and `applied` complete click-away interaction replay. Only an `applied` result with `changed` and `ownerCommitted` schedules persistence. `visiblePublished` and `semanticPublished` report publication independently; they are never inferred from `ownerCommitted`.

Editor activation also returns a structured result. A captured click-away target opens only when `activated === true`; legacy `true` values are rejected at this boundary.

## Page publication

A committed edit publishes through the page-surface registry. The registry resolves only a connected surface matching the exact document, lifecycle generation, page, and target revision. Search, undo, edit replay, and render readiness must use this registry rather than an arbitrary `.textLayer` or shared canvas.

Native replacement is visibly successful only after an authoritative candidate page surface publishes. An optimistic overlay can support application-owned inserted text, but it cannot stand in for a native replacement result. Semantic publication separately rebuilds the owned text projection.

Each render publication uses a token containing the document owner, PDF proxy identity, document revision, live-PDF revision, page revision, and page number. Stale results are released instead of published. PDF.js render tasks are cancelled and their watchdog timers cleared when their token becomes stale.

## Save transaction

One save request captures an immutable document owner and requested revision, then advances through these boundaries:

```text
editor barrier
    -> serialize immutable owner snapshot
    -> validate and retain SaveCandidate
    -> persist candidate bytes
    -> adopt validated PDF proxy when still owned
    -> rebuild required visible and semantic pages
    -> restore eligible view fields
```

`SaveCandidate` owns a copied byte array and, when available, a prepared PDF.js document. Replacing, releasing, cancelling, or superseding a candidate destroys the prepared document exactly once unless ownership is explicitly transferred to the live document.

Every execution callback returns an immutable `SaveResult`. Its durable statuses are `saved`, `saved-with-warning`, `saved-refresh-pending`, and `saved-refresh-failed`; each requires `bytesPersisted === true`. `save-as-required`, `deferred`, `superseded`, and `failed` are non-durable. Close or quit is authorized only when `persistedRevision` covers the required revision, even if proxy refresh remains pending or failed.

Ten automatic edit requests may coalesce into one durable write, but the original maximum coalescing deadline prevents indefinite deferral. A newer content revision after persistence may schedule another request; it does not rewrite the already durable result or install a stale proxy.

## macOS replacement transaction

The native safe-save path stages a private candidate and validation baseline beside the destination on the same volume. It flushes and validates candidate bytes, records destination identity, then performs the replacement only while the transaction still owns the destination.

File Provider and iCloud destinations use coordinated replacement. The native accessor uses the URL supplied by file coordination, revalidates that destination and its parent, and performs the existing atomic replacement inside the accessor. A destination identity change is terminal `DESTINATION_CHANGED` and is never blindly retried. Provider-busy conditions may use bounded retries before mutation; authentication, materialization, capacity, and conflict failures expose distinct recovery actions.

Permissions and supported macOS metadata are preserved when possible. A metadata-restoration or cleanup problem after durable replacement becomes a typed warning or recovery record, not a false claim that bytes were never saved. Pending sibling cleanup records remain narrowly scoped to validated safe-save candidate names.

## Lifecycle transitions

Proxy replacement uses an explicit `LIFECYCLE_TRANSITION_POLICIES` value. Policies define whether content, view, history, and caches are preserved; free-form reason strings do not alter behavior. Every transition increments `lifecycleGeneration`, cancels work owned by the prior generation, and restamps only validated state that the policy allows.

Validated save adoption may preserve logical document state and owned view state while installing the candidate proxy. Content replacement and document load use different policies and must not inherit save-adoption behavior accidentally.

## View-state restoration

View restoration is a field-versioned transaction. Page, zoom, rotation, scroll, pan, selection, search, panels, and related UI fields each capture their own mutation stamp. A field is restored only when its stamp is unchanged; user actions that occur during saving win independently of unrelated fields.

Single-page restoration uses a logical PDF-point anchor derived from the viewport center. Continuous, book, and facing modes use a page-local PDF-point anchor plus viewport point. Raw screen pixels are not a terminal restore authority. If the anchor page is temporarily unmounted, restoration defers until the page is available.

Shared UI restoration also requires an unchanged document activation lease. An inactive-document save can update its owner model and proxy, but it cannot redirect the active tab's controls, scroll position, or selection.

## Render scheduling and resources

Continuous rendering uses page-keyed visible-preview, full-visible, overscan, and semantic lanes. Reprioritizing the center page does not generation-cancel a useful preview for another page that remains visible. Page leases retain a mounted page only for the duration of an asynchronous interaction handoff and must be released in terminal cleanup.

Resource cleanup is part of each terminal path:

- candidate PDF.js documents are destroyed unless adopted;
- stale and evicted `ImageBitmap` instances are closed or transferred exactly once;
- PDF.js render tasks and native requests are cancelled by owner;
- temporary event listeners are removed or registered with one-shot/abort ownership;
- intervals, retry timers, and watchdogs are cleared when their request settles;
- page leases are released after editor activation, cancellation, or failure.

Full cache clears and document teardown may cancel all work for that owned scope. Normal visibility changes use document/page job keys and must not use a process-wide preview generation counter.

## Regression gates

The typed-boundary and compatibility-removal tests are part of `test:editor-lifecycle:unit`. Large-PDF packaged tests default to generated deterministic fixtures under `test-artifacts/generated-large-pdf-fixtures`; callers can select another controlled fixture with `OPEN_PDF_STUDIO_LARGE_PDF_FIXTURE`.
