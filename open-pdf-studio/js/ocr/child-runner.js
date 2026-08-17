import {
  OCR_NATIVE_JOB_CONTRACT,
  OCR_NATIVE_LIMITS,
  OCR_NATIVE_RESULT_CONTRACT,
  OCR_NATIVE_SCHEMA_VERSION,
  assertNativeOcrJobEnvelopeV1,
  assertNativeOcrResultEnvelopeV1,
} from './contracts/native-job.v1.js';
import { runOcrJob } from './run-job.js';

const JOB_MAGIC = new Uint8Array([79, 80, 83, 79, 67, 82, 50, 0]); // OPSOCR2\0

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value ?? []);
}

export function decodeNativeOcrChildJob(value) {
  let bytes = asBytes(value);
  if (bytes.byteLength < 12) throw new Error('OCR child job header is truncated');
  for (let index = 0; index < JOB_MAGIC.length; index += 1) {
    if (bytes[index] !== JOB_MAGIC[index]) throw new Error('OCR child job magic is invalid');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadataLength = view.getUint32(8, true);
  if (metadataLength === 0 || metadataLength > OCR_NATIVE_LIMITS.maxMetadataBytes) {
    throw new Error('OCR child metadata exceeds its byte limit');
  }
  const rgbaOffset = 12 + metadataLength;
  if (rgbaOffset > bytes.byteLength) throw new Error('OCR child metadata length is invalid');
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(12, rgbaOffset)));
  assertNativeOcrJobEnvelopeV1(metadata, {
    serializedMetadataBytes: metadataLength,
    totalEnvelopeBytes: bytes.byteLength,
  });
  const expected = metadata.raster.byteLength;
  if (bytes.byteLength - rgbaOffset !== expected) {
    throw new Error('OCR child RGBA byte length is invalid');
  }
  // Copy just the RGBA tail so the metadata envelope can be collected before
  // inference. OcrEngine transfers this exact full buffer into the Worker.
  const rgba = bytes.slice(rgbaOffset);
  bytes = null;
  return {
    metadata,
    job: metadata.job,
    image: {
      width: metadata.raster.widthPx,
      height: metadata.raster.heightPx,
      rgba,
    },
  };
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
 * Run one production job when this app instance was launched with the
 * internal child flag. Normal app starts receive an empty payload and return
 * immediately without importing models or creating an OCR Worker.
 */
export async function runOcrChildIfRequested() {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return false;
  let raw;
  try {
    raw = await invoke('ocr_child_take_job');
  } catch (error) {
    await invoke('ocr_child_abort', {
      code: 'OCR_CHILD_JOB_PROTOCOL',
      message: `OCR child job validation failed: ${error?.message ?? error}`,
    });
    return true;
  }
  if (asBytes(raw).byteLength === 0) return false;

  const lifecycle = [{ stage: 'ocr-child-frontend-started', atEpochMs: Date.now() }];
  let metadata = null;
  let nativeResult;
  try {
    const decoded = decodeNativeOcrChildJob(raw);
    metadata = decoded.metadata;
    const { image, job } = decoded;
    raw = null;
    lifecycle.push({
      stage: 'ocr-child-job-decoded',
      atEpochMs: Date.now(),
      rgbaBytes: image.rgba.byteLength,
      jobId: job.jobId,
    });
    lifecycle.push({
      stage: 'ocr-child-job-envelope-dropped',
      atEpochMs: Date.now(),
      liveJobEnvelopeReferences: 0,
    });
    let result = null;
    let failure = null;
    try {
      result = await runOcrJob({
        image,
        job,
        rasterMs: metadata.rasterMs ?? 0,
        onLifecycle: (checkpoint) => lifecycle.push(checkpoint),
      });
    } catch (error) {
      failure = {
        code: typeof error?.code === 'string' ? error.code : 'OCR_CHILD_INFERENCE_FAILED',
        stage: 'recognizing',
        message: typeof error?.message === 'string' && error.message.length <= 4096
          ? error.message
          : 'OCR child inference failed',
        retryable: false,
      };
    }
    const resources = resourceSummary(lifecycle);
    nativeResult = {
      contract: OCR_NATIVE_RESULT_CONTRACT,
      schemaVersion: OCR_NATIVE_SCHEMA_VERSION,
      status: failure ? 'failed' : 'completed',
      jobId: job.jobId,
      requestId: job.requestId,
      documentId: job.document.id,
      documentRevision: job.document.revision,
      documentGeneration: job.document.generation,
      pageId: job.page.id,
      pageIndex: job.page.index,
      pageRevision: job.page.revision,
      engineId: job.engineId,
      modelPack: structuredClone(job.modelPack),
      recognitionConfigurationHash: structuredClone(job.recognitionConfigurationHash),
      sourceRaster: structuredClone(job.page.sourceRaster),
      resultFileId: metadata.resultFile.id,
      result,
      failure,
      lifecycle,
      resources,
    };
    assertNativeOcrResultEnvelopeV1(nativeResult, {
      job,
      resultFileId: metadata.resultFile.id,
    });
  } catch (error) {
    raw = null;
    await invoke('ocr_child_abort', {
      code: metadata ? 'OCR_CHILD_RESULT_PROTOCOL' : 'OCR_CHILD_JOB_PROTOCOL',
      message: `OCR child protocol validation failed: ${error?.message ?? error}`,
    });
    return true;
  }
  raw = null;
  lifecycle.push({ stage: 'ocr-child-result-written', atEpochMs: Date.now() });
  await invoke('ocr_child_complete', { payload: JSON.stringify(nativeResult) });
  return true;
}
