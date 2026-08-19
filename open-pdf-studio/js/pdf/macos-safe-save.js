// @ts-check

import { invoke, isTauri, writeBinaryFile } from '../core/platform.js';

const NATIVE_ERROR_PREFIX = 'OPDS_SAFE_SAVE|';

export class MacosSafeSaveError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MacosSafeSaveError';
    this.code = code;
  }
}

/** @param {unknown} error @param {string} fallbackCode */
function nativeError(error, fallbackCode = 'SAFE_SAVE_FAILED') {
  if (error instanceof MacosSafeSaveError) return error;
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String(error);
  const offset = message.indexOf(NATIVE_ERROR_PREFIX);
  if (offset >= 0) {
    const [, code, ...parts] = message.slice(offset).split('|');
    return new MacosSafeSaveError(code || fallbackCode, parts.join('|') || message, error);
  }
  if (/no space|disk.*full|quota/iu.test(message)) {
    return new MacosSafeSaveError('OUT_OF_DISK_SPACE', 'The destination volume does not have enough free space for a safe PDF save', error);
  }
  if (/read.?only/iu.test(message)) {
    return new MacosSafeSaveError('READ_ONLY_DESTINATION', 'The destination or volume is read-only', error);
  }
  if (/permission|denied|operation not permitted/iu.test(message)) {
    return new MacosSafeSaveError(
      'SECURITY_SCOPED_ACCESS_REQUIRED',
      'macOS no longer grants access to this file. Choose it again with Save As.',
      error,
    );
  }
  return new MacosSafeSaveError(fallbackCode, message, error);
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
    return prepared;
  } catch (error) {
    if (prepared?.token) {
      try { await invoke('abort_macos_safe_pdf_save', { token: prepared.token }); } catch (_) {}
    }
    throw nativeError(error, 'SAFE_SAVE_STAGING_FAILED');
  }
}

/** @param {string} token @param {number[]} selectedPageIndexes */
export async function validateStagedOcrPdfWithPdfium(token, selectedPageIndexes) {
  try {
    return await invoke('validate_macos_ocr_pdf_candidate', { token, selectedPageIndexes });
  } catch (error) {
    throw nativeError(error, 'PDFIUM_VALIDATION_FAILED');
  }
}

/** @param {string} token */
export async function finalizeMacosSafePdfSave(token) {
  try {
    return await invoke('finalize_macos_safe_pdf_save', { token });
  } catch (error) {
    throw nativeError(error, 'ATOMIC_REPLACE_FAILED');
  }
}

/** @param {string|null|undefined} token */
export async function abortMacosSafePdfSave(token) {
  if (!token) return;
  try {
    await invoke('abort_macos_safe_pdf_save', { token });
  } catch (_) {}
}
