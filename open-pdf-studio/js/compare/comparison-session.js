let generation = 0;
const disposers = new Set();
export function comparisonGeneration() { return generation; }
export function onComparisonDispose(dispose) { disposers.add(dispose); return () => disposers.delete(dispose); }
export function disposeComparisonSession() {
  generation++;
  for (const dispose of disposers) { try { dispose(); } catch (error) { console.warn('Comparison cleanup failed', error); } }
}
