/** Read the current system preference so changes apply without restarting. */
export function preferredScrollBehavior() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
