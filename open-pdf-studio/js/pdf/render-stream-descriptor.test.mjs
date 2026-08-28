import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRenderStreamDescriptor } from './render-stream-descriptor.js';

const now = 1_800_000_000_000;
const token = 'ab'.repeat(32);
const descriptor = (overrides = {}) => ({
  token,
  url: `http://127.0.0.1:49152/raster/${token}`,
  width: 1_224,
  height: 1_584,
  bytes: 250_000,
  expiresAt: now + 30_000,
  ...overrides,
});

test('accepts a bounded one-use loopback raster descriptor', () => {
  assert.deepEqual(validateRenderStreamDescriptor(descriptor(), { now }), descriptor());
});

test('rejects non-loopback and token-mismatched URLs', () => {
  assert.throws(
    () => validateRenderStreamDescriptor(descriptor({
      url: `http://localhost:49152/raster/${token}`,
    }), { now }),
    /loopback capability/,
  );
  assert.throws(
    () => validateRenderStreamDescriptor(descriptor({
      url: `http://127.0.0.1:49152/raster/${'cd'.repeat(32)}`,
    }), { now }),
    /loopback capability/,
  );
});

test('rejects expired, oversized, and malformed descriptors', () => {
  assert.throws(
    () => validateRenderStreamDescriptor(descriptor({ expiresAt: now - 2_000 }), { now }),
    /expiry/,
  );
  assert.throws(
    () => validateRenderStreamDescriptor(descriptor({ width: 32_769 }), { now }),
    /dimensions/,
  );
  assert.throws(
    () => validateRenderStreamDescriptor(descriptor({ bytes: 0 }), { now }),
    /payload/,
  );
  assert.throws(
    () => validateRenderStreamDescriptor(descriptor({ token: 'predictable' }), { now }),
    /capability token/,
  );
});

