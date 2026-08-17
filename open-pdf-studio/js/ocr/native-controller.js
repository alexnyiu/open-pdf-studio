import { invoke } from '../core/platform.js';
import {
  OCR_NATIVE_PAGE_REQUEST_CONTRACT,
  OCR_NATIVE_SCHEMA_VERSION,
  assertNativeOcrPageRequestV1,
} from './contracts/native-job.v1.js';
import { assertOcrJobV1 } from './contracts/job.v1.js';
import { assertOcrResultMatchesJob } from './contracts/worker-message.v1.js';
import {
  assertOcrPageGeometryV1,
  assertPdfiumPageGeometryV1,
  createOcrPageGeometryFromPdfiumV1,
} from './contracts/page-geometry.v1.js';
import {
  applyOcrPageResult,
  finishOcrPageAttempt,
  isCurrentOcrPageToken,
  markOcrPageRecognizing,
} from './document-state.js';

export const OCR_NATIVE_CONTROLLER_OUTCOME_CONTRACT =
  'open-pdf-studio.ocr.native-controller-outcome';

const OUTCOME_KEYS = new Set([
  'contract', 'schemaVersion', 'status', 'jobId', 'job', 'result', 'failure',
  'childPid', 'lifecycle', 'resources', 'isolation', 'cancellation', 'cleanup',
]);

function assertExactObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new TypeError(`${name}.${key} is not allowed`);
  }
}

export function assertNativeOcrControllerOutcome(value, request) {
  assertExactObject(value, OUTCOME_KEYS, 'native OCR controller outcome');
  if (value.contract !== OCR_NATIVE_CONTROLLER_OUTCOME_CONTRACT ||
      value.schemaVersion !== OCR_NATIVE_SCHEMA_VERSION) {
    throw new TypeError('native OCR controller returned an unsupported protocol');
  }
  if (!['completed', 'cancelled', 'failed', 'stale'].includes(value.status)) {
    throw new TypeError('native OCR controller returned an unsupported status');
  }
  if (value.jobId !== request.jobId) {
    throw new TypeError('native OCR controller returned the wrong job ID');
  }
  if (!Array.isArray(value.lifecycle) || !value.resources || typeof value.resources !== 'object' ||
      !value.isolation || typeof value.isolation !== 'object' ||
      !value.cleanup || typeof value.cleanup !== 'object') {
    throw new TypeError('native OCR controller returned malformed lifecycle metadata');
  }
  if (value.status === 'completed') {
    const job = assertOcrJobV1(value.job);
    assertOcrResultMatchesJob(value.result, job);
    if (value.failure !== null || value.cancellation !== null) {
      throw new TypeError('completed native OCR outcome contains terminal failure metadata');
    }
  } else {
    if (value.result !== null) throw new TypeError('non-completed native OCR outcome contains a result');
    if (value.status === 'cancelled') {
      if (!value.cancellation || value.failure !== null) {
        throw new TypeError('cancelled native OCR outcome is missing cancellation metadata');
      }
    } else if (!value.failure || value.cancellation !== null) {
      throw new TypeError('failed native OCR outcome is missing typed failure metadata');
    }
  }
  return value;
}

/**
 * Internal macOS controller entry point. The source PDF path is a parent-only
 * raster input and is deliberately separate from the versioned child request.
 */
export async function runNativeOcrPage({ sourcePdfPath, request }) {
  if (typeof sourcePdfPath !== 'string' || sourcePdfPath.length === 0) {
    throw new TypeError('native OCR requires a parent-side PDF path');
  }
  const validatedRequest = assertNativeOcrPageRequestV1(request);
  const outcome = await invoke('run_ocr_page_job', {
    sourcePdfPath,
    request: validatedRequest,
  });
  return assertNativeOcrControllerOutcome(outcome, validatedRequest);
}

/**
 * Runs the shipped macOS parent controller and publishes a completed
 * production result into unsaved document OCR state. Page geometry is a
 * separately validated production contract from the same parent-side raster;
 * the PDF path remains parent-only and is never added to the child request.
 */
export async function runNativeOcrPageIntoDocument({
  document,
  sourcePdfPath,
  request,
  pageGeometry = null,
  pageGeometryBoundary = null,
  token,
}) {
  if (typeof sourcePdfPath !== 'string' || sourcePdfPath.length === 0) {
    throw new TypeError('native OCR requires a parent-side PDF path');
  }
  const validatedRequest = assertNativeOcrPageRequestV1(request);
  if (!isCurrentOcrPageToken(document, token) ||
      validatedRequest.document.id !== token.documentId ||
      validatedRequest.document.generation !== token.documentGeneration ||
      validatedRequest.page.id !== token.pageId ||
      validatedRequest.page.index !== token.pageNumber - 1 ||
      validatedRequest.page.revision !== token.pageRevision) {
    return { outcome: null, stateUpdate: { applied: false, reason: 'stale-before-run' } };
  }
  let boundary = pageGeometryBoundary;
  if (pageGeometry) {
    assertOcrPageGeometryV1(pageGeometry);
    if (pageGeometry.rotations.applicationDegreesClockwise !== 0) {
      throw new TypeError('native OCR page geometry must use zero application rotation');
    }
  } else {
    if (!boundary) {
      boundary = await invoke('query_pdf_page_geometry', {
        path: sourcePdfPath,
        pageIndex: validatedRequest.page.index,
        scale: validatedRequest.recognitionOptions.rasterDpi / 72,
        // The shipped native OCR raster path is canonical and intentionally
        // independent of the viewer's mutable application rotation.
        applicationRotation: 0,
      });
    }
    assertPdfiumPageGeometryV1(boundary);
    if (boundary.applicationRotationDegreesClockwise !== 0) {
      throw new TypeError('native OCR page geometry must use zero application rotation');
    }
  }
  if (!markOcrPageRecognizing(document, token)) {
    return { outcome: null, stateUpdate: { applied: false, reason: 'stale-before-run' } };
  }
  const outcome = await runNativeOcrPage({ sourcePdfPath, request: validatedRequest });
  if (outcome.status === 'completed') {
    const resultGeometry = pageGeometry || createOcrPageGeometryFromPdfiumV1(boundary, {
      geometryId: outcome.jobId,
      document: outcome.result.document,
      page: {
        id: outcome.result.page.id,
        index: outcome.result.page.index,
        revision: outcome.result.page.revision,
      },
      sourceRasterId: outcome.result.sourceRaster.id,
      sourceRasterFingerprint: outcome.result.sourceRaster.fingerprint,
    });
    return {
      outcome,
      stateUpdate: applyOcrPageResult(document, {
        result: outcome.result,
        pageGeometry: resultGeometry,
        token,
      }),
    };
  }
  if (outcome.status === 'cancelled') {
    finishOcrPageAttempt(document, token, 'cancelled');
  } else if (outcome.status === 'failed' || outcome.status === 'stale') {
    finishOcrPageAttempt(document, token, outcome.status, [{
      code: outcome.failure.code,
      message: outcome.failure.message,
      severity: outcome.status === 'stale' ? 'warning' : 'error',
      entityIds: [],
    }]);
  }
  return { outcome, stateUpdate: { applied: false, reason: outcome.status } };
}

export async function cancelNativeOcrJob(jobId) {
  return invoke('cancel_ocr_job', { jobId });
}

export async function getNativeOcrJobStatus(jobId) {
  return invoke('get_ocr_job_status', { jobId });
}

export async function cancelNativeOcrDocument(documentId) {
  return invoke('cancel_ocr_document_jobs', { documentId });
}

export async function cancelAllNativeOcrJobs() {
  return invoke('cancel_all_ocr_jobs');
}

export function nativePageRequest(payload) {
  return assertNativeOcrPageRequestV1({
    contract: OCR_NATIVE_PAGE_REQUEST_CONTRACT,
    schemaVersion: OCR_NATIVE_SCHEMA_VERSION,
    ...payload,
  });
}
