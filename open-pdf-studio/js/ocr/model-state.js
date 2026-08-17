// @ts-check

import {
  assertOcrModelPackV1,
  modelPackIdentity,
  validateCompatibleOcrModelPack,
} from './contracts/model-pack.v1.js';
import { createPaddleOcrEngineDescriptor } from './paddleocr/adapter.js';

export const OCR_MODEL_PACK_STATES = Object.freeze([
  'installed',
  'missing',
  'incompatible',
  'corrupt',
  'updating',
]);

export const CORE_MACOS_MODEL_PACK_URL = '/ocr/pp-ocrv6-small/manifest.json';
export const CORE_MACOS_MODEL_ASSET_BASE_URL = '/ocr/pp-ocrv6-small/';
export const CORE_MACOS_MODEL_TRUST_ROOT = 'open-pdf-studio-bundled-model-packs-v1';

export const OPTIONAL_OCR_MODEL_PACKS = Object.freeze({
  enabled: false,
  reason: 'signed-manifest-installer-not-implemented',
});

class ModelPackProbeError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ModelPackProbeError';
    this.kind = kind;
  }
}

function snapshot(value) {
  return structuredClone(value);
}

async function sha256Hex(buffer) {
  if (!globalThis.crypto?.subtle) throw new ModelPackProbeError('corrupt', 'WebCrypto SHA-256 is unavailable');
  const bytes = buffer instanceof ArrayBuffer
    ? buffer
    : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function defaultLoadManifest(url) {
  const resolved = new URL(url, globalThis.location?.href ?? 'http://127.0.0.1/');
  const response = await fetch(resolved, { cache: 'no-store' });
  if (response.status === 404) throw new ModelPackProbeError('missing', 'The bundled OCR model manifest is missing');
  if (!response.ok) throw new ModelPackProbeError('missing', 'The bundled OCR model manifest is unavailable');
  try {
    return await response.json();
  } catch {
    throw new ModelPackProbeError('corrupt', 'The bundled OCR model manifest is invalid');
  }
}

async function defaultLoadAsset(baseUrl, record) {
  const base = new URL(baseUrl, globalThis.location?.href ?? 'http://127.0.0.1/');
  const response = await fetch(new URL(record.file, base), { cache: 'no-store' });
  if (response.status === 404) throw new ModelPackProbeError('missing', 'A bundled OCR model asset is missing');
  if (!response.ok) throw new ModelPackProbeError('missing', 'A bundled OCR model asset is unavailable');
  return response.arrayBuffer();
}

function currentApplicationVersion() {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null;
}

/**
 * Runtime state for the approved, bundled macOS core pack. Optional downloads
 * deliberately have no installer path in this phase.
 */
export class OcrModelPackState {
  constructor({
    manifestUrl = CORE_MACOS_MODEL_PACK_URL,
    assetBaseUrl = CORE_MACOS_MODEL_ASSET_BASE_URL,
    loadManifest = defaultLoadManifest,
    loadAsset = defaultLoadAsset,
    platform = 'macos',
    architecture = null,
    applicationVersion = currentApplicationVersion(),
  } = {}) {
    this.manifestUrl = manifestUrl;
    this.assetBaseUrl = assetBaseUrl;
    this.loadManifest = loadManifest;
    this.loadAsset = loadAsset;
    this.platform = platform;
    this.architecture = architecture;
    this.applicationVersion = applicationVersion;
    this.listeners = new Set();
    this.state = {
      status: 'missing',
      identity: null,
      manifest: null,
      supportedLanguages: [],
      supportedScripts: [],
      languageChoices: [],
      optionalDownloads: OPTIONAL_OCR_MODEL_PACKS,
      error: null,
      verifiedAt: null,
    };
    this.refreshPromise = null;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('OCR model-state listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(next) {
    this.state = next;
    const value = this.getState();
    for (const listener of this.listeners) {
      try { listener(value); } catch { /* observers cannot alter verification */ }
    }
    return value;
  }

  getState() {
    return snapshot(this.state);
  }

  async refresh({ force = false } = {}) {
    if (!force && this.state.status === 'installed') return this.getState();
    if (this.refreshPromise) return this.refreshPromise;
    this.publish({ ...this.state, status: 'updating', error: null });
    this.refreshPromise = this.verify().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async verify() {
    try {
      const manifest = assertOcrModelPackV1(await this.loadManifest(this.manifestUrl));
      const engine = createPaddleOcrEngineDescriptor(manifest);
      const compatibility = validateCompatibleOcrModelPack(manifest, engine, {
        platform: this.platform,
        architecture: this.architecture,
        applicationVersion: this.applicationVersion,
        trustedRootIds: [CORE_MACOS_MODEL_TRUST_ROOT],
        source: 'bundled',
      });
      if (!compatibility.ok) {
        return this.publish({
          ...this.state,
          status: 'incompatible',
          identity: null,
          manifest: null,
          supportedLanguages: [],
          supportedScripts: [],
          languageChoices: [],
          error: { code: 'OCR_MODEL_INCOMPATIBLE', retryable: false },
          verifiedAt: new Date().toISOString(),
        });
      }
      for (const record of Object.values(manifest.assets)) {
        let bytes = await this.loadAsset(this.assetBaseUrl, record);
        const byteLength = bytes?.byteLength;
        if (byteLength !== record.bytes) {
          throw new ModelPackProbeError('corrupt', 'A bundled OCR model asset has the wrong size');
        }
        const digest = await sha256Hex(bytes);
        bytes = null;
        if (digest !== record.sha256) {
          throw new ModelPackProbeError('corrupt', 'A bundled OCR model asset failed SHA-256 verification');
        }
      }
      return this.publish({
        status: 'installed',
        identity: modelPackIdentity(manifest),
        manifest: snapshot(manifest),
        supportedLanguages: [...manifest.recognitionSupport.languages],
        supportedScripts: [...manifest.recognitionSupport.scripts],
        // The approved pack is fixed-multilingual and has no selector. Keeping
        // this empty prevents a UI from offering choices the adapter rejects.
        languageChoices: [],
        optionalDownloads: OPTIONAL_OCR_MODEL_PACKS,
        error: null,
        verifiedAt: new Date().toISOString(),
      });
    } catch (error) {
      const externalKind = error && typeof error === 'object' && 'kind' in error
        ? error.kind
        : null;
      const kind = error instanceof ModelPackProbeError ? error.kind : externalKind;
      const status = kind === 'missing' ? 'missing' : 'corrupt';
      return this.publish({
        ...this.state,
        status,
        identity: null,
        manifest: null,
        supportedLanguages: [],
        supportedScripts: [],
        languageChoices: [],
        error: {
          code: status === 'missing' ? 'OCR_MODEL_MISSING' : 'OCR_MODEL_CORRUPT',
          retryable: status === 'missing',
        },
        verifiedAt: new Date().toISOString(),
      });
    }
  }

  async requireInstalled() {
    const state = await this.refresh();
    if (state.status !== 'installed' || !state.manifest) {
      throw Object.assign(new Error(`The bundled OCR model pack is ${state.status}`), {
        code: state.error?.code ?? 'OCR_MODEL_UNAVAILABLE',
        retryable: state.error?.retryable === true,
      });
    }
    return state;
  }

  async installOptionalPack() {
    throw Object.assign(new Error('Optional OCR model-pack downloads are disabled'), {
      code: 'OCR_OPTIONAL_MODEL_INSTALL_DISABLED',
      retryable: false,
    });
  }
}

let defaultModelState = null;

export function getDefaultOcrModelPackState() {
  if (!defaultModelState) defaultModelState = new OcrModelPackState();
  return defaultModelState;
}
