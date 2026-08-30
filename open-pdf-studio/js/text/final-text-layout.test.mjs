import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFinalTextLayoutBarrier,
  safeHorizontalAutoFit,
} from './final-text-layout.js';
import { richTextFromPlainText } from './rich-text.js';

function draft(text = 'typing-only') {
  return richTextFromPlainText(text, {
    faceId: 'liberation-sans-regular', size: 12, baselineAdvance: 14.4,
  }, { x: 20, y: 20, width: 100, height: 20, baseline: 32 });
}

function request(overrides = {}) {
  return {
    sessionId: 'session-1', draftRevision: 7, fingerprint: 'fingerprint-7',
    document: draft(), options: { width: 100, contentWidth: 100 },
    timeoutMs: 100, ...overrides,
  };
}

test('final barrier resolves only the exact session, draft revision, and fingerprint', async () => {
  const barrier = createFinalTextLayoutBarrier({
    requestLayout: async (_document, _options, fingerprint) => ({
      fingerprint,
      result: {
        valid: true, document: draft(), requiredWidth: 80, requiredHeight: 20,
        effectiveContentWidth: 100, rejectionReasons: [], overlapWarnings: [],
        pageEdgeValid: true, columnValid: true,
      },
    }),
  });
  const decision = await barrier.awaitFinalTextLayout(request());
  assert.equal(decision.status, 'ready');
  assert.equal(decision.sessionId, 'session-1');
  assert.equal(decision.draftRevision, 7);
  assert.equal(decision.requestedFingerprint, 'fingerprint-7');
  assert.equal(decision.validatedFingerprint, 'fingerprint-7');
  assert.equal(Object.isFrozen(decision), true);
});

test('a stale worker fingerprint is never accepted', async () => {
  const barrier = createFinalTextLayoutBarrier({
    requestLayout: async () => ({
      fingerprint: 'older-fingerprint',
      result: { valid: true, document: draft(), rejectionReasons: [] },
    }),
  });
  const decision = await barrier.awaitFinalTextLayout(request());
  assert.equal(decision.status, 'failed');
  assert.equal(decision.rejectionCode, 'TEXT_LAYOUT_STALE_FINGERPRINT');
  assert.equal(decision.validatedFingerprint, null);
});

test('one dropped latest result is automatically resubmitted once', async () => {
  let attempts = 0;
  const barrier = createFinalTextLayoutBarrier({
    requestLayout: async (_document, _options, fingerprint) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('injected drop'), {
        code: 'SAVE_FAULT_INJECTED', stage: 'drop-latest-text-layout-result',
      });
      return {
        fingerprint,
        result: {
          valid: true, document: draft(), requiredWidth: 80, requiredHeight: 20,
          effectiveContentWidth: 100, rejectionReasons: [], overlapWarnings: [],
          pageEdgeValid: true, columnValid: true,
        },
      };
    },
  });
  const decision = await barrier.awaitFinalTextLayout(request());
  assert.equal(decision.status, 'ready');
  assert.equal(attempts, 2);
});

test('timeout is timer-bound and typed', async () => {
  const barrier = createFinalTextLayoutBarrier({
    requestLayout: () => new Promise(() => {}),
  });
  const decision = await barrier.awaitFinalTextLayout(request({ timeoutMs: 5 }));
  assert.equal(decision.status, 'failed');
  assert.equal(decision.rejectionCode, 'TEXT_LAYOUT_TIMEOUT');
});

test('typing 0.05 PDF points past capacity auto-fits once and validates the new fingerprint', async () => {
  const fingerprints = [];
  const barrier = createFinalTextLayoutBarrier({
    requestLayout: async (document, _options, fingerprint) => {
      fingerprints.push(fingerprint);
      if (fingerprints.length === 1) {
        return {
          fingerprint,
          result: {
            valid: false,
            document,
            requiredWidth: 100.05,
            requiredHeight: 20,
            effectiveContentWidth: 100,
            paintedLineAdvances: [100.05],
            rejectionCode: 'TEXT_LAYOUT_WIDTH_CAPACITY',
            rejectionCodes: ['TEXT_LAYOUT_WIDTH_CAPACITY'],
            rejectionReasons: ['A line exceeds the text box width'],
            overlapWarnings: [], pageEdgeValid: true, columnValid: true,
          },
        };
      }
      return {
        fingerprint,
        result: {
          valid: true,
          document,
          requiredWidth: 100.05,
          requiredHeight: 20,
          effectiveContentWidth: 100.05,
          rejectionReasons: [], overlapWarnings: [], pageEdgeValid: true, columnValid: true,
        },
      };
    },
  });
  const decision = await barrier.awaitFinalTextLayout(request({
    options: {
      width: 100, contentWidth: 100, effectiveContentWidth: 100,
      pageBounds: { x: 0, y: 0, width: 612, height: 792 },
    },
  }));
  assert.equal(decision.status, 'auto-fitted');
  assert.equal(decision.autoFit.nextBounds.width, 100.05);
  assert.equal(decision.document.region.width, 100.05);
  assert.equal(fingerprints.length, 2);
  assert.notEqual(fingerprints[0], fingerprints[1]);
  assert.equal(decision.requestedFingerprint, fingerprints[1]);
  assert.equal(decision.validatedFingerprint, fingerprints[1]);
});

test('safe auto-fit applies canonical left, right, and center anchors on rotated pages', () => {
  for (const [alignment, expectedX] of [
    ['left', 20],
    ['right', 10],
    ['center', 15],
  ]) {
    const document = draft();
    document.region = { ...document.region, x: 20, width: 100, rotation: 90 };
    document.lines[0].alignment = alignment;
    const fit = safeHorizontalAutoFit({
      document,
      result: {
        valid: false, requiredWidth: 110, effectiveContentWidth: 100,
        paintedLineAdvances: [110], pageEdgeValid: true, columnValid: true,
        rejectionCodes: ['TEXT_LAYOUT_WIDTH_CAPACITY'],
        rejectionReasons: ['Text exceeds the available content width'],
      },
      options: {
        width: 100, contentWidth: 100, effectiveContentWidth: 100,
        pageBounds: { x: 0, y: 0, width: 200, height: 300 },
      },
    });
    assert.equal(fit.legal, true, alignment);
    assert.equal(fit.nextBounds.x, expectedX, alignment);
    assert.equal(fit.document.region.rotation, 90, alignment);
  }
});

test('safe auto-fit reports page, column, and newly introduced neighbor constraints', () => {
  const document = draft();
  document.region = { ...document.region, x: 20, y: 20, width: 100, height: 20 };
  const result = {
    valid: false, requiredWidth: 140, effectiveContentWidth: 100,
    paintedLineAdvances: [140], pageEdgeValid: true, columnValid: true,
    rejectionCodes: ['TEXT_LAYOUT_WIDTH_CAPACITY'],
    rejectionReasons: ['Text exceeds the available content width'],
  };
  assert.equal(safeHorizontalAutoFit({
    document, result,
    options: { pageBounds: { x: 0, y: 0, width: 130, height: 300 } },
  }).rejectionCode, 'TEXT_LAYOUT_PAGE_BOUNDARY');
  assert.equal(safeHorizontalAutoFit({
    document, result,
    options: {
      pageBounds: { x: 0, y: 0, width: 300, height: 300 },
      columnBounds: { left: 10, right: 145 },
    },
  }).rejectionCode, 'TEXT_LAYOUT_COLUMN_BOUNDARY');
  assert.equal(safeHorizontalAutoFit({
    document, result,
    options: {
      pageBounds: { x: 0, y: 0, width: 300, height: 300 },
      existingBounds: [{ id: 'neighbor', x: 125, y: 20, width: 30, height: 20 }],
    },
  }).rejectionCode, 'TEXT_LAYOUT_NEIGHBOR_OVERLAP');
});

test('production commit barrier contains no animation-frame polling loop', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../tools/text-edit-tool.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function nativeLayoutReadyForCommit');
  const end = source.indexOf('\nfunction applyActiveTextEditingWithStatus', start);
  const implementation = source.slice(start, end);
  assert.match(implementation, /awaitFinalTextLayout/u);
  assert.doesNotMatch(implementation, /requestAnimationFrame|performance\.now|while\s*\(/u);
});
