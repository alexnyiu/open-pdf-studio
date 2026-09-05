/** Serial loading with immutable ownership and selected-pending-tab priority. */
export function createDocumentOpenQueue({ resolve, active, load, onError = () => {} }) {
  const pending = [];
  let draining = null;
  async function drain() {
    while (pending.length) {
      const selected = pending.findIndex(job => job.id === active()?.id);
      const [job] = pending.splice(selected < 0 ? 0 : selected, 1);
      const owner = resolve(job.id);
      if (!owner || owner.id !== job.id
          || (Number(owner.lifecycleGeneration) || 0) !== job.generation) continue;
      try { await load(job.path, owner); } catch (error) { try { onError(error, job.path); } catch (reportError) { console.error(reportError); } }
    }
    draining = null;
  }
  return {
    remove(documentId) {
      let removed = 0;
      for (let index = pending.length - 1; index >= 0; index--) {
        if (pending[index].id !== documentId) continue;
        pending.splice(index, 1);
        removed++;
      }
      return removed;
    },
    get pendingCount() { return pending.length; },
    enqueue(jobs) {
      for (const { path, document } of jobs) {
        if (!document || pending.some(job => job.id === document.id)) continue;
        pending.push({ path, id: document.id, generation: Number(document.lifecycleGeneration) || 0 });
      }
      if (!draining) draining = Promise.resolve().then(drain);
      return draining;
    },
  };
}
