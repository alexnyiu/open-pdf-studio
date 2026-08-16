import {
  OCR_ENGINE_CONTRACT,
  OCR_RESULT_CONTRACT,
  OCR_SCHEMA_VERSION,
  assertOcrEngineV1,
  toValidatedOcrResultJson,
} from '../contracts/v1.js';
import { assertCompatibleOcrModelPack } from '../contracts/model-pack.v1.js';

export const PADDLE_OCR_ADAPTER_VERSION = '0.1.0';
export const PADDLE_OCR_RUNTIME_VERSION = '1.27.0';

const DETECTION_THRESHOLD = 0.2;
const DETECTION_BOX_THRESHOLD = 0.45;
const DETECTION_MAX_SIDE = 960;
const RECOGNITION_HEIGHT = 48;
const RECOGNITION_BASE_WIDTH = 320;
const RECOGNITION_MAX_WIDTH = 1280;
const MIN_COMPONENT_PIXELS = 6;

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function roundMs(value) {
  return Math.max(0, Math.round(value * 100) / 100);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function connectedComponents(scores, width, height, threshold) {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components = [];

  for (let start = 0; start < scores.length; start += 1) {
    if (visited[start] || scores[start] <= threshold) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let count = 0;
    let scoreSum = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (head < tail) {
      const index = queue[head++];
      const y = Math.floor(index / width);
      const x = index - y * width;
      count += 1;
      scoreSum += scores[index];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(height - 1, y + 1);
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      for (let ny = y0; ny <= y1; ny += 1) {
        for (let nx = x0; nx <= x1; nx += 1) {
          const neighbour = ny * width + nx;
          if (!visited[neighbour] && scores[neighbour] > threshold) {
            visited[neighbour] = 1;
            queue[tail++] = neighbour;
          }
        }
      }
    }

    if (count >= MIN_COMPONENT_PIXELS) {
      components.push({ minX, minY, maxX, maxY, count, score: scoreSum / count });
    }
  }
  return components;
}

function verticalOverlap(a, b) {
  return Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1);
}

function mergeComponentsIntoLines(components) {
  const sorted = [...components].sort((a, b) => {
    const ay = (a.minY + a.maxY) / 2;
    const by = (b.minY + b.maxY) / 2;
    return ay - by || a.minX - b.minX;
  });
  const lines = [];

  for (const component of sorted) {
    const componentHeight = component.maxY - component.minY + 1;
    const componentCenter = (component.minY + component.maxY) / 2;
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const line of lines) {
      const lineHeight = line.maxY - line.minY + 1;
      const overlap = verticalOverlap(line, component);
      const overlapRatio = overlap / Math.min(lineHeight, componentHeight);
      const centerDistance = Math.abs((line.minY + line.maxY) / 2 - componentCenter);
      if ((overlapRatio >= 0.25 || centerDistance <= Math.max(lineHeight, componentHeight) * 0.55) &&
          centerDistance < bestDistance) {
        best = line;
        bestDistance = centerDistance;
      }
    }
    if (!best) {
      lines.push({ ...component, weightedScore: component.score * component.count });
      continue;
    }
    best.minX = Math.min(best.minX, component.minX);
    best.minY = Math.min(best.minY, component.minY);
    best.maxX = Math.max(best.maxX, component.maxX);
    best.maxY = Math.max(best.maxY, component.maxY);
    best.count += component.count;
    best.weightedScore += component.score * component.count;
    best.score = best.weightedScore / best.count;
  }

  return lines.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
}

export function detectionMapToLineBoxes(output, sourceWidth, sourceHeight, options = {}) {
  const dims = output?.dims;
  const scores = output?.data;
  if (!Array.isArray(dims) || dims.length !== 4 || !(scores instanceof Float32Array)) {
    throw new TypeError('PaddleOCR detector returned an unexpected tensor');
  }
  const mapHeight = Number(dims[2]);
  const mapWidth = Number(dims[3]);
  if (mapWidth <= 0 || mapHeight <= 0 || scores.length !== mapWidth * mapHeight) {
    throw new RangeError('PaddleOCR detector tensor dimensions are invalid');
  }

  const threshold = options.threshold ?? DETECTION_THRESHOLD;
  const boxThreshold = options.boxThreshold ?? DETECTION_BOX_THRESHOLD;
  const components = connectedComponents(scores, mapWidth, mapHeight, threshold)
    .filter((component) => component.score >= boxThreshold);
  const merged = mergeComponentsIntoLines(components);
  const maxLines = options.maxLines ?? 64;

  return merged.slice(0, maxLines).map((line) => {
    let x = line.minX / mapWidth * sourceWidth;
    let y = line.minY / mapHeight * sourceHeight;
    let width = (line.maxX - line.minX + 1) / mapWidth * sourceWidth;
    let height = (line.maxY - line.minY + 1) / mapHeight * sourceHeight;
    const padX = Math.max(2, height * 0.35);
    const padY = Math.max(2, height * 0.45);
    x = clamp(x - padX, 0, sourceWidth - 1);
    y = clamp(y - padY, 0, sourceHeight - 1);
    width = clamp(width + padX * 2, 1, sourceWidth - x);
    height = clamp(height + padY * 2, 1, sourceHeight - y);
    return { x, y, width, height, detectionConfidence: clamp(line.score, 0, 1) };
  });
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
    const targetWidth = widths[batchIndex];
    for (let y = 0; y < RECOGNITION_HEIGHT; y += 1) {
      const sourceY = box.y + (y + 0.5) * box.height / RECOGNITION_HEIGHT - 0.5;
      for (let x = 0; x < targetWidth; x += 1) {
        const sourceX = box.x + (x + 0.5) * box.width / targetWidth - 0.5;
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

export function createPaddleOcrEngineDescriptor() {
  return assertOcrEngineV1({
    contract: OCR_ENGINE_CONTRACT,
    schemaVersion: OCR_SCHEMA_VERSION,
    engineId: 'paddleocr-pp-ocrv6-small-onnx-wasm',
    adapterVersion: PADDLE_OCR_ADAPTER_VERSION,
    provider: 'PaddleOCR',
    model: {
      family: 'PP-OCRv6',
      tier: 'small',
      detection: 'PP-OCRv6_small_det_onnx',
      recognition: 'PP-OCRv6_small_rec_onnx',
    },
    runtime: {
      name: 'onnxruntime-web',
      version: PADDLE_OCR_RUNTIME_VERSION,
      executionProvider: 'wasm',
      offline: true,
    },
    capabilities: {
      textDetection: true,
      textRecognition: true,
      wordBoxes: false,
      pdfWriting: false,
    },
  });
}

export class PaddleOcrV6SmallAdapter {
  constructor({ ort, manifest, assetBaseUrl, loadBinary = defaultLoadBinary, onLifecycle = null }) {
    if (!ort?.InferenceSession || !ort?.Tensor) throw new TypeError('ONNX Runtime Web is required');
    const engine = createPaddleOcrEngineDescriptor();
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

  async recognize({ requestId, image, source, workerStartupMs = 0, rasterMs = 0 }) {
    assertImage(image);
    const modelStartupMs = await this.initialize();
    const totalStarted = now();

    let detectionInput = null;
    let detectionOutputs = null;
    let recognitionInput = null;
    let recognitionOutputs = null;
    let result;
    try {
      const detectionStarted = now();
      detectionInput = prepareDetectionTensor(this.ort, image);
      detectionOutputs = await this.detector.run({ x: detectionInput.tensor });
      const detectionOutput = detectionOutputs[this.detector.outputNames[0]];
      const boxes = detectionMapToLineBoxes(detectionOutput, image.width, image.height);
      const detectionMs = roundMs(now() - detectionStarted);

      const recognitionStarted = now();
      recognitionInput = prepareRecognitionTensor(this.ort, image, boxes);
      let decoded = [];
      if (recognitionInput) {
        recognitionOutputs = await this.recognizer.run({ x: recognitionInput.tensor });
        decoded = decodeCtc(recognitionOutputs[this.recognizer.outputNames[0]], this.characters);
      }
      const recognitionMs = roundMs(now() - recognitionStarted);

      const lines = boxes.map((box, index) => {
        const recognition = decoded[index] ?? { text: '', confidence: 0 };
        const confidence = Math.sqrt(box.detectionConfidence * recognition.confidence);
        const x2 = box.x + box.width;
        const y2 = box.y + box.height;
        return {
          id: `line-${index + 1}`,
          text: recognition.text,
          confidence: Math.round(clamp(confidence, 0, 1) * 1_000_000) / 1_000_000,
          boundingBox: {
            x: roundMs(box.x),
            y: roundMs(box.y),
            width: roundMs(box.width),
            height: roundMs(box.height),
          },
          polygon: [
            [roundMs(box.x), roundMs(box.y)],
            [roundMs(x2), roundMs(box.y)],
            [roundMs(x2), roundMs(y2)],
            [roundMs(box.x), roundMs(y2)],
          ],
        };
      });

      result = toValidatedOcrResultJson({
      contract: OCR_RESULT_CONTRACT,
      schemaVersion: OCR_SCHEMA_VERSION,
      requestId,
      engine: this.engine,
      source: {
        kind: 'pdf-page',
        path: source.path,
        pageIndex: source.pageIndex,
        widthPx: image.width,
        heightPx: image.height,
        scale: source.scale,
      },
      text: lines.map((line) => line.text).filter(Boolean).join('\n'),
      lines,
      metrics: {
        workerStartupMs: roundMs(workerStartupMs),
        modelStartupMs: roundMs(modelStartupMs),
        rasterMs: roundMs(rasterMs),
        detectionMs,
        recognitionMs,
        totalOcrMs: roundMs(now() - totalStarted),
      },
        warnings: [
          'Phase A uses axis-aligned connected-component DB postprocessing; rotated and curved text remain unqualified.',
        ],
      });
    } finally {
      detectionInput?.tensor?.dispose?.();
      recognitionInput?.tensor?.dispose?.();
      for (const output of Object.values(detectionOutputs ?? {})) output?.dispose?.();
      for (const output of Object.values(recognitionOutputs ?? {})) output?.dispose?.();
      detectionInput = null;
      detectionOutputs = null;
      recognitionInput = null;
      recognitionOutputs = null;
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
