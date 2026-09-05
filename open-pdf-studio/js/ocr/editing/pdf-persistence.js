import * as pdfjsLib from 'pdfjs-dist';

import {
  inspectOwnedScannedTextRepairLayer,
  removeOwnedScannedTextRepairLayer,
  writeOwnedScannedTextRepairLayer,
} from './pdf-repair-layer.js';

export class ScannedTextEditPdfCandidateError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ScannedTextEditPdfCandidateError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ScannedTextEditPdfCandidateError(code, message, cause);
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  fail('INVALID_BYTES', 'Scanned-text PDF validation requires byte arrays');
}

function appliedSelections(state) {
  return (state?.pages || []).flatMap((page) => page.selections
    .filter((selection) => selection.repair.status === 'applied')
    .map((selection) => ({ page, selection })));
}

async function openPdfJs(value) {
  try {
    return await pdfjsLib.getDocument({
      data: bytes(value).slice(),
      cMapUrl: '/pdfjs/web/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/web/standard_fonts/',
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    fail('PDFJS_REOPEN_FAILED', 'PDF.js could not reopen the scanned-text edit candidate', error);
  }
}

async function extractedText(document, pageIndexes) {
  const output = new Map();
  for (const pageIndex of pageIndexes) {
    const content = await (await document.getPage(pageIndex + 1)).getTextContent();
    output.set(pageIndex, content.items.map((item) => item.str).join('\n'));
  }
  return output;
}

async function close(document) {
  try { await document?.destroy?.(); } catch (_) {}
}

function ownedPageSet(inspection) {
  return new Set(inspection.filter((entry) => entry.owned).map((entry) => entry.pageIndex));
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/**
 * Reconcile one owned visible scanned-text patch stream, then prove reopen,
 * idempotence, ownership, extraction neutrality, and exact removal before the
 * candidate can enter the native atomic-save boundary.
 */
export async function buildAndValidateScannedTextEditPdfCandidate({
  baseBytes,
  lineagePdfBytes = null,
  state = null,
  pageGeometries = [],
  expectedPageCount,
  modifiedAt,
}) {
  const sourceBytes = bytes(baseBytes);
  const existingInspection = await inspectOwnedScannedTextRepairLayer(sourceBytes);
  const desired = appliedSelections(state);
  const desiredPages = new Set([
    ...desired.map(({ page }) => page.index),
    ...(state?.pages || []).filter((page) => page.paragraphGrouping).map((page) => page.index),
  ]);
  const relevantPageIndexes = [...new Set([
    ...existingInspection.filter((entry) => entry.owned).map((entry) => entry.pageIndex),
    ...desiredPages,
  ])].sort((left, right) => left - right);
  const baselineWithoutOwned = await removeOwnedScannedTextRepairLayer({ pdfBytes: sourceBytes });
  const candidateBytes = state
    ? await writeOwnedScannedTextRepairLayer({
        pdfBytes: sourceBytes,
        lineagePdfBytes,
        state,
        pageGeometries,
        modifiedAt,
      })
    : await removeOwnedScannedTextRepairLayer({ pdfBytes: sourceBytes });
  const candidateInspection = await inspectOwnedScannedTextRepairLayer(candidateBytes);
  const actualPages = ownedPageSet(candidateInspection);
  if (!sameSet(actualPages, desiredPages)) {
    fail('OWNERSHIP_SET_MISMATCH', 'Visible scanned-text ownership does not match application edit state');
  }
  const repeatedBytes = desiredPages.size > 0
    ? await writeOwnedScannedTextRepairLayer({
        pdfBytes: candidateBytes,
        state,
        pageGeometries,
        modifiedAt,
      })
    : await removeOwnedScannedTextRepairLayer({ pdfBytes: candidateBytes });
  const repeatedInspection = await inspectOwnedScannedTextRepairLayer(repeatedBytes);
  if (!sameSet(ownedPageSet(repeatedInspection), desiredPages)) {
    fail('REPEATED_WRITE_OWNERSHIP_MISMATCH', 'Repeated visible scanned-text write changed page ownership');
  }
  for (const pageIndex of desiredPages) {
    const first = candidateInspection[pageIndex];
    const repeated = repeatedInspection[pageIndex];
    if (!first?.owned || !repeated?.owned
        || first.selectionIds.length !== repeated.selectionIds.length
        || first.contentRefs.length !== repeated.contentRefs.length) {
      fail('REPEATED_WRITE_DUPLICATED_STREAM', `Repeated visible scanned-text write duplicated page ${pageIndex + 1}`);
    }
  }
  const removedBytes = await removeOwnedScannedTextRepairLayer({ pdfBytes: repeatedBytes });
  const removedInspection = await inspectOwnedScannedTextRepairLayer(removedBytes);
  if (removedInspection.some((entry) => entry.owned)) {
    fail('OWNED_REMOVAL_FAILED', 'Removing the visible scanned-text layer retained owned content');
  }

  let baselineDocument;
  let candidateDocument;
  let repeatedDocument;
  let removedDocument;
  try {
    [baselineDocument, candidateDocument, repeatedDocument, removedDocument] = await Promise.all([
      openPdfJs(baselineWithoutOwned),
      openPdfJs(candidateBytes),
      openPdfJs(repeatedBytes),
      openPdfJs(removedBytes),
    ]);
    for (const [label, document] of [
      ['baseline', baselineDocument],
      ['candidate', candidateDocument],
      ['repeated', repeatedDocument],
      ['removed', removedDocument],
    ]) {
      if (document.numPages !== expectedPageCount) {
        fail('PAGE_COUNT_CHANGED', `${label} page count changed during visible scanned-text persistence`);
      }
    }
    const [baselineText, candidateText, repeatedText, removedText] = await Promise.all([
      extractedText(baselineDocument, relevantPageIndexes),
      extractedText(candidateDocument, relevantPageIndexes),
      extractedText(repeatedDocument, relevantPageIndexes),
      extractedText(removedDocument, relevantPageIndexes),
    ]);
    for (const pageIndex of relevantPageIndexes) {
      const baseline = baselineText.get(pageIndex) || '';
      if ((candidateText.get(pageIndex) || '') !== baseline
          || (repeatedText.get(pageIndex) || '') !== baseline
          || (removedText.get(pageIndex) || '') !== baseline) {
        fail('VISIBLE_LAYER_TEXT_LEAK', `Visible scanned-text pixels altered PDF extraction on page ${pageIndex + 1}`);
      }
    }
    await Promise.all([close(baselineDocument), close(repeatedDocument), close(removedDocument)]);
    return {
      candidateBytes,
      validationBaselineBytes: baselineWithoutOwned,
      candidatePdfJsDocument: candidateDocument,
      inspection: candidateInspection,
      pdfiumPlan: {
        selectedPageIndexes: relevantPageIndexes,
        allowedRegions: desired.map(({ page, selection }) => ({
          pageIndex: page.index,
          sourceRasterDpi: page.sourceRaster.dpi,
          bounds: { ...selection.repair.approvedRegion },
        })),
      },
    };
  } catch (error) {
    await Promise.all([
      close(baselineDocument),
      close(candidateDocument),
      close(repeatedDocument),
      close(removedDocument),
    ]);
    throw error;
  }
}

/** Hydrate only fully validated application-owned state from reopened bytes. */
export async function hydrateOwnedScannedTextEditState(document, pdfBytes, parsedDocument = null) {
  const inspection = await inspectOwnedScannedTextRepairLayer(pdfBytes, parsedDocument);
  const owned = inspection.filter((entry) => entry.owned);
  if (owned.length === 0) {
    document.scannedTextEdits = null;
    document.scannedTextEditPersistedRevision = 0;
    return null;
  }
  const state = owned[0].state;
  if (owned.some((entry) => entry.stateId !== state.stateId
      || entry.stateRevision !== state.stateRevision
      || JSON.stringify(entry.state) !== JSON.stringify(state))) {
    fail('INCONSISTENT_OWNED_STATE', 'Owned scanned-text pages do not share one exact edit-state snapshot');
  }
  document.scannedTextEdits = structuredClone(state);
  document.scannedTextEditPersistedRevision = state.stateRevision;
  return document.scannedTextEdits;
}

export function markOwnedScannedTextEditsPersisted(document, inspection) {
  const owned = (inspection || []).filter((entry) => entry.owned);
  document.scannedTextEditPersistedRevision = owned.length > 0
    ? owned[0].stateRevision
    : (document.scannedTextEdits?.stateRevision ?? 0);
}

export function validateScannedTextEditPdfiumCandidateResult(plan, result) {
  if (!result || result.status !== 'pass' || result.renderScale !== 2
      || result.maxChangedPixelsPerPage !== 0 || result.maxChannelDeltaTolerance !== 0) {
    fail('PDFIUM_VALIDATION_FAILED', 'PDFium did not return the exact outside-region pixel policy');
  }
  const pages = new Map((result.pages || []).map((page) => [page.pageIndex, page]));
  const allowedPages = new Set((plan.allowedRegions || []).map((region) => region.pageIndex));
  for (const pageIndex of plan.selectedPageIndexes || []) {
    const page = pages.get(pageIndex);
    if (!page || page.outsideAllowedChangedPixels !== 0
        || page.outsideAllowedMaxChannelDelta !== 0) {
      fail('PIXELS_CHANGED_OUTSIDE_EDIT_REGION', `PDFium found changed pixels outside the approved edit region on page ${pageIndex + 1}`);
    }
    if (allowedPages.has(pageIndex) && page.allowedChangedPixels <= 0) {
      fail('VISIBLE_REPLACEMENT_MISSING', `PDFium did not render the owned visible replacement on page ${pageIndex + 1}`);
    }
    if (page.changedPixels !== page.allowedChangedPixels + page.outsideAllowedChangedPixels) {
      fail('INVALID_PDFIUM_PIXEL_ACCOUNTING', `PDFium returned inconsistent pixel accounting on page ${pageIndex + 1}`);
    }
  }
  return true;
}
