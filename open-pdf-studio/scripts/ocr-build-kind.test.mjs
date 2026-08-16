import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyOcrGateAppPath } from './ocr-build-kind.mjs';

test('OCR gate classifies supported release package paths', () => {
  assert.equal(
    classifyOcrGateAppPath('/repo/target/release/open-pdf-studio.exe'),
    'packaged-release',
  );
  assert.equal(
    classifyOcrGateAppPath('/repo/target/universal-apple-darwin/release/bundle/macos/Open PDF Studio.app/Contents/MacOS/open-pdf-studio'),
    'packaged-release',
  );
  assert.equal(classifyOcrGateAppPath('/tmp/Open_PDF_Studio.AppImage'), 'packaged-release');
});

test('OCR gate distinguishes debug and unknown external executables', () => {
  assert.equal(classifyOcrGateAppPath('/repo/target/debug/open-pdf-studio'), 'debug');
  assert.equal(classifyOcrGateAppPath('/opt/open-pdf-studio'), 'external');
});
