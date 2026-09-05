import { diffPageTextsForPresentation } from './text-diff.js';
self.onmessage = ({ data }) => {
  try { self.postMessage({ id: data.id, changes: diffPageTextsForPresentation(data.oldPages, data.newPages) }); }
  catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
