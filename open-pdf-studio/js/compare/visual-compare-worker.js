import { detectChanges } from './change-detector.js';
self.onmessage = ({ data }) => {
  try { self.postMessage({ id: data.id, changes: detectChanges(data.oldData, data.newData) }); }
  catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
