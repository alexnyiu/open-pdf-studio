export const SAVE_FAULT_STAGES = Object.freeze([
  'after-owner-commit-before-publication',
  'before-visible-publication',
  'after-serialization-before-persistence',
  'after-persistence-before-proxy-adoption',
  'before-proxy-install',
  'after-proxy-install-before-view-restore',
  'before-view-restore',
  'before-required-page-recompute',
  'before-final-text-layout-ack',
  'drop-latest-text-layout-result',
  'metadata-copy-warning',
  'old-file-cleanup-warning',
  // Compatibility stages retained while the phase-specific boundaries above
  // replace the original coarse save fault hooks.
  'serialization',
  'persistence',
  'proxy-install',
  'render-readiness',
]);

const armedFaults = new Map();

function assertStage(stage) {
  const normalized = String(stage || '');
  if (!SAVE_FAULT_STAGES.includes(normalized)) {
    throw new RangeError(`Unsupported save fault stage: ${normalized}`);
  }
  return normalized;
}

/** Test-only: arm deterministic failures without adding a production UI path. */
export function configureSaveFaultInjectionForTests(stage, {
  times = 1,
  message = null,
} = {}) {
  const normalized = assertStage(stage);
  const remaining = Math.max(0, Number(times) || 0);
  if (remaining === 0) {
    armedFaults.delete(normalized);
    return false;
  }
  armedFaults.set(normalized, {
    remaining,
    message: message || `Injected ${normalized} save failure`,
  });
  return true;
}

export function clearSaveFaultInjectionsForTests() {
  armedFaults.clear();
}

export function throwIfSaveFaultInjected(stage) {
  const normalized = assertStage(stage);
  const fault = armedFaults.get(normalized);
  if (!fault) return false;
  fault.remaining -= 1;
  if (fault.remaining <= 0) armedFaults.delete(normalized);
  const error = new Error(fault.message);
  error.name = 'SaveFaultInjectionError';
  error.code = `SAVE_FAULT_${normalized.toUpperCase().replaceAll('-', '_')}`;
  error.stage = normalized;
  throw error;
}
