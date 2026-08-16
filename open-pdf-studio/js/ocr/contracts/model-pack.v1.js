import {
  OcrContractError,
  isObject,
  requireExactKeys,
  validateIdentifier,
  validateLanguageTag,
  validateSemver,
  validateString,
} from './validation.js';

export const OCR_MODEL_PACK_CONTRACT = 'open-pdf-studio.ocr.model-pack';
export const OCR_MODEL_PACK_SCHEMA_VERSION = 1;

const MODEL_COMPONENTS = ['detection', 'recognition'];
const MODEL_ASSETS = ['detection', 'recognition', 'dictionary'];

function validateHttpsUrl(value, path, issues) {
  const valid = validateString(value, path, issues, { nonEmpty: true, maxCodeUnits: 2048 });
  if (!valid) return;
  try {
    if (new URL(value).protocol !== 'https:') issues.push(`${path} must use https`);
  } catch {
    issues.push(`${path} must be an absolute URL`);
  }
}

function validateRuntime(runtime, path, issues) {
  if (!isObject(runtime)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(runtime, new Set(['name', 'version', 'executionProvider']), path, issues);
  for (const key of ['name', 'version', 'executionProvider']) {
    validateString(runtime[key], `${path}.${key}`, issues, { nonEmpty: true, maxCodeUnits: 128 });
  }
}

function validateUpstreamComponent(component, path, issues) {
  if (!isObject(component)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(component, new Set(['repository', 'revision', 'url']), path, issues);
  validateString(component.repository, `${path}.repository`, issues, { nonEmpty: true, maxCodeUnits: 256 });
  const revisionValid = validateString(component.revision, `${path}.revision`, issues, { nonEmpty: true, maxCodeUnits: 128 });
  if (revisionValid && !/^[0-9a-f]{40}$/.test(component.revision)) issues.push(`${path}.revision must be a full lowercase Git SHA`);
  validateHttpsUrl(component.url, `${path}.url`, issues);
}

function validateAsset(asset, path, issues) {
  if (!isObject(asset)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireExactKeys(asset, new Set(['file', 'bytes', 'sha256']), path, issues);
  const fileValid = validateString(asset.file, `${path}.file`, issues, { nonEmpty: true, maxCodeUnits: 512 });
  if (fileValid && (asset.file.startsWith('/') || asset.file.includes('\\') ||
      asset.file.split('/').some((part) => part === '..') || !/^[A-Za-z0-9._/-]+$/.test(asset.file))) {
    issues.push(`${path}.file must be a safe relative asset path`);
  }
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) issues.push(`${path}.bytes must be a positive safe integer`);
  const hashValid = validateString(asset.sha256, `${path}.sha256`, issues, { nonEmpty: true, maxCodeUnits: 64 });
  if (hashValid && !/^[0-9a-f]{64}$/.test(asset.sha256)) issues.push(`${path}.sha256 must be a lowercase SHA-256 digest`);
}

export function validateOcrModelPackV1(value) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['model pack must be an object'] };
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'packId', 'packVersion', 'platform',
    'engineCompatibility', 'modelFamily', 'modelTier', 'characterCount',
    'languages', 'license', 'upstream', 'assets',
  ]), 'modelPack', issues);
  if (value.contract !== OCR_MODEL_PACK_CONTRACT) issues.push(`contract must be ${OCR_MODEL_PACK_CONTRACT}`);
  if (value.schemaVersion !== OCR_MODEL_PACK_SCHEMA_VERSION) issues.push('schemaVersion must be 1');
  validateIdentifier(value.packId, 'packId', issues);
  validateSemver(value.packVersion, 'packVersion', issues);

  if (!isObject(value.platform)) {
    issues.push('platform must be an object');
  } else {
    requireExactKeys(value.platform, new Set(['os', 'architectures']), 'platform', issues);
    if (value.platform.os !== 'macos') issues.push('platform.os must be macos');
    if (!Array.isArray(value.platform.architectures) || value.platform.architectures.length === 0) {
      issues.push('platform.architectures must be a non-empty array');
    } else {
      const allowed = new Set(['arm64', 'x86_64']);
      const seen = new Set();
      value.platform.architectures.forEach((architecture, index) => {
        if (!allowed.has(architecture)) issues.push(`platform.architectures[${index}] is unsupported`);
        if (seen.has(architecture)) issues.push(`platform.architectures[${index}] must be unique`);
        seen.add(architecture);
      });
    }
  }

  if (!isObject(value.engineCompatibility)) {
    issues.push('engineCompatibility must be an object');
  } else {
    requireExactKeys(value.engineCompatibility, new Set([
      'engineId', 'adapterVersion', 'runtime', 'models',
    ]), 'engineCompatibility', issues);
    validateIdentifier(value.engineCompatibility.engineId, 'engineCompatibility.engineId', issues);
    validateSemver(value.engineCompatibility.adapterVersion, 'engineCompatibility.adapterVersion', issues);
    validateRuntime(value.engineCompatibility.runtime, 'engineCompatibility.runtime', issues);
    if (!isObject(value.engineCompatibility.models)) {
      issues.push('engineCompatibility.models must be an object');
    } else {
      requireExactKeys(value.engineCompatibility.models, new Set(MODEL_COMPONENTS), 'engineCompatibility.models', issues);
      for (const component of MODEL_COMPONENTS) {
        validateString(value.engineCompatibility.models[component], `engineCompatibility.models.${component}`, issues, {
          nonEmpty: true,
          maxCodeUnits: 256,
        });
      }
    }
  }

  validateString(value.modelFamily, 'modelFamily', issues, { nonEmpty: true, maxCodeUnits: 128 });
  validateString(value.modelTier, 'modelTier', issues, { nonEmpty: true, maxCodeUnits: 64 });
  if (!Number.isSafeInteger(value.characterCount) || value.characterCount <= 0) {
    issues.push('characterCount must be a positive safe integer');
  }
  if (!Array.isArray(value.languages) || value.languages.length === 0) {
    issues.push('languages must be a non-empty array');
  } else {
    const seen = new Set();
    value.languages.forEach((language, index) => {
      validateLanguageTag(language, `languages[${index}]`, issues);
      if (seen.has(language)) issues.push(`languages[${index}] must be unique`);
      seen.add(language);
    });
  }
  validateString(value.license, 'license', issues, { nonEmpty: true, maxCodeUnits: 128 });

  if (!isObject(value.upstream)) {
    issues.push('upstream must be an object');
  } else {
    requireExactKeys(value.upstream, new Set(MODEL_COMPONENTS), 'upstream', issues);
    for (const component of MODEL_COMPONENTS) {
      validateUpstreamComponent(value.upstream[component], `upstream.${component}`, issues);
    }
  }

  if (!isObject(value.assets)) {
    issues.push('assets must be an object');
  } else {
    requireExactKeys(value.assets, new Set(MODEL_ASSETS), 'assets', issues);
    const files = new Set();
    for (const assetName of MODEL_ASSETS) {
      validateAsset(value.assets[assetName], `assets.${assetName}`, issues);
      const file = value.assets[assetName]?.file;
      if (typeof file === 'string' && files.has(file)) issues.push(`assets.${assetName}.file must be unique`);
      files.add(file);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function assertOcrModelPackV1(value) {
  const validation = validateOcrModelPackV1(value);
  if (!validation.ok) throw new OcrContractError(OCR_MODEL_PACK_CONTRACT, validation.issues);
  return value;
}

function normalizedPlatform(platform) {
  return platform === 'darwin' ? 'macos' : platform;
}

function normalizedArchitecture(architecture) {
  if (architecture === 'x64') return 'x86_64';
  if (architecture === 'aarch64') return 'arm64';
  return architecture;
}

export function validateCompatibleOcrModelPack(value, engine, {
  platform = 'macos',
  architecture = null,
} = {}) {
  const validation = validateOcrModelPackV1(value);
  const issues = [...validation.issues];
  if (!validation.ok || !isObject(engine)) {
    if (!isObject(engine)) issues.push('engine must be an object');
    return { ok: issues.length === 0, issues };
  }
  const compatibility = value.engineCompatibility;
  if (compatibility.engineId !== engine.engineId) issues.push('model pack engineId is incompatible with the OCR engine');
  if (compatibility.adapterVersion !== engine.adapterVersion) issues.push('model pack adapterVersion is incompatible with the OCR engine');
  for (const key of ['name', 'version', 'executionProvider']) {
    if (compatibility.runtime[key] !== engine.runtime?.[key]) {
      issues.push(`model pack runtime.${key} is incompatible with the OCR engine`);
    }
  }
  if (value.modelFamily !== engine.model?.family || value.modelTier !== engine.model?.tier) {
    issues.push('model pack family or tier is incompatible with the OCR engine');
  }
  for (const component of MODEL_COMPONENTS) {
    if (compatibility.models[component] !== engine.model?.[component]) {
      issues.push(`model pack ${component} model is incompatible with the OCR engine`);
    }
  }
  if (value.platform.os !== normalizedPlatform(platform)) issues.push(`model pack does not support platform ${platform}`);
  const normalizedArch = normalizedArchitecture(architecture);
  if (normalizedArch && !value.platform.architectures.includes(normalizedArch)) {
    issues.push(`model pack does not support architecture ${architecture}`);
  }
  return { ok: issues.length === 0, issues };
}

export function assertCompatibleOcrModelPack(value, engine, options) {
  const validation = validateCompatibleOcrModelPack(value, engine, options);
  if (!validation.ok) throw new OcrContractError(OCR_MODEL_PACK_CONTRACT, validation.issues);
  return value;
}

export function modelPackIdentity(value) {
  assertOcrModelPackV1(value);
  return {
    contract: OCR_MODEL_PACK_CONTRACT,
    schemaVersion: OCR_MODEL_PACK_SCHEMA_VERSION,
    packId: value.packId,
    packVersion: value.packVersion,
  };
}
