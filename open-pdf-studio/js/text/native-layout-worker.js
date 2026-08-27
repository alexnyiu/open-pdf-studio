import { layoutExpandableNativeText } from './native-expandable-layout.js';

let latestRequestId = 0;

self.addEventListener('message', async (event) => {
  const message = event.data || {};
  if (message.type === 'cancel') {
    latestRequestId = Math.max(latestRequestId, Number(message.requestId) + 1 || latestRequestId + 1);
    return;
  }
  if (message.type !== 'layout') return;
  const requestId = Number(message.requestId);
  latestRequestId = requestId;
  try {
    const result = await layoutExpandableNativeText(message.document, {
      ...message.options,
      shouldCancel: () => latestRequestId !== requestId,
      yieldEvery: 256,
    });
    if (latestRequestId !== requestId) {
      self.postMessage({ type: 'cancelled', requestId });
      return;
    }
    self.postMessage({ type: 'result', requestId, fingerprint: message.fingerprint, result });
  } catch (error) {
    if (latestRequestId !== requestId || error?.code === 'TEXT_LAYOUT_CANCELLED') {
      self.postMessage({ type: 'cancelled', requestId });
      return;
    }
    self.postMessage({
      type: 'error',
      requestId,
      fingerprint: message.fingerprint,
      error: { message: error instanceof Error ? error.message : String(error), code: error?.code || null },
    });
  }
});
