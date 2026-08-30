import { createEditorLayoutRevision } from './editor-layout-revision.js';
import { requestLatestNativeLayout } from './native-layout-scheduler.js';

const WIDTH_EPSILON = 1e-6;
const RETRYABLE_LAYOUT_CODES = new Set([
  'TEXT_LAYOUT_CANCELLED',
  'TEXT_LAYOUT_RESULT_DROPPED',
  'TEXT_LAYOUT_WORKER_CRASHED',
  'TEXT_LAYOUT_WORKER_REPLACED',
]);

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizedRect(value) {
  if (!value) return null;
  const x = Number(value.x ?? value.left);
  const y = Number(value.y ?? value.bottom ?? value.top);
  const width = Number(value.width);
  const height = Number(value.height);
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x, y, width, height }
    : null;
}

function normalizedColumn(value) {
  if (!value) return null;
  const left = Number(value.left ?? value.x);
  const right = Number(value.right ?? (Number(value.x) + Number(value.width)));
  return Number.isFinite(left) && Number.isFinite(right) && right > left
    ? { left, right }
    : null;
}

function intersects(left, right) {
  return left.x < right.x + right.width - WIDTH_EPSILON
    && left.x + left.width > right.x + WIDTH_EPSILON
    && left.y < right.y + right.height - WIDTH_EPSILON
    && left.y + left.height > right.y + WIDTH_EPSILON;
}

function widthOverflow(result) {
  return Number(result?.requiredWidth) > Number(result?.effectiveContentWidth) + WIDTH_EPSILON;
}

function onlyWidthCapacityRejected(result) {
  if (!result || result.valid === true || !widthOverflow(result)) return false;
  if (result.pageEdgeValid === false || result.columnValid === false) return false;
  const codes = result.rejectionCodes || [];
  if (codes.length > 0) return codes.every((code) => code === 'TEXT_LAYOUT_WIDTH_CAPACITY');
  return (result.rejectionReasons || []).every((reason) => (
    /text box width|content width|width capacity/iu.test(String(reason))
  ));
}

function resultRejectionCode(result) {
  if (onlyWidthCapacityRejected(result)) return 'TEXT_LAYOUT_WIDTH_CAPACITY';
  if (result?.columnValid === false) return 'TEXT_LAYOUT_COLUMN_BOUNDARY';
  if (result?.pageEdgeValid === false) return 'TEXT_LAYOUT_PAGE_BOUNDARY';
  if (result?.rejectionCode) return String(result.rejectionCode);
  if ((result?.overlapWarnings || []).length > 0) return 'TEXT_LAYOUT_NEIGHBOR_OVERLAP';
  if (widthOverflow(result)) return 'TEXT_LAYOUT_WIDTH_CAPACITY';
  return 'TEXT_LAYOUT_FAILED';
}

function recoveryActions(code, { expandLegal = false } = {}) {
  const actions = [];
  if (expandLegal) actions.push('expand-to-fit');
  if (code?.startsWith('TEXT_LAYOUT_')) actions.push('insert-line-break');
  actions.push('keep-editing');
  return [...new Set(actions)];
}

function constraintReason(code) {
  if (code === 'TEXT_LAYOUT_PAGE_BOUNDARY') {
    return 'The text cannot expand without crossing the page CropBox. Press Enter to create a new line or keep editing.';
  }
  if (code === 'TEXT_LAYOUT_COLUMN_BOUNDARY') {
    return 'This text is wider than the available column. Press Enter to create a new line or keep editing.';
  }
  if (code === 'TEXT_LAYOUT_NEIGHBOR_OVERLAP') {
    return 'Expanding this text box would overlap neighboring text. Press Enter to create a new line or keep editing.';
  }
  if (code === 'TEXT_LAYOUT_WIDTH_CAPACITY') {
    return 'This text is wider than the available text box. Expand the box, press Enter to create a new line, or keep editing.';
  }
  return null;
}

function decision({
  status,
  sessionId,
  draftRevision,
  requestedFingerprint,
  fingerprint,
  validatedFingerprint = null,
  document = null,
  result = null,
  autoFit = null,
  rejectionCode = null,
  rejectionReasons = [],
}) {
  const frozenDocument = document ? deepFreeze(clone(document)) : null;
  const priorBounds = autoFit?.priorBounds ? deepFreeze(clone(autoFit.priorBounds)) : null;
  const nextBounds = autoFit?.nextBounds ? deepFreeze(clone(autoFit.nextBounds)) : null;
  return deepFreeze({
    status,
    sessionId: String(sessionId || ''),
    draftRevision: Math.max(0, Number(draftRevision) || 0),
    requestedFingerprint: String(requestedFingerprint || fingerprint || ''),
    validatedFingerprint: validatedFingerprint ? String(validatedFingerprint) : null,
    document: frozenDocument,
    requiredWidthPt: Number.isFinite(Number(result?.requiredWidth))
      ? Number(result.requiredWidth) : null,
    requiredHeightPt: Number.isFinite(Number(result?.requiredHeight))
      ? Number(result.requiredHeight) : null,
    availableWidthPt: Number.isFinite(Number(result?.effectiveContentWidth))
      ? Number(result.effectiveContentWidth) : null,
    autoFit: {
      applied: autoFit?.applied === true,
      priorBounds,
      nextBounds,
    },
    rejectionCode: rejectionCode ? String(rejectionCode) : null,
    rejectionReasons: [...new Set(rejectionReasons.map(String))],
  });
}

function failureCode(error) {
  if (error?.name === 'AbortError') return 'TEXT_LAYOUT_SUPERSEDED';
  if (error?.stage === 'drop-latest-text-layout-result') return 'TEXT_LAYOUT_RESULT_DROPPED';
  if (error?.code === 'SAVE_FAULT_INJECTED'
      && /drop-latest-text-layout-result/u.test(String(error?.message || ''))) {
    return 'TEXT_LAYOUT_RESULT_DROPPED';
  }
  return typeof error?.code === 'string' ? error.code : 'TEXT_LAYOUT_FAILED';
}

/**
 * Compute one canonical horizontal expansion. This never mutates the supplied
 * document or options and never derives PDF geometry from DOM pixels.
 */
export function safeHorizontalAutoFit({ document, result, options = {} } = {}) {
  if (!document?.region || !onlyWidthCapacityRejected(result)) {
    return { legal: false, rejectionCode: resultRejectionCode(result) };
  }
  const current = normalizedRect(document.region);
  const requiredWidth = Number(result.requiredWidth);
  if (!current || !Number.isFinite(requiredWidth)
      || requiredWidth <= current.width + WIDTH_EPSILON) {
    return { legal: false, rejectionCode: 'TEXT_LAYOUT_WIDTH_CAPACITY' };
  }

  const page = normalizedRect(options.pageBounds);
  const column = normalizedColumn(options.columnBounds);
  const legalLeft = Math.max(
    page?.x ?? Number.NEGATIVE_INFINITY,
    column?.left ?? Number.NEGATIVE_INFINITY,
  );
  const legalRight = Math.min(
    page ? page.x + page.width : Number.POSITIVE_INFINITY,
    column?.right ?? Number.POSITIVE_INFINITY,
  );
  if (requiredWidth > legalRight - legalLeft + WIDTH_EPSILON) {
    const columnCapacity = column ? column.right - column.left : Number.POSITIVE_INFINITY;
    return {
      legal: false,
      rejectionCode: requiredWidth > columnCapacity + WIDTH_EPSILON
        ? 'TEXT_LAYOUT_COLUMN_BOUNDARY' : 'TEXT_LAYOUT_PAGE_BOUNDARY',
    };
  }

  const advances = result.paintedLineAdvances || result.fullLineAdvances || [];
  const widestIndex = advances.reduce(
    (best, value, index) => Number(value) > Number(advances[best] || 0) ? index : best,
    0,
  );
  const alignment = document.lines?.[widestIndex]?.alignment
    || document.lines?.[0]?.alignment
    || 'left';
  let x;
  if (alignment === 'right') {
    x = current.x + current.width - requiredWidth;
  } else if (alignment === 'center') {
    const centered = current.x + (current.width - requiredWidth) / 2;
    x = Math.min(Math.max(centered, legalLeft), legalRight - requiredWidth);
  } else {
    x = current.x;
  }

  if (x < legalLeft - WIDTH_EPSILON || x + requiredWidth > legalRight + WIDTH_EPSILON) {
    const pageLeft = page?.x ?? Number.NEGATIVE_INFINITY;
    const pageRight = page ? page.x + page.width : Number.POSITIVE_INFINITY;
    const crossesPage = x < pageLeft - WIDTH_EPSILON
      || x + requiredWidth > pageRight + WIDTH_EPSILON;
    return {
      legal: false,
      rejectionCode: crossesPage
        ? 'TEXT_LAYOUT_PAGE_BOUNDARY' : 'TEXT_LAYOUT_COLUMN_BOUNDARY',
    };
  }

  const nextBounds = { ...current, x, width: requiredWidth };
  const existingBounds = (options.existingBounds || [])
    .filter((entry) => entry && String(entry.id || '') !== String(options.editId || ''))
    .map(normalizedRect)
    .filter(Boolean);
  const priorOverlaps = new Set(existingBounds
    .map((entry, index) => intersects(current, entry) ? index : -1)
    .filter((index) => index >= 0));
  const introducesOverlap = existingBounds.some(
    (entry, index) => !priorOverlaps.has(index) && intersects(nextBounds, entry),
  );
  if (introducesOverlap) {
    return { legal: false, rejectionCode: 'TEXT_LAYOUT_NEIGHBOR_OVERLAP' };
  }

  const deltaWidth = requiredWidth - current.width;
  const nextDocument = clone(document);
  nextDocument.region = { ...nextDocument.region, x, width: requiredWidth };
  const nextOptions = {
    ...clone(options),
    width: requiredWidth,
    contentWidth: Math.max(
      WIDTH_EPSILON,
      Number(options.contentWidth ?? result.effectiveContentWidth) + deltaWidth,
    ),
    effectiveContentWidth: Math.max(
      WIDTH_EPSILON,
      Number(options.effectiveContentWidth ?? result.effectiveContentWidth) + deltaWidth,
    ),
  };
  return {
    legal: true,
    document: nextDocument,
    options: nextOptions,
    priorBounds: current,
    nextBounds,
    deltaWidthPt: deltaWidth,
    deltaHeightPt: 0,
  };
}

function cacheKey({ sessionId, draftRevision, fingerprint }) {
  return `${String(sessionId)}|${Number(draftRevision) || 0}|${String(fingerprint)}`;
}

export function createFinalTextLayoutBarrier({ requestLayout = requestLatestNativeLayout } = {}) {
  const validated = new Map();
  const active = new Map();

  const recordValidatedLayout = ({ sessionId, draftRevision, fingerprint, result }) => {
    if (!sessionId || !fingerprint || !result) return false;
    validated.set(cacheKey({ sessionId, draftRevision, fingerprint }), clone(result));
    return true;
  };

  const runLayout = async ({ document, options, fingerprint, signal }) => {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal.aborted) throw Object.assign(new Error('Final text layout was superseded'), {
        name: 'AbortError', code: 'TEXT_LAYOUT_SUPERSEDED',
      });
      try {
        const response = await requestLayout(clone(document), clone(options), fingerprint);
        if (response?.fingerprint !== fingerprint) {
          return { stale: true, response };
        }
        return { stale: false, response };
      } catch (error) {
        lastError = error;
        if (!RETRYABLE_LAYOUT_CODES.has(failureCode(error)) || attempt === 1) throw error;
      }
    }
    throw lastError;
  };

  const evaluate = async (request, signal) => {
    const initialKey = cacheKey(request);
    let result = validated.get(initialKey) || null;
    let validatedFingerprint = result ? request.fingerprint : null;
    if (!result) {
      const resolved = await runLayout({ ...request, signal });
      if (resolved.stale) {
        return decision({
          status: 'failed', ...request,
          rejectionCode: 'TEXT_LAYOUT_STALE_FINGERPRINT',
          rejectionReasons: ['Exact layout returned a stale fingerprint'],
          recovery: ['keep-editing'],
        });
      }
      result = resolved.response.result;
      validatedFingerprint = request.fingerprint;
      recordValidatedLayout({ ...request, result });
    }
    if (result?.valid === true) {
      return decision({
        status: 'ready', ...request, validatedFingerprint,
        document: result.document, result,
      });
    }

    if (request.allowSafeAutoFit !== false && onlyWidthCapacityRejected(result)) {
      const fit = safeHorizontalAutoFit({
        document: request.document,
        result,
        options: request.options,
      });
      if (fit.legal) {
        const identity = {
          ...(request.identity || {}),
          sessionId: request.sessionId,
          draftRevision: request.draftRevision,
        };
        const nextRevision = createEditorLayoutRevision(fit.document, fit.options, identity);
        const resolved = await runLayout({
          document: fit.document,
          options: fit.options,
          fingerprint: nextRevision.fingerprint,
          signal,
        });
        if (resolved.stale) {
          return decision({
            status: 'failed', ...request,
            requestedFingerprint: nextRevision.fingerprint,
            rejectionCode: 'TEXT_LAYOUT_STALE_FINGERPRINT',
            rejectionReasons: ['Auto-fit layout returned a stale fingerprint'],
            recovery: ['keep-editing'],
          });
        }
        const fitted = resolved.response.result;
        recordValidatedLayout({
          sessionId: request.sessionId,
          draftRevision: request.draftRevision,
          fingerprint: nextRevision.fingerprint,
          result: fitted,
        });
        if (fitted?.valid === true) {
          return decision({
            status: 'auto-fitted', ...request,
            requestedFingerprint: nextRevision.fingerprint,
            validatedFingerprint: nextRevision.fingerprint,
            document: fitted.document,
            result: fitted,
            autoFit: {
              applied: true,
              priorBounds: fit.priorBounds,
              nextBounds: fit.nextBounds,
            },
          });
        }
        const code = resultRejectionCode(fitted);
        return decision({
          status: 'blocked', ...request,
          requestedFingerprint: nextRevision.fingerprint,
          validatedFingerprint: nextRevision.fingerprint,
          document: request.document,
          result: fitted,
          rejectionCode: code,
          rejectionReasons: [constraintReason(code), ...(fitted?.rejectionReasons || [])]
            .filter(Boolean),
          recovery: recoveryActions(code),
        });
      }
      return decision({
        status: 'blocked', ...request,
        validatedFingerprint,
        document: request.document,
        result,
        rejectionCode: fit.rejectionCode,
        rejectionReasons: [
          constraintReason(fit.rejectionCode),
          ...(result?.rejectionReasons || []),
        ].filter(Boolean),
        recovery: recoveryActions(fit.rejectionCode),
      });
    }

    const code = resultRejectionCode(result);
    return decision({
      status: 'blocked', ...request,
      validatedFingerprint,
      document: request.document,
      result,
      rejectionCode: code,
      rejectionReasons: [constraintReason(code), ...(result?.rejectionReasons || [])]
        .filter(Boolean),
      recovery: recoveryActions(code),
    });
  };

  const awaitFinalTextLayout = (request = {}) => {
    if (!request.sessionId || !request.fingerprint || !request.document) {
      return Promise.resolve(decision({
        status: 'failed', ...request,
        rejectionCode: 'TEXT_LAYOUT_STALE_FINGERPRINT',
        rejectionReasons: ['Final text layout identity is incomplete'],
        recovery: ['keep-editing'],
      }));
    }
    const key = cacheKey(request);
    const current = active.get(request.sessionId);
    if (current?.key === key) return current.promise;
    current?.controller.abort();
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    request.signal?.addEventListener?.('abort', abortFromCaller, { once: true });
    const timeoutMs = Math.max(1, Number(request.timeoutMs) || 5_000);
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        resolve(decision({
          status: 'failed', ...request,
          rejectionCode: 'TEXT_LAYOUT_TIMEOUT',
          rejectionReasons: ['Exact final text layout timed out'],
          recovery: ['keep-editing'],
        }));
      }, timeoutMs);
    });
    const work = evaluate(request, controller.signal).catch((error) => {
      const code = failureCode(error);
      if (code === 'TEXT_LAYOUT_SUPERSEDED') {
        return decision({
          status: 'superseded', ...request,
          rejectionReasons: ['Final text layout was superseded'],
        });
      }
      return decision({
        status: 'failed', ...request,
        rejectionCode: code === 'TEXT_LAYOUT_CANCELLED'
          ? 'TEXT_LAYOUT_RESULT_DROPPED' : code,
        rejectionReasons: [error instanceof Error ? error.message : String(error)],
        recovery: ['keep-editing'],
      });
    });
    const promise = Promise.race([work, timeout]).finally(() => {
      clearTimeout(timeoutId);
      request.signal?.removeEventListener?.('abort', abortFromCaller);
      if (active.get(request.sessionId)?.promise === promise) active.delete(request.sessionId);
    });
    active.set(request.sessionId, { key, controller, promise });
    return promise;
  };

  const disposeSession = (sessionId) => {
    active.get(sessionId)?.controller.abort();
    active.delete(sessionId);
    for (const key of validated.keys()) {
      if (key.startsWith(`${String(sessionId)}|`)) validated.delete(key);
    }
  };

  return { awaitFinalTextLayout, recordValidatedLayout, disposeSession };
}

const finalTextLayoutBarrier = createFinalTextLayoutBarrier();

export const awaitFinalTextLayout = finalTextLayoutBarrier.awaitFinalTextLayout;
export const recordValidatedFinalTextLayout = finalTextLayoutBarrier.recordValidatedLayout;
export const disposeFinalTextLayoutSession = finalTextLayoutBarrier.disposeSession;
