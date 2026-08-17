import { toValidatedOcrResultV2Json } from './contracts/v2.js';
import { createOcrEngine } from './engine.js';

/** Run one production recognition job inside the current disposable process. */
export async function runOcrJob({
  image,
  job,
  rasterMs = 0,
  engineFactory = createOcrEngine,
  onLifecycle = null,
}) {
  const engine = engineFactory({ onLifecycle });
  try {
    const result = await engine.recognize({ image, job, rasterMs });
    return toValidatedOcrResultV2Json(result);
  } finally {
    if (image) image.rgba = null;
    onLifecycle?.({
      stage: 'immediately-before-engine-disposal',
      atEpochMs: Date.now(),
      livePageBufferReferences: 0,
    });
    await engine.dispose();
    onLifecycle?.({
      stage: 'after-engine-disposal-complete',
      atEpochMs: Date.now(),
      livePageBufferReferences: 0,
    });
  }
}
