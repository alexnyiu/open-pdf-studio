// Stable keys keep a viewport anchor meaningful after filtering or regrouping.
export function createListGeometry(items, keyFor, heightFor) {
  const offsets = [0];
  const keys = [];
  const indices = new Map();
  items.forEach((item, index) => {
    const key = String(keyFor(item));
    keys.push(key);
    indices.set(key, index);
    offsets.push(offsets[index] + Math.max(1, Number(heightFor(item, key)) || 48));
  });
  const indexAt = value => {
    let low = 0, high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (offsets[middle + 1] <= value) low = middle + 1;
      else high = middle;
    }
    return Math.min(Math.max(0, items.length - 1), low);
  };
  return { items, keys, indices, offsets, indexAt, totalHeight: offsets.at(-1) };
}

export function preserveListAnchor(previous, next, scrollTop) {
  if (!previous?.keys.length || !next.keys.length) return 0;
  const oldIndex = previous.indexAt(scrollTop);
  const index = next.indices.get(previous.keys[oldIndex]) ?? Math.min(oldIndex, next.keys.length - 1);
  const withinRow = Math.max(0, scrollTop - previous.offsets[oldIndex]);
  return next.offsets[index] + Math.min(withinRow, next.offsets[index + 1] - next.offsets[index] - 1);
}
