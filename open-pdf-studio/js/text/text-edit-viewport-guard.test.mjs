import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { noteDocumentViewMutation } from '../pdf/view-state-transaction.js';
import {
  captureTextEditViewportGuard,
  restoreTextEditViewportGuard,
} from './text-edit-viewport-guard.js';

function documentState() {
  return {
    id: 'document-a',
    lifecycleGeneration: 4,
    currentPage: 6,
    scale: 1.75,
    viewMode: 'continuous',
    bookSpread: false,
    facingSpread: false,
    scrollPosition: { x: 84, y: 3_250 },
  };
}

test('click-away restores continuous scroll and page drift caused by portal teardown', () => {
  const owner = documentState();
  const container = { scrollLeft: 84, scrollTop: 3_250, isConnected: true };
  const snapshot = captureTextEditViewportGuard({
    documentState: owner,
    activeDocument: owner,
    scrollContainer: container,
    sessionId: 'session-a',
    mountGeneration: 7,
  });

  container.scrollLeft = 0;
  container.scrollTop = 0;
  owner.currentPage = 1;
  const restored = restoreTextEditViewportGuard(snapshot, {
    documentState: owner,
    activeDocument: owner,
    scrollContainer: container,
    currentMountGeneration: 7,
  });

  assert.equal(restored.status, 'restored');
  assert.deepEqual({ left: container.scrollLeft, top: container.scrollTop }, { left: 84, top: 3_250 });
  assert.equal(owner.currentPage, 6);
  assert.deepEqual(owner.scrollPosition, { x: 84, y: 3_250 });
});

test('a newer user view mutation wins over the click-away snapshot', () => {
  const owner = documentState();
  const container = { scrollLeft: 84, scrollTop: 3_250, isConnected: true };
  const snapshot = captureTextEditViewportGuard({
    documentState: owner,
    activeDocument: owner,
    scrollContainer: container,
    sessionId: 'session-a',
    mountGeneration: 7,
  });
  noteDocumentViewMutation(owner, ['scroll', 'page']);
  container.scrollTop = 8_000;
  owner.currentPage = 12;

  const restored = restoreTextEditViewportGuard(snapshot, {
    documentState: owner,
    activeDocument: owner,
    scrollContainer: container,
    currentMountGeneration: 7,
  });
  assert.equal(restored.status, 'superseded');
  assert.equal(restored.reason, 'newer-user-page');
  assert.equal(container.scrollTop, 8_000);
  assert.equal(owner.currentPage, 12);
});

test('a newer editor mount cannot be moved by an obsolete click-away completion', () => {
  const owner = documentState();
  const container = { scrollLeft: 84, scrollTop: 3_250, isConnected: true };
  const snapshot = captureTextEditViewportGuard({
    documentState: owner,
    activeDocument: owner,
    scrollContainer: container,
    sessionId: 'session-a',
    mountGeneration: 7,
  });
  container.scrollTop = 4_500;

  const restored = restoreTextEditViewportGuard(snapshot, {
    documentState: owner,
    activeDocument: owner,
    scrollContainer: container,
    currentSessionId: 'session-b',
    currentMountGeneration: 8,
  });
  assert.equal(restored.status, 'superseded');
  assert.equal(restored.reason, 'editor-mount-changed');
  assert.equal(container.scrollTop, 4_500);
});

test('single-page and inactive owners do not capture a continuous viewport lease', () => {
  const owner = documentState();
  owner.viewMode = 'single';
  assert.deepEqual(captureTextEditViewportGuard({
    documentState: owner,
    activeDocument: owner,
    scrollContainer: { scrollLeft: 0, scrollTop: 0 },
  }), { status: 'inactive', reason: 'not-continuous' });
  owner.viewMode = 'continuous';
  assert.deepEqual(captureTextEditViewportGuard({
    documentState: owner,
    activeDocument: { id: 'document-b' },
    scrollContainer: { scrollLeft: 0, scrollTop: 0 },
  }), { status: 'inactive', reason: 'inactive-document-owner' });
});

test('overlay restores teardown drift after gesture settlement and before target replay', async () => {
  const source = await readFile(
    new URL('../solid/components/PdfTextEditOverlay.jsx', import.meta.url),
    'utf8',
  );
  const captureAt = source.indexOf('const viewportGuard = captureTextEditViewportGuard({');
  const applyAt = source.indexOf("const applyPromise = applyActiveTextEditing('click-away')");
  const settleAt = source.indexOf('await settleCapturedGesture();', applyAt);
  const restoreAt = source.indexOf('restoreTextEditViewportGuard(viewportGuard', settleAt);
  const replayAt = source.indexOf('replayTextEditClickAwayIntent(capturedIntent', restoreAt);
  assert.ok(captureAt >= 0 && captureAt < applyAt);
  assert.ok(applyAt < settleAt && settleAt < restoreAt);
  assert.ok(restoreAt < replayAt);
});
