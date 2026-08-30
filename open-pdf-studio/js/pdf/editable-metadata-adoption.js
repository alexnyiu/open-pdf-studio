/** Rebind a settled metadata controller to a validated replacement proxy. */
export function adoptEditableMetadataController(record, {
  revisionIdentity,
  changedPages = [],
  load,
} = {}) {
  if (!record?.controller || !revisionIdentity || typeof load !== 'function') return false;
  const changed = new Set((changedPages || []).map(Number));
  const controller = record.controller;
  controller.generation += 1;
  controller.promises.clear();
  for (const pageNum of changed) controller.delete(pageNum);
  for (const [pageNum, entry] of controller.entries) {
    const value = entry?.value;
    if (!value || changed.has(pageNum)) continue;
    controller.entries.set(pageNum, {
      ...entry,
      value: { ...value, revisionIdentity },
    });
  }
  record.revisionIdentity = revisionIdentity;
  controller.load = load;
  return true;
}
