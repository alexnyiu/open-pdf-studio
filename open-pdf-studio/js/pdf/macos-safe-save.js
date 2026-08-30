// @ts-check

import { invoke, isTauri, writeBinaryFile } from '../core/platform.js';

const NATIVE_ERROR_PREFIX = 'OPDS_SAFE_SAVE|';
const stagedProviderByToken = new Map();

const ERROR_RECOVERY = Object.freeze({
  ICLOUD_PROVIDER_BUSY: Object.freeze({ providerKind: 'icloud', retryable: true, recoveryAction: 'retry-save' }),
  FILE_PROVIDER_BUSY: Object.freeze({ providerKind: 'file-provider', retryable: true, recoveryAction: 'retry-save' }),
  PROVIDER_UNAVAILABLE: Object.freeze({ retryable: true, recoveryAction: 'retry-when-provider-online' }),
  PROVIDER_NOT_MATERIALIZED: Object.freeze({ retryable: false, recoveryAction: 'download-provider-file' }),
  PROVIDER_AUTHENTICATION_REQUIRED: Object.freeze({ retryable: false, recoveryAction: 'open-provider-settings' }),
  SECURITY_SCOPED_ACCESS_REQUIRED: Object.freeze({ retryable: false, recoveryAction: 'reselect-destination' }),
  DESTINATION_CHANGED: Object.freeze({ retryable: false, recoveryAction: 'review-provider-conflict' }),
  READ_ONLY_DESTINATION: Object.freeze({ retryable: false, recoveryAction: 'save-as' }),
  OUT_OF_DISK_SPACE: Object.freeze({ retryable: false, recoveryAction: 'free-provider-space' }),
});

function recoveryMetadata(code, overrides = {}) {
  const defaults = ERROR_RECOVERY[code] || {};
  const providerKind = overrides.providerKind || defaults.providerKind || null;
  const retryable = typeof overrides.retryable === 'boolean'
    ? overrides.retryable : typeof defaults.retryable === 'boolean' ? defaults.retryable : false;
  const recoveryAction = overrides.recoveryAction || defaults.recoveryAction || 'save-as';
  return Object.freeze({ providerKind, retryable, recoveryAction });
}

export class MacosSafeSaveError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] @param {{providerKind?:string|null,retryable?:boolean,recoveryAction?:string}} [metadata] */
  constructor(code, message, cause, metadata = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MacosSafeSaveError';
    this.code = code;
    this.recovery = recoveryMetadata(code, metadata);
    this.providerKind = this.recovery.providerKind;
    this.retryable = this.recovery.retryable;
    this.recoveryAction = this.recovery.recoveryAction;
  }
}

/** @param {unknown} error @param {string} fallbackCode @param {{providerKind?:string|null}} [context] */
export function nativeError(error, fallbackCode = 'SAFE_SAVE_FAILED', context = {}) {
  if (error instanceof MacosSafeSaveError) return error;
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String(error);
  const offset = message.indexOf(NATIVE_ERROR_PREFIX);
  if (offset >= 0) {
    const [, code, nativeMessage, providerKind, retryable, recoveryAction] = message.slice(offset).split('|');
    return new MacosSafeSaveError(code || fallbackCode, nativeMessage || message, error, {
      providerKind: providerKind || context.providerKind || null,
      retryable: retryable === 'true' ? true : retryable === 'false' ? false : undefined,
      recoveryAction: recoveryAction || undefined,
    });
  }
  if (/no space|disk.*full|quota/iu.test(message)) {
    return new MacosSafeSaveError('OUT_OF_DISK_SPACE', 'The destination volume does not have enough free space for a safe PDF save', error, context);
  }
  if (/read.?only/iu.test(message)) {
    return new MacosSafeSaveError('READ_ONLY_DESTINATION', 'The destination or volume is read-only', error, context);
  }
  if (/permission|denied|operation not permitted/iu.test(message)) {
    return new MacosSafeSaveError(
      'SECURITY_SCOPED_ACCESS_REQUIRED',
      'macOS no longer grants access to this file. Choose it again with Save As.',
      error,
      context,
    );
  }
  return new MacosSafeSaveError(fallbackCode, message, error, context);
}

/** @param {Uint8Array} value */
async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new MacosSafeSaveError('SHA256_UNAVAILABLE', 'Web Crypto SHA-256 is required for safe save');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', /** @type {BufferSource} */ (value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Creates private same-volume files and writes bytes through Tauri's binary FS
 * IPC. The destination is not changed by this step.
 * @param {{destinationPath:string,protectedOriginalPath?:string|null,candidateBytes:Uint8Array,validationBaselineBytes?:Uint8Array|null}} input
 */
export async function stageMacosSafePdfSave(input) {
  if (!isTauri()) throw new MacosSafeSaveError('MACOS_TAURI_REQUIRED', 'Production safe PDF saving requires the packaged macOS app');
  const candidateBytes = input.candidateBytes;
  const validationBaselineBytes = input.validationBaselineBytes || null;
  let prepared;
  try {
    await invoke('allow_fs_scope', { path: input.destinationPath });
    prepared = await invoke('begin_macos_safe_pdf_save', {
      destinationPath: input.destinationPath,
      protectedOriginalPath: input.protectedOriginalPath || null,
      candidateSha256: await sha256(candidateBytes),
      candidateLength: candidateBytes.byteLength,
      validationBaselineSha256: validationBaselineBytes ? await sha256(validationBaselineBytes) : null,
      validationBaselineLength: validationBaselineBytes?.byteLength ?? null,
    });
    await writeBinaryFile(prepared.candidatePath, candidateBytes);
    if (validationBaselineBytes) {
      if (!prepared.validationBaselinePath) {
        throw new MacosSafeSaveError('VALIDATION_BASELINE_MISSING', 'Native safe save did not allocate the PDFium validation baseline');
      }
      await writeBinaryFile(prepared.validationBaselinePath, validationBaselineBytes);
    }
    if (prepared?.token) stagedProviderByToken.set(prepared.token, prepared.provider || null);
    return prepared;
  } catch (error) {
    if (prepared?.token) {
      try { await invoke('abort_macos_safe_pdf_save', { token: prepared.token }); } catch (_) {}
    }
    throw nativeError(error, 'SAFE_SAVE_STAGING_FAILED');
  }
}

/** @param {string} token @param {number[]} selectedPageIndexes @param {Array<any>} [allowedRegions] */
export async function validateStagedOcrPdfWithPdfium(token, selectedPageIndexes, allowedRegions = []) {
  try {
    return await invoke('validate_macos_ocr_pdf_candidate', {
      token,
      selectedPageIndexes,
      allowedRegions,
    });
  } catch (error) {
    throw nativeError(error, 'PDFIUM_VALIDATION_FAILED');
  }
}

/** @param {string} token */
export async function finalizeMacosSafePdfSave(token) {
  const provider = stagedProviderByToken.get(token) || null;
  try {
    return await invoke('finalize_macos_safe_pdf_save', { token });
  } catch (error) {
    throw nativeError(error, 'ATOMIC_REPLACE_FAILED', {
      providerKind: provider?.providerKind || null,
    });
  } finally {
    stagedProviderByToken.delete(token);
  }
}

export async function listPendingMacosSafeSaveCleanups() {
  if (!isTauri()) return [];
  try {
    const records = await invoke('list_macos_safe_save_cleanup_records');
    return Array.isArray(records) ? records : [];
  } catch (error) {
    throw nativeError(error, 'CLEANUP_RECORD_LIST_FAILED');
  }
}

/** Retry only deletion of the recorded private recovery file. */
export async function retryPendingMacosSafeSaveCleanup(recoveryPath) {
  if (!isTauri()) {
    throw new MacosSafeSaveError(
      'MACOS_TAURI_REQUIRED',
      'Safe-save cleanup recovery requires the packaged macOS app',
    );
  }
  try {
    return await invoke('retry_macos_safe_save_cleanup', { recoveryPath });
  } catch (error) {
    throw nativeError(error, 'CLEANUP_RETRY_FAILED');
  }
}

/** @param {string|null|undefined} token */
export async function abortMacosSafePdfSave(token) {
  if (!token) return;
  try {
    await invoke('abort_macos_safe_pdf_save', { token });
  } catch (_) {
  } finally {
    stagedProviderByToken.delete(token);
  }
}
