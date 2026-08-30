const suspensions = new WeakMap();
const listeners = new Set();

export function acquireWholePdfPreloadSuspension(
  doc,
  { reason = 'foreground-work' } = {},
) {
  if (!doc) return () => {};
  const token = Symbol(reason);
  let owners = suspensions.get(doc);
  if (!owners) {
    owners = new Set();
    suspensions.set(doc, owners);
  }
  owners.add(token);
  for (const listener of listeners) listener(doc, reason);
  let released = false;
  return () => {
    if (released) return false;
    released = true;
    const current = suspensions.get(doc);
    if (!current?.delete(token)) return false;
    if (current.size === 0) suspensions.delete(doc);
    return true;
  };
}

export function wholePdfPreloadIsSuspended(doc) {
  return Boolean(doc && suspensions.has(doc));
}

export function registerWholePdfPreloadSuspensionListener(listener) {
  if (typeof listener !== 'function') throw new TypeError('Preload suspension listener must be a function');
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function wholePdfPreloadSuspensionSnapshotForTests(doc) {
  return Object.freeze({ owners: suspensions.get(doc)?.size || 0 });
}
