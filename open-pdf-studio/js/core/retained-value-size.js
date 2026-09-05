/** Conservative retained-size estimate; not an engine heap measurement.
 * Shared objects/backing buffers count once. Typed buffers are never traversed.
 */
export function estimateRetainedBytes(value) {
  const seen = new WeakSet();
  const pending = [value];
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') { bytes += current.length * 2; continue; }
    if (typeof current === 'number' || typeof current === 'bigint') { bytes += 8; continue; }
    if (typeof current === 'boolean') { bytes += 4; continue; }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && current instanceof SharedArrayBuffer)) {
      bytes += current.byteLength; continue;
    }
    if (ArrayBuffer.isView(current)) { bytes += 32; pending.push(current.buffer); continue; }
    bytes += 32;
    if (current instanceof Map) {
      for (const [key, entry] of current) { bytes += 16; pending.push(key, entry); }
    } else if (current instanceof Set) {
      for (const entry of current) { bytes += 8; pending.push(entry); }
    } else {
      for (const key of Object.keys(current)) { bytes += key.length * 2 + 8; pending.push(current[key]); }
    }
  }
  return bytes;
}
