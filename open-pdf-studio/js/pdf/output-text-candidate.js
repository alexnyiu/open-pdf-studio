import i18next from '../i18n/config.js';
import { PDFDocument } from 'pdf-lib';
import { tempDir, join } from '@tauri-apps/api/path';
import { applyNativeTextEditsToBytes, saveTextEditsToPages } from './saver/text-edits.js';
import { hydrateOwnedTextEditManifest } from '../text/owned-edit-manifest.js';
import { preparePdfJsSaveCandidate, destroyPreparedPdfJsDocument } from '../ocr/pdf-persistence.js';
import { buildAndValidateScannedTextEditPdfCandidate, validateScannedTextEditPdfiumCandidateResult } from '../ocr/editing/pdf-persistence.js';
import { stageMacosSafePdfSave, abortMacosSafePdfSave, validateStagedOcrPdfWithPdfium } from './macos-safe-save.js';
import { isTauri } from '../core/platform.js';

/** Build a leased output revision without saving or rebasing its live owner. */
export async function prepareOutputTextCandidate(source, signal) {
  const snapshot = source.textPersistenceSnapshot;
  if (!snapshot) throw new Error(i18next.t('common:repair.outputTextSnapshotMissing'));
  const check = () => signal.throwIfAborted();
  let preparedDocument = null;
  let stagedToken = null;
  let handedOff = false;
  try {
    check();
    const native = await applyNativeTextEditsToBytes(source.bytes, snapshot);
    check();
    const document = await PDFDocument.load(native.pdfBytes, { updateMetadata: false });
    const pages = document.getPages();
    if (pages.length !== snapshot.pageCount) throw new Error(i18next.t('common:repair.outputTextPageCountChanged'));
    const manifest = await saveTextEditsToPages(document, pages, snapshot, native.updatedRecords);
    check();
    let candidateBytes = new Uint8Array(await document.save());
    const scanned = snapshot.scannedTextState;
    if (scanned.removalPending || Number(scanned.state?.stateRevision || 0) !== scanned.persistedRevision) {
      if (!isTauri() || window.__TAURI__?.os?.type?.() !== 'macos') {
        throw new Error(i18next.t('common:repair.outputScannedTextNeedsMacos'));
      }
      const date = snapshot.capturedAt.replace(/[-:T]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
      const result = await buildAndValidateScannedTextEditPdfCandidate({
        baseBytes: candidateBytes, lineagePdfBytes: native.pdfBytes,
        state: scanned.state, pageGeometries: snapshot.ocrState.pageGeometries,
        expectedPageCount: pages.length, modifiedAt: `D:${date}`,
      });
      candidateBytes = result.candidateBytes;
      preparedDocument = result.candidatePdfJsDocument;
      check();
      // The normal safe-save staging and PDFium pixel proof run against a
      // private temporary destination. Never finalize a save to that path.
      const destinationPath = await join(await tempDir(), `opds-output-validation-${crypto.randomUUID()}.pdf`);
      const staged = await stageMacosSafePdfSave({ destinationPath, candidateBytes,
        validationBaselineBytes: result.validationBaselineBytes });
      stagedToken = staged.token;
      check();
      const validation = await validateStagedOcrPdfWithPdfium(stagedToken,
        result.pdfiumPlan.selectedPageIndexes, result.pdfiumPlan.allowedRegions);
      validateScannedTextEditPdfiumCandidateResult(result.pdfiumPlan, validation);
      check();
    }
    // Reopening must retain the checksummed manifest and exact owned layer
    // identities. Hydrate only this private holder, never the active document.
    const reopenedManifest = await hydrateOwnedTextEditManifest({}, candidateBytes);
    if ((reopenedManifest?.integrityHash || null) !== (manifest?.integrityHash || null)) {
      throw new Error(i18next.t('common:repair.outputTextManifestChanged'));
    }
    check();
    if (!preparedDocument) preparedDocument = await preparePdfJsSaveCandidate(candidateBytes, pages.length);
    check();
    handedOff = true;
    return preparedDocument;
  } finally {
    try {
      await abortMacosSafePdfSave(stagedToken, { throwOnError: true });
    } catch (error) {
      // A failed cleanup prevents publication; the caller never received the
      // returned proxy when this finally block throws.
      handedOff = false;
      throw error;
    } finally {
      if (!handedOff) await destroyPreparedPdfJsDocument(preparedDocument);
    }
  }
}
