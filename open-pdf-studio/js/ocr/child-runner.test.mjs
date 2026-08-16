import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeOcrChildJob } from './child-runner.js';

function encodedJob(metadata, rgba) {
  const header = new Uint8Array(12);
  header.set([79, 80, 83, 79, 67, 82, 49, 0]);
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  new DataView(header.buffer).setUint32(8, json.byteLength, true);
  const output = new Uint8Array(header.byteLength + json.byteLength + rgba.byteLength);
  output.set(header);
  output.set(json, header.byteLength);
  output.set(rgba, header.byteLength + json.byteLength);
  return output;
}

test('child job decoder validates the envelope and owns an exact RGBA buffer', () => {
  const payload = encodedJob({ schemaVersion: 1, width: 1, height: 1 }, new Uint8Array([1, 2, 3, 4]));
  const decoded = decodeOcrChildJob(payload);
  assert.deepEqual([...decoded.image.rgba], [1, 2, 3, 4]);
  assert.equal(decoded.image.rgba.byteOffset, 0);
  assert.equal(decoded.image.rgba.byteLength, decoded.image.rgba.buffer.byteLength);
});

test('child job decoder rejects truncated and dimension-mismatched buffers', () => {
  assert.throws(() => decodeOcrChildJob(new Uint8Array(4)), /truncated/);
  const payload = encodedJob({ schemaVersion: 1, width: 2, height: 1 }, new Uint8Array([1, 2, 3, 4]));
  assert.throws(() => decodeOcrChildJob(payload), /RGBA byte length/);
});
