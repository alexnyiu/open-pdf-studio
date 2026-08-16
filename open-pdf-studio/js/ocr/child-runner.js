import { OcrCancelledError } from './engine.js';
import { runOcrWorkerJob } from './spike.js';

const JOB_MAGIC = new Uint8Array([79, 80, 83, 79, 67, 82, 49, 0]); // OPSOCR1\0

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value ?? []);
}

export function decodeOcrChildJob(value) {
  let bytes = asBytes(value);
  if (bytes.byteLength < 12) throw new Error('OCR child job header is truncated');
  for (let index = 0; index < JOB_MAGIC.length; index += 1) {
    if (bytes[index] !== JOB_MAGIC[index]) throw new Error('OCR child job magic is invalid');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadataLength = view.getUint32(8, true);
  const rgbaOffset = 12 + metadataLength;
  if (rgbaOffset > bytes.byteLength) throw new Error('OCR child metadata length is invalid');
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(12, rgbaOffset)));
  if (metadata.schemaVersion !== 1 || !Number.isInteger(metadata.width) ||
      !Number.isInteger(metadata.height) || metadata.width <= 0 || metadata.height <= 0) {
    throw new Error('OCR child metadata v1 is invalid');
  }
  const expected = metadata.width * metadata.height * 4;
  if (!Number.isSafeInteger(expected) || bytes.byteLength - rgbaOffset !== expected) {
    throw new Error('OCR child RGBA byte length is invalid');
  }
  // Copy just the RGBA tail so the metadata envelope can be collected before
  // inference. OcrEngine transfers this exact full buffer into the Worker.
  const rgba = bytes.slice(rgbaOffset);
  bytes = null;
  return { metadata, image: { width: metadata.width, height: metadata.height, rgba } };
}

function resourceSummary(lifecycle) {
  const adapterLoads = lifecycle
    .map((checkpoint) => Number(checkpoint.adapterLoadCount ?? 0))
    .filter(Number.isFinite);
  const disposal = lifecycle.find((checkpoint) => checkpoint.stage === 'worker-disposal-acknowledged');
  const transfer = lifecycle.find((checkpoint) => checkpoint.stage === 'input-buffer-transferred');
  const offlinePolicy = lifecycle.find(
    (checkpoint) => checkpoint.stage === 'offline-fetch-policy-installed',
  );
  return {
    liveJavaScriptPageReferences: lifecycle.some(
      (checkpoint) => checkpoint.stage === 'ocr-child-job-envelope-dropped',
    ) ? 0 : null,
    jobEnvelopeDropped: lifecycle.some(
      (checkpoint) => checkpoint.stage === 'ocr-child-job-envelope-dropped',
    ),
    onnxSessionsReleased: disposal?.onnxSessionsReleased === true,
    openCv: { used: false, allocations: 0, resourcesReleased: true },
    imageData: { used: false },
    imageBitmap: { used: false, closed: true },
    typedArrayOwnership: transfer?.ownership ?? 'not-transferred-before-cancellation',
    senderBufferDetached: transfer ? transfer.senderByteLengthAfterTransfer === 0 : null,
    transferredBuffersDropped: lifecycle.some((checkpoint) =>
      checkpoint.stage === 'worker-input-buffer-reference-dropped' &&
      checkpoint.liveInputBufferReferences === 0),
    eventListenersRemoved: lifecycle.some((checkpoint) => checkpoint.stage === 'worker-terminated'),
    messagePorts: { used: false, closed: true },
    maximumAdapterInstances: adapterLoads.length ? Math.max(...adapterLoads) : 0,
    duplicateModelInstances: adapterLoads.some((count) => count > 1),
    offline: {
      policyEnforced: disposal?.offlinePolicyEnforced === true ||
        offlinePolicy?.offlinePolicyEnforced === true,
      selfTestPassed: disposal?.offlinePolicySelfTestPassed === true,
      allowedOrigin: disposal?.offlineAllowedOrigin ?? offlinePolicy?.offlineAllowedOrigin ?? null,
      allowedRequestCount: disposal?.offlineAllowedRequestCount ??
        offlinePolicy?.offlineAllowedRequestCount ?? 0,
      blockedExternalRequestCount: disposal?.offlineBlockedExternalRequestCount ??
        offlinePolicy?.offlineBlockedExternalRequestCount ?? 0,
      blockedOrigins: disposal?.offlineBlockedOrigins ?? [],
    },
  };
}

/**
 * Run one isolated Phase A job when this app instance was launched with the
 * internal child flag. Normal app starts receive an empty payload and return
 * immediately without importing models or creating an OCR Worker.
 */
export async function runOcrPhaseAChildIfRequested() {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return false;
  let raw = await invoke('ocr_phase_a_child_take_job');
  if (asBytes(raw).byteLength === 0) return false;

  const lifecycle = [{ stage: 'ocr-child-frontend-started', atEpochMs: Date.now() }];
  let response;
  try {
    const { metadata, image } = decodeOcrChildJob(raw);
    raw = null;
    lifecycle.push({
      stage: 'ocr-child-job-decoded',
      atEpochMs: Date.now(),
      rgbaBytes: image.rgba.byteLength,
      jobId: metadata.jobId,
    });
    lifecycle.push({
      stage: 'ocr-child-job-envelope-dropped',
      atEpochMs: Date.now(),
      liveJobEnvelopeReferences: 0,
    });
    try {
      const result = await runOcrWorkerJob({
        image,
        source: {
          kind: 'pdf-page',
          path: metadata.path,
          pageIndex: metadata.pageIndex,
          scale: metadata.scale,
        },
        rasterMs: metadata.rasterMs,
        cancelAfterMs: metadata.cancelAfterMs,
        onLifecycle: (checkpoint) => lifecycle.push(checkpoint),
      });
      response = { ok: true, cancelled: false, result, lifecycle };
    } catch (error) {
      if (error instanceof OcrCancelledError || error?.code === 'OCR_CANCELLED') {
        response = {
          ok: true,
          cancelled: true,
          cancellation: { method: 'worker.terminate', message: error.message },
          lifecycle,
        };
      } else {
        response = { ok: false, error: error?.message ?? String(error), lifecycle };
      }
    }
  } catch (error) {
    response = { ok: false, error: `OCR child decode: ${error?.message ?? error}`, lifecycle };
  }
  raw = null;
  response.resources = resourceSummary(lifecycle);
  lifecycle.push({ stage: 'ocr-child-result-written', atEpochMs: Date.now() });
  await invoke('ocr_phase_a_child_complete', { payload: JSON.stringify(response) });
  return true;
}
