// @ts-check

/** @param {unknown} left @param {unknown} right */
function sameSavePath(left, right) {
  if (!left || !right) return false;
  return String(left).normalize('NFC') === String(right).normalize('NFC');
}

/** @param {{signed:boolean,pdfa:boolean}} input */
export function pdfModificationWarning({ signed, pdfa }) {
  const warnings = [];
  if (signed) warnings.push('This PDF contains digital signatures. Any modification invalidates those signatures in the modified copy.');
  if (pdfa) warnings.push('This PDF is PDF/A. Open PDF Studio cannot certify that edited output still conforms, so the modified copy is converted to a standard PDF.');
  if (warnings.length) warnings.push('Use Save As to preserve the original file.');
  return warnings.join('\n\n');
}

/**
 * Determines the fail-closed save policy before any PDF mutation occurs.
 * @param {{signed:boolean,pdfa:boolean,currentPath?:string|null,outputPath?:string|null,saveAsPath?:string|null}} input
 */
export function evaluatePdfModificationSavePolicy(input) {
  const protectedOriginal = input.signed === true || input.pdfa === true;
  return Object.freeze({
    protectedOriginal,
    forceSaveAs: protectedOriginal && !input.saveAsPath,
    rejectOriginalPath: protectedOriginal
      && Boolean(input.saveAsPath)
      && sameSavePath(input.outputPath, input.currentPath),
    warning: protectedOriginal
      ? pdfModificationWarning({ signed: input.signed === true, pdfa: input.pdfa === true })
      : '',
  });
}
