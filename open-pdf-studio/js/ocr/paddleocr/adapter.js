import {
  OCR_CURRENT_SCHEMA_VERSION,
  OCR_ENGINE_CONTRACT,
  OCR_RESULT_CONTRACT,
  assertOcrEngineV2,
  toValidatedOcrResultV2Json,
} from '../contracts/v2.js';
import { assertOcrJobV1 } from '../contracts/job.v1.js';
import {
  assertCompatibleOcrModelPack,
  modelPackIdentity,
} from '../contracts/model-pack.v1.js';
import { assertOcrResultMatchesJob } from '../contracts/worker-message.v1.js';
import {
  PADDLE_DB_POSTPROCESS,
  classifyUnsupportedLayout,
  derivePostprocessBudget,
  detectionMapToQuadrilaterals,
  orderRecognizedLines,
} from './postprocess.js';

export const PADDLE_OCR_ADAPTER_VERSION = '0.1.0';
export const PADDLE_OCR_RUNTIME_VERSION = '1.27.0';

const DETECTION_MAX_SIDE = 960;
const RECOGNITION_HEIGHT = 48;
const RECOGNITION_BASE_WIDTH = 320;
const RECOGNITION_MAX_WIDTH = 1280;
const RECOGNITION_BATCH_LINES = 32;

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function roundMs(value) {
  return Math.max(0, Math.round(value * 100) / 100);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sameModelPackIdentity(left, right) {
  return left?.contract === right?.contract &&
    left?.schemaVersion === right?.schemaVersion &&
    left?.packId === right?.packId &&
    left?.packVersion === right?.packVersion &&
    ['detection', 'recognition', 'dictionary']
      .every((name) => left?.assets?.[name] === right?.assets?.[name]);
}

function assertImage(image) {
  if (!image || !Number.isInteger(image.width) || image.width <= 0 ||
      !Number.isInteger(image.height) || image.height <= 0) {
    throw new TypeError('OCR image width and height must be positive integers');
  }
  if (!(image.rgba instanceof Uint8Array) && !(image.rgba instanceof Uint8ClampedArray)) {
    throw new TypeError('OCR image rgba must be a Uint8Array');
  }
  const expected = image.width * image.height * 4;
  if (image.rgba.byteLength !== expected) {
    throw new RangeError(`OCR image has ${image.rgba.byteLength} RGBA bytes; expected ${expected}`);
  }
}

function roundToStride(value, stride = 32) {
  return Math.max(stride, Math.round(value / stride) * stride);
}

function sampleBilinear(rgba, width, height, x, y, channel) {
  const sx = clamp(x, 0, width - 1);
  const sy = clamp(y, 0, height - 1);
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = sx - x0;
  const ty = sy - y0;
  const top = rgba[(y0 * width + x0) * 4 + channel] * (1 - tx) +
    rgba[(y0 * width + x1) * 4 + channel] * tx;
  const bottom = rgba[(y1 * width + x0) * 4 + channel] * (1 - tx) +
    rgba[(y1 * width + x1) * 4 + channel] * tx;
  return top * (1 - ty) + bottom * ty;
}

export function prepareDetectionTensor(ort, image, maxSide = DETECTION_MAX_SIDE) {
  assertImage(image);
  const sourceMax = Math.max(image.width, image.height);
  const scale = sourceMax > maxSide ? maxSide / sourceMax : 1;
  const width = roundToStride(image.width * scale);
  const height = roundToStride(image.height * scale);
  const plane = width * height;
  const tensorData = new Float32Array(plane * 3);
  const means = [0.485, 0.456, 0.406];
  const stds = [0.229, 0.224, 0.225];
  const rgbaChannelsForBgr = [2, 1, 0];

  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) * image.height / height - 0.5;
    for (let x = 0; x < width; x += 1) {
      const sourceX = (x + 0.5) * image.width / width - 0.5;
      const pixel = y * width + x;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = sampleBilinear(
          image.rgba,
          image.width,
          image.height,
          sourceX,
          sourceY,
          rgbaChannelsForBgr[channel],
        ) / 255;
        tensorData[channel * plane + pixel] = (value - means[channel]) / stds[channel];
      }
    }
  }

  return {
    tensor: new ort.Tensor('float32', tensorData, [1, 3, height, width]),
    width,
    height,
  };
}

export function detectionMapToLinePolygons(output, sourceWidth, sourceHeight, options = {}) {
  return detectionMapToQuadrilaterals(output, sourceWidth, sourceHeight, options);
}

export function detectionMapToLineBoxes(output, sourceWidth, sourceHeight, options = {}) {
  return detectionMapToLinePolygons(output, sourceWidth, sourceHeight, options);
}

export function prepareRecognitionTensor(ort, image, boxes) {
  assertImage(image);
  if (!Array.isArray(boxes) || boxes.length === 0) return null;
  const widths = boxes.map((box) => {
    const ratio = Math.max(1 / RECOGNITION_HEIGHT, box.width / Math.max(1, box.height));
    return clamp(Math.ceil(RECOGNITION_HEIGHT * ratio), 1, RECOGNITION_MAX_WIDTH);
  });
  const batchWidth = clamp(
    Math.ceil(Math.max(RECOGNITION_BASE_WIDTH, ...widths) / 8) * 8,
    RECOGNITION_BASE_WIDTH,
    RECOGNITION_MAX_WIDTH,
  );
  const plane = RECOGNITION_HEIGHT * batchWidth;
  const sampleSize = plane * 3;
  const tensorData = new Float32Array(boxes.length * sampleSize);
  const rgbaChannelsForBgr = [2, 1, 0];

  boxes.forEach((box, batchIndex) => {
    const recognitionPolygon = box.recognitionPolygon ?? box.polygon;
    if (!Array.isArray(recognitionPolygon) || recognitionPolygon.length !== 4) {
      throw new TypeError('Recognition input requires a detector quadrilateral');
    }
    const [topLeft, topRight, bottomRight, bottomLeft] = recognitionPolygon;
    const targetWidth = widths[batchIndex];
    for (let y = 0; y < RECOGNITION_HEIGHT; y += 1) {
      const vertical = (y + 0.5) / RECOGNITION_HEIGHT;
      for (let x = 0; x < targetWidth; x += 1) {
        const horizontal = (x + 0.5) / targetWidth;
        const sourceX = (1 - vertical) * ((1 - horizontal) * topLeft[0] + horizontal * topRight[0]) +
          vertical * ((1 - horizontal) * bottomLeft[0] + horizontal * bottomRight[0]);
        const sourceY = (1 - vertical) * ((1 - horizontal) * topLeft[1] + horizontal * topRight[1]) +
          vertical * ((1 - horizontal) * bottomLeft[1] + horizontal * bottomRight[1]);
        const pixel = y * batchWidth + x;
        for (let channel = 0; channel < 3; channel += 1) {
          const value = sampleBilinear(
            image.rgba,
            image.width,
            image.height,
            sourceX,
            sourceY,
            rgbaChannelsForBgr[channel],
          );
          tensorData[batchIndex * sampleSize + channel * plane + pixel] = value / 127.5 - 1;
        }
      }
    }
  });

  return {
    tensor: new ort.Tensor('float32', tensorData, [boxes.length, 3, RECOGNITION_HEIGHT, batchWidth]),
    batchWidth,
  };
}

export function decodeCtc(output, characters) {
  const dims = output?.dims;
  const values = output?.data;
  if (!Array.isArray(dims) || dims.length !== 3 || !(values instanceof Float32Array)) {
    throw new TypeError('PaddleOCR recognizer returned an unexpected tensor');
  }
  const [batch, timeSteps, classCount] = dims.map(Number);
  if (classCount !== characters.length || values.length !== batch * timeSteps * classCount) {
    throw new RangeError(`PaddleOCR recognizer class count ${classCount} does not match dictionary ${characters.length}`);
  }
  const decoded = [];
  for (let batchIndex = 0; batchIndex < batch; batchIndex += 1) {
    let previous = -1;
    const text = [];
    const confidences = [];
    for (let step = 0; step < timeSteps; step += 1) {
      const offset = (batchIndex * timeSteps + step) * classCount;
      let bestIndex = 0;
      let bestScore = values[offset];
      for (let index = 1; index < classCount; index += 1) {
        const score = values[offset + index];
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      if (bestIndex !== 0 && bestIndex !== previous) {
        text.push(characters[bestIndex] ?? '');
        confidences.push(clamp(bestScore, 0, 1));
      }
      previous = bestIndex;
    }
    const confidence = confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : 0;
    decoded.push({ text: text.join(''), confidence: clamp(confidence, 0, 1) });
  }
  return decoded;
}

export async function sha256Hex(buffer) {
  if (!globalThis.crypto?.subtle) throw new Error('WebCrypto SHA-256 is unavailable');
  const bytes = buffer instanceof ArrayBuffer
    ? buffer
    : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function defaultLoadBinary(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to load OCR asset ${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

function originKey(url) {
  return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
}

export function createSameOriginFetch(
  allowedOrigin,
  fetchImpl = globalThis.fetch,
  onRequest = null,
) {
  const allowedUrl = new URL(allowedOrigin);
  const allowedKey = originKey(allowedUrl);
  if (typeof fetchImpl !== 'function') throw new TypeError('OCR asset loader requires fetch');
  return async (input, init) => {
    const inputUrl = typeof input === 'string' || input instanceof URL
      ? input
      : input?.url;
    if (!inputUrl) throw new TypeError('Offline OCR fetch requires a URL');
    const url = new URL(inputUrl, allowedUrl);
    const requestedKey = originKey(url);
    const allowed = requestedKey === allowedKey;
    try {
      onRequest?.({
        allowed,
        allowedOrigin: allowedKey,
        requestedOrigin: requestedKey,
        protocol: url.protocol,
      });
    } catch {
      // Audit callbacks are diagnostics and cannot change the security policy.
    }
    if (!allowed) {
      const error = new Error(`Offline OCR blocked a non-local asset URL: ${requestedKey}`);
      error.code = 'OCR_OFFLINE_NETWORK_BLOCKED';
      throw error;
    }
    return fetchImpl(
      typeof input === 'string' || input instanceof URL ? url.href : input,
      init,
    );
  };
}

export function createSameOriginAssetLoader(
  allowedOrigin,
  fetchImpl = globalThis.fetch,
  onRequest = null,
) {
  const localFetch = createSameOriginFetch(allowedOrigin, fetchImpl, onRequest);
  return async (input) => {
    const url = new URL(input, allowedOrigin);
    const response = await localFetch(url.href, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Failed to load OCR asset ${url.href}: HTTP ${response.status}`);
    return response.arrayBuffer();
  };
}

async function loadAndVerifyAsset(baseUrl, record, loadBinary) {
  const url = new URL(record.file, baseUrl).href;
  const buffer = await loadBinary(url);
  if (buffer.byteLength !== record.bytes) {
    throw new Error(`${record.file} size mismatch: got ${buffer.byteLength}, expected ${record.bytes}`);
  }
  const digest = await sha256Hex(buffer);
  if (digest !== record.sha256) {
    throw new Error(`${record.file} checksum mismatch: got ${digest}, expected ${record.sha256}`);
  }
  return buffer;
}

export function createPaddleOcrEngineDescriptor(manifest) {
  return assertOcrEngineV2({
    contract: OCR_ENGINE_CONTRACT,
    schemaVersion: OCR_CURRENT_SCHEMA_VERSION,
    engineId: 'paddleocr-pp-ocrv6-small-onnx-wasm',
    adapterVersion: PADDLE_OCR_ADAPTER_VERSION,
    provider: 'PaddleOCR',
    model: {
      family: 'PP-OCRv6',
      tier: 'small',
      detection: 'PP-OCRv6_small_det_onnx',
      recognition: 'PP-OCRv6_small_rec_onnx',
    },
    modelPack: modelPackIdentity(manifest),
    runtime: {
      name: 'onnxruntime-web',
      version: PADDLE_OCR_RUNTIME_VERSION,
      executionProvider: 'wasm',
      offline: true,
    },
    capabilities: {
      textDetection: true,
      textRecognition: true,
      lineResults: true,
      linePolygons: true,
      lineBaselines: false,
      wordResults: false,
      wordPolygons: false,
      alternatives: false,
      languageDetection: false,
      writingDirectionDetection: false,
      preprocessingMetadata: false,
      nativePdfWriting: false,
    },
  });
}

export class PaddleOcrV6SmallAdapter {
  constructor({ ort, manifest, assetBaseUrl, loadBinary = defaultLoadBinary, onLifecycle = null }) {
    if (!ort?.InferenceSession || !ort?.Tensor) throw new TypeError('ONNX Runtime Web is required');
    const engine = createPaddleOcrEngineDescriptor(manifest);
    assertCompatibleOcrModelPack(manifest, engine, { platform: 'macos' });
    this.ort = ort;
    this.manifest = manifest;
    this.assetBaseUrl = assetBaseUrl;
    this.loadBinary = loadBinary;
    this.onLifecycle = typeof onLifecycle === 'function' ? onLifecycle : null;
    this.engine = engine;
    this.detector = null;
    this.recognizer = null;
    this.characters = null;
    this.modelStartupMs = 0;
    this.disposed = false;
  }

  emitLifecycle(stage, detail = {}) {
    try {
      this.onLifecycle?.(stage, detail);
    } catch {
      // Measurement hooks must not affect model execution or disposal.
    }
  }

  async initialize() {
    if (this.disposed) throw new Error('PaddleOCR adapter has been disposed');
    if (this.detector && this.recognizer && this.characters) return 0;
    this.emitLifecycle('before-model-initialization', {
      detectorSession: false,
      recognizerSession: false,
      adapterInstances: 1,
    });
    const started = now();
    let dictionaryBuffer = await loadAndVerifyAsset(
      this.assetBaseUrl,
      this.manifest.assets.dictionary,
      this.loadBinary,
    );
    const dictionary = JSON.parse(new TextDecoder().decode(dictionaryBuffer));
    if (!Array.isArray(dictionary.characters) || dictionary.characters.length !== this.manifest.characterCount) {
      throw new Error('PP-OCRv6 character dictionary is invalid');
    }
    this.characters = ['blank', ...dictionary.characters, ' '];
    dictionaryBuffer = null;

    let detectorBytes = await loadAndVerifyAsset(
      this.assetBaseUrl,
      this.manifest.assets.detection,
      this.loadBinary,
    );
    this.detector = await this.ort.InferenceSession.create(detectorBytes, {
      executionProviders: ['wasm'],
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
    });
    detectorBytes = null;

    let recognizerBytes = await loadAndVerifyAsset(
      this.assetBaseUrl,
      this.manifest.assets.recognition,
      this.loadBinary,
    );
    this.recognizer = await this.ort.InferenceSession.create(recognizerBytes, {
      executionProviders: ['wasm'],
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
    });
    recognizerBytes = null;
    this.modelStartupMs = roundMs(now() - started);
    this.emitLifecycle('after-model-initialization', {
      detectorSession: true,
      recognizerSession: true,
      adapterInstances: 1,
      modelStartupMs: this.modelStartupMs,
      modelByteReferencesDropped: true,
    });
    return this.modelStartupMs;
  }

  async recognize({ job, image, workerStartupMs = 0, rasterMs = 0 }) {
    assertOcrJobV1(job);
    assertImage(image);
    if (job.engineId !== this.engine.engineId) {
      throw new TypeError('OCR job engineId does not match the Paddle adapter');
    }
    if (!sameModelPackIdentity(job.modelPack, this.engine.modelPack)) {
      throw new TypeError('OCR job model-pack identity does not match the Paddle adapter');
    }
    if (job.page.sourceRaster.widthPx !== image.width ||
        job.page.sourceRaster.heightPx !== image.height) {
      throw new RangeError('OCR image dimensions do not match the job source raster');
    }
    const options = job.recognitionOptions;
    if (options.languagePolicy.mode !== 'automatic' ||
        options.languagePolicy.languages.length > 0 || options.languagePolicy.scripts.length > 0) {
      throw new TypeError('The current Paddle model pack does not accept language or script selectors');
    }
    if (options.includeWords) throw new TypeError('The current Paddle adapter does not provide word results');
    if (options.orientation.mode !== 'none' || options.orientation.degrees !== null) {
      throw new TypeError('The current Paddle adapter does not provide orientation handling');
    }
    if (options.deskew) throw new TypeError('The current Paddle adapter does not provide deskewing');
    if (options.preprocessing.mode !== 'none' || options.preprocessing.operations.length > 0) {
      throw new TypeError('The current Paddle adapter does not provide preprocessing');
    }
    const totalStarted = now();
    const modelStartupMs = await this.initialize();

    let detectionInput = null;
    let detectionOutputs = null;
    let result;
    try {
      const detectionStarted = now();
      detectionInput = prepareDetectionTensor(this.ort, image);
      detectionOutputs = await this.detector.run({ x: detectionInput.tensor });
      const detectionOutput = detectionOutputs[this.detector.outputNames[0]];
      const postprocessBudget = derivePostprocessBudget({
        sourceWidth: image.width,
        sourceHeight: image.height,
      });
      const boxes = detectionMapToLinePolygons(
        detectionOutput,
        image.width,
        image.height,
        { budget: postprocessBudget },
      );
      const detectionMs = roundMs(now() - detectionStarted);

      const recognitionStarted = now();
      const decoded = [];
      for (let offset = 0; offset < boxes.length; offset += RECOGNITION_BATCH_LINES) {
        const batchBoxes = boxes.slice(offset, offset + RECOGNITION_BATCH_LINES);
        let recognitionInput = null;
        let recognitionOutputs = null;
        try {
          recognitionInput = prepareRecognitionTensor(this.ort, image, batchBoxes);
          recognitionOutputs = await this.recognizer.run({ x: recognitionInput.tensor });
          decoded.push(...decodeCtc(
            recognitionOutputs[this.recognizer.outputNames[0]],
            this.characters,
          ));
        } finally {
          recognitionInput?.tensor?.dispose?.();
          for (const output of Object.values(recognitionOutputs ?? {})) output?.dispose?.();
        }
      }
      const recognitionMs = roundMs(now() - recognitionStarted);

      const recognizedLines = boxes.map((box, index) => {
        const recognition = decoded[index] ?? { text: '', confidence: 0 };
        const confidence = Math.sqrt(box.detectionConfidence * recognition.confidence);
        return {
          ...box,
          text: recognition.text.trim(),
          confidence: Math.round(clamp(confidence, 0, 1) * 1_000_000) / 1_000_000,
        };
      });
      const usableLines = recognizedLines.filter((line) =>
        line.text.length > 0 && line.confidence >= PADDLE_DB_POSTPROCESS.recognitionConfidenceThreshold);
      const layout = orderRecognizedLines(usableLines, postprocessBudget);
      const unsupportedContentReasons = classifyUnsupportedLayout({
        candidates: boxes,
        recognizedLines,
        blocks: layout.blocks,
      });
      const lines = layout.lines.map((line, index) => {
        return {
          id: `line-${index + 1}`,
          text: line.text,
          confidence: line.confidence,
          boundingBox: {
            coordinateSpace: 'source-raster-pixels',
            x: roundMs(line.boundingBox.x),
            y: roundMs(line.boundingBox.y),
            width: roundMs(line.boundingBox.width),
            height: roundMs(line.boundingBox.height),
          },
          polygon: {
            coordinateSpace: 'source-raster-pixels',
            points: line.polygon.map((point) => point.map(roundMs)),
          },
          baseline: {
            status: 'unavailable',
            coordinateSpace: 'source-raster-pixels',
            reason: 'engine-did-not-provide',
          },
        };
      });

      result = toValidatedOcrResultV2Json({
        contract: OCR_RESULT_CONTRACT,
        schemaVersion: OCR_CURRENT_SCHEMA_VERSION,
        jobId: job.jobId,
        requestId: job.requestId,
        engine: this.engine,
        document: structuredClone(job.document),
        page: {
          id: job.page.id,
          index: job.page.index,
          revision: job.page.revision,
          status: unsupportedContentReasons.length > 0 ? 'unsupported' : 'completed',
        },
        recognitionConfigurationHash: structuredClone(job.recognitionConfigurationHash),
        sourceRaster: structuredClone(job.page.sourceRaster),
        text: lines.map((line) => line.text).filter(Boolean).join('\n'),
        lines,
        detectedLanguages: [],
        warnings: [
          {
            code: 'db-quadrilateral-postprocessing',
            message: 'Detection uses bounded DB-style quadrilateral extraction and deterministic layout ordering.',
            severity: 'info',
            entityIds: [],
          },
        ],
        unsupportedContentReasons,
        preprocessing: {
          status: 'none',
          operations: [],
          outputRaster: null,
          transform: null,
        },
        metrics: {
          workerStartupMs: roundMs(workerStartupMs),
          modelStartupMs: roundMs(modelStartupMs),
          rasterMs: roundMs(rasterMs),
          detectionMs,
          recognitionMs,
          totalOcrMs: roundMs(now() - totalStarted),
        },
      });
      assertOcrResultMatchesJob(result, job);
    } finally {
      detectionInput?.tensor?.dispose?.();
      for (const output of Object.values(detectionOutputs ?? {})) output?.dispose?.();
      detectionInput = null;
      detectionOutputs = null;
    }
    this.emitLifecycle('after-one-page-inference', {
      detectorSession: true,
      recognizerSession: true,
      inferenceTensorsDisposed: true,
    });
    return result;
  }

  async dispose() {
    if (this.disposed) return;
    this.emitLifecycle('immediately-before-adapter-disposal', {
      detectorSession: Boolean(this.detector),
      recognizerSession: Boolean(this.recognizer),
    });
    const sessions = [this.detector, this.recognizer].filter(Boolean);
    this.detector = null;
    this.recognizer = null;
    this.characters = null;
    const releases = await Promise.allSettled(sessions.map((session) => session.release?.()));
    this.disposed = true;
    this.emitLifecycle('after-ocr-engine-disposal', {
      detectorSession: false,
      recognizerSession: false,
      onnxSessionsReleased: releases.every((release) => release.status === 'fulfilled'),
    });
    const failure = releases.find((release) => release.status === 'rejected');
    this.ort = null;
    this.manifest = null;
    this.assetBaseUrl = null;
    this.loadBinary = null;
    this.engine = null;
    this.onLifecycle = null;
    if (failure) throw failure.reason;
  }
}
