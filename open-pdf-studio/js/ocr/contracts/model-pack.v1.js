import {
  OcrContractError,
  isObject,
  requireExactKeys,
  validateIdentifier,
  validateJsonValue,
  validateLanguageTag,
  validateSemver,
  validateSerializedSize,
  validateString,
} from './validation.js';

export const OCR_MODEL_PACK_CONTRACT = 'open-pdf-studio.ocr.model-pack';
export const OCR_MODEL_PACK_SCHEMA_VERSION = 1;
export const OCR_MODEL_ASSET_NAMES = Object.freeze(['detection', 'recognition', 'dictionary']);

const MODEL_COMPONENTS = ['detection', 'recognition'];
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x86_64']);
const SCRIPT_PATTERN = /^[A-Z][a-z]{3}$/;

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
  const revisionValid = validateString(component.revision, `${path}.revision`, issues, {
    nonEmpty: true,
    maxCodeUnits: 128,
  });
  if (revisionValid && !/^[0-9a-f]{40}$/.test(component.revision)) {
    issues.push(`${path}.revision must be a full lowercase Git SHA`);
  }
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
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
    issues.push(`${path}.bytes must be a positive safe integer`);
  }
  const hashValid = validateString(asset.sha256, `${path}.sha256`, issues, { nonEmpty: true, maxCodeUnits: 64 });
  if (hashValid && !/^[0-9a-f]{64}$/.test(asset.sha256)) {
    issues.push(`${path}.sha256 must be a lowercase SHA-256 digest`);
  }
}

function validateRecognitionSupport(value, issues) {
  if (!isObject(value)) {
    issues.push('recognitionSupport must be an object');
    return;
  }
  requireExactKeys(value, new Set(['selectionMode', 'languageSelector', 'languages', 'scripts']), 'recognitionSupport', issues);
  if (value.selectionMode !== 'fixed-multilingual') {
    issues.push('recognitionSupport.selectionMode must be fixed-multilingual');
  }
  if (value.languageSelector !== 'none') {
    issues.push('recognitionSupport.languageSelector must be none');
  }
  if (!Array.isArray(value.languages) || value.languages.length === 0) {
    issues.push('recognitionSupport.languages must be a non-empty array');
  } else {
    const seen = new Set();
    value.languages.forEach((language, index) => {
      validateLanguageTag(language, `recognitionSupport.languages[${index}]`, issues);
      if (language === 'und') issues.push(`recognitionSupport.languages[${index}] must name an actual supported language`);
      if (seen.has(language)) issues.push(`recognitionSupport.languages[${index}] must be unique`);
      seen.add(language);
    });
  }
  if (!Array.isArray(value.scripts) || value.scripts.length === 0) {
    issues.push('recognitionSupport.scripts must be a non-empty array');
  } else {
    const seen = new Set();
    value.scripts.forEach((script, index) => {
      const valid = validateString(script, `recognitionSupport.scripts[${index}]`, issues, {
        nonEmpty: true,
        maxCodeUnits: 4,
      });
      if (valid && !SCRIPT_PATTERN.test(script)) {
        issues.push(`recognitionSupport.scripts[${index}] must be an ISO 15924 code`);
      }
      if (seen.has(script)) issues.push(`recognitionSupport.scripts[${index}] must be unique`);
      seen.add(script);
    });
  }
}

function validateDistribution(value, issues) {
  if (!isObject(value)) {
    issues.push('distribution must be an object');
    return;
  }
  requireExactKeys(value, new Set(['bundled', 'downloadable']), 'distribution', issues);
  if (typeof value.bundled !== 'boolean') issues.push('distribution.bundled must be boolean');
  if (typeof value.downloadable !== 'boolean') issues.push('distribution.downloadable must be boolean');
  if (value.bundled === false && value.downloadable === false) {
    issues.push('distribution must permit a bundled or downloadable source');
  }
}

function validateTrust(value, issues) {
  if (!isObject(value)) {
    issues.push('trust must be an object');
    return;
  }
  requireExactKeys(value, new Set(['integrity', 'trustRootId']), 'trust', issues);
  if (value.integrity !== 'sha256') issues.push('trust.integrity must be sha256');
  validateIdentifier(value.trustRootId, 'trust.trustRootId', issues);
}

function validateApplicationCompatibility(value, issues) {
  if (!isObject(value)) {
    issues.push('applicationCompatibility must be an object');
    return;
  }
  requireExactKeys(value, new Set(['minimumVersion', 'maximumVersionExclusive']), 'applicationCompatibility', issues);
  validateSemver(value.minimumVersion, 'applicationCompatibility.minimumVersion', issues);
  if (value.maximumVersionExclusive !== null) {
    validateSemver(value.maximumVersionExclusive, 'applicationCompatibility.maximumVersionExclusive', issues);
  }
  if (typeof value.minimumVersion === 'string' && typeof value.maximumVersionExclusive === 'string' &&
      compareSemver(value.minimumVersion, value.maximumVersionExclusive) >= 0) {
    issues.push('applicationCompatibility.maximumVersionExclusive must be greater than minimumVersion');
  }
}

export function validateOcrModelPackV1(value) {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: ['model pack must be an object'] };
  validateJsonValue(value, 'modelPack', issues);
  if (!validateSerializedSize(value, 'modelPack', issues, 1024 * 1024)) return { ok: false, issues };
  requireExactKeys(value, new Set([
    'contract', 'schemaVersion', 'packId', 'packVersion', 'platform',
    'engineCompatibility', 'modelFamily', 'modelTier', 'characterCount',
    'recognitionSupport', 'distribution', 'trust', 'applicationCompatibility',
    'license', 'upstream', 'assets',
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
      const seen = new Set();
      value.platform.architectures.forEach((architecture, index) => {
        if (!SUPPORTED_ARCHITECTURES.has(architecture)) issues.push(`platform.architectures[${index}] is unsupported`);
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
  validateRecognitionSupport(value.recognitionSupport, issues);
  validateDistribution(value.distribution, issues);
  validateTrust(value.trust, issues);
  validateApplicationCompatibility(value.applicationCompatibility, issues);
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
    requireExactKeys(value.assets, new Set(OCR_MODEL_ASSET_NAMES), 'assets', issues);
    const files = new Set();
    for (const assetName of OCR_MODEL_ASSET_NAMES) {
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

function semverParts(value) {
  const [core, prerelease = ''] = value.split('-', 2);
  return { numbers: core.split('.').map(Number), prerelease };
}

export function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

export function validateCompatibleOcrModelPack(value, engine, {
  platform = 'macos',
  architecture = null,
  applicationVersion = null,
  trustedRootIds = null,
  source = null,
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
  if (applicationVersion !== null) {
    const versionIssues = [];
    validateSemver(applicationVersion, 'applicationVersion', versionIssues);
    issues.push(...versionIssues);
    if (versionIssues.length === 0) {
      if (compareSemver(applicationVersion, value.applicationCompatibility.minimumVersion) < 0) {
        issues.push(`model pack requires application version ${value.applicationCompatibility.minimumVersion} or newer`);
      }
      const maximum = value.applicationCompatibility.maximumVersionExclusive;
      if (maximum !== null && compareSemver(applicationVersion, maximum) >= 0) {
        issues.push(`model pack requires an application version earlier than ${maximum}`);
      }
    }
  }
  if (trustedRootIds !== null) {
    const roots = trustedRootIds instanceof Set ? trustedRootIds : new Set(trustedRootIds);
    if (!roots.has(value.trust.trustRootId)) issues.push('model pack trust root is not trusted by this application');
  }
  if (source === 'bundled' && value.distribution.bundled !== true) issues.push('model pack is not approved as a bundled pack');
  if (source === 'download' && value.distribution.downloadable !== true) issues.push('model pack is not approved for download');
  if (source !== null && !['bundled', 'download'].includes(source)) issues.push('model pack source is unsupported');
  return { ok: issues.length === 0, issues };
}

export function assertCompatibleOcrModelPack(value, engine, options) {
  const validation = validateCompatibleOcrModelPack(value, engine, options);
  if (!validation.ok) throw new OcrContractError(OCR_MODEL_PACK_CONTRACT, validation.issues);
  return value;
}

export function validateInstallableOcrModelPack(value, engine, options = {}) {
  const issues = [];
  if (!options.applicationVersion) issues.push('applicationVersion is required to decide installation safety');
  if (!options.architecture) issues.push('architecture is required to decide installation safety');
  if (!options.source) issues.push('source is required to decide installation safety');
  if (!options.trustedRootIds) issues.push('trustedRootIds is required to decide installation safety');
  if (issues.length > 0) return { ok: false, issues };
  return validateCompatibleOcrModelPack(value, engine, options);
}

export function assertInstallableOcrModelPack(value, engine, options) {
  const validation = validateInstallableOcrModelPack(value, engine, options);
  if (!validation.ok) throw new OcrContractError(OCR_MODEL_PACK_CONTRACT, validation.issues);
  return value;
}

export function validateOcrModelPackIdentity(value, path = 'modelPack') {
  const issues = [];
  if (!isObject(value)) return { ok: false, issues: [`${path} must be an object`] };
  requireExactKeys(value, new Set(['contract', 'schemaVersion', 'packId', 'packVersion', 'assets']), path, issues);
  if (value.contract !== OCR_MODEL_PACK_CONTRACT) issues.push(`${path}.contract must be ${OCR_MODEL_PACK_CONTRACT}`);
  if (value.schemaVersion !== OCR_MODEL_PACK_SCHEMA_VERSION) issues.push(`${path}.schemaVersion must be 1`);
  validateIdentifier(value.packId, `${path}.packId`, issues);
  validateSemver(value.packVersion, `${path}.packVersion`, issues);
  if (!isObject(value.assets)) {
    issues.push(`${path}.assets must be an object`);
  } else {
    requireExactKeys(value.assets, new Set(OCR_MODEL_ASSET_NAMES), `${path}.assets`, issues);
    for (const name of OCR_MODEL_ASSET_NAMES) {
      const valid = validateString(value.assets[name], `${path}.assets.${name}`, issues, {
        nonEmpty: true,
        maxCodeUnits: 64,
      });
      if (valid && !/^[0-9a-f]{64}$/.test(value.assets[name])) {
        issues.push(`${path}.assets.${name} must be a lowercase SHA-256 digest`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

export function modelPackIdentity(value) {
  assertOcrModelPackV1(value);
  return {
    contract: OCR_MODEL_PACK_CONTRACT,
    schemaVersion: OCR_MODEL_PACK_SCHEMA_VERSION,
    packId: value.packId,
    packVersion: value.packVersion,
    assets: Object.fromEntries(OCR_MODEL_ASSET_NAMES.map((name) => [name, value.assets[name].sha256])),
  };
}
