import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  canonicalDeltaFromDisplayDelta,
  clampPageTextEditBounds,
  canonicalBoundsFromDisplayRect,
  createPageTextEditPlacement,
  projectCommitBounds,
  projectPageTextEditPlacement,
  scrollFreePreviewSize,
} from './page-text-edit-placement.js';

const sourceStyle = {
  position: 'absolute',
  left: '125px',
  top: '250px',
  width: '200px',
  height: '60px',
  'font-size': '18px',
  'line-height': '24px',
  color: '#333333',
  transform: 'rotate(90deg)',
};

function placement(overrides = {}) {
  return createPageTextEditPlacement({
    documentId: 'doc-1',
    pageNum: 2,
    pageWidth: 600,
    pageHeight: 800,
    canonicalBounds: { x: 10, y: 20, width: 100, height: 30 },
    commitBounds: { x: 10, y: 20, width: 96, height: 30 },
    sourceScale: 2,
    sourceStyle,
    sourceClientAnchor: { left: 125, top: 250 },
    mode: 'ocr-fixed',
    ...overrides,
  });
}

test('page-local placement scales geometry and typography without fixed positioning', () => {
  const projected = projectPageTextEditPlacement(placement(), {
    pageWidth: 600,
    pageHeight: 800,
    rotation: 0,
    scale: 3,
    offsetX: 7,
    offsetY: 11,
  });
  assert.equal(projected.position, 'absolute');
  assert.equal(projected.left, '37px');
  assert.equal(projected.top, '71px');
  assert.equal(projected.width, '300px');
  assert.equal(projected.height, '90px');
  assert.equal(projected['font-size'], '27px');
  assert.equal(projected['line-height'], '36px');
  assert.equal(projected.color, '#333333');
  assert.equal(projected.transform, 'none');
});

test('rotation is reprojected from canonical page geometry', () => {
  const projected = projectPageTextEditPlacement(placement(), {
    pageWidth: 600,
    pageHeight: 800,
    rotation: 90,
    scale: 2,
    offsetX: 5,
    offsetY: 7,
  });
  assert.equal(projected.left, '1565px');
  assert.equal(projected.top, '27px');
  assert.equal(projected.transform, 'rotate(90deg)');
});

test('axis-aligned display bounds round-trip through a rotated page', () => {
  const bounds = canonicalBoundsFromDisplayRect({
    left: 1555,
    top: 127,
    width: 60,
    height: 200,
  }, {
    pageWidth: 600,
    pageHeight: 800,
    rotation: 90,
    scale: 2,
    offsetX: 5,
    offsetY: 7,
    containerLeft: 50,
    containerTop: 100,
  });
  assert.deepEqual(bounds, { x: 10, y: 20, width: 100, height: 30 });
});

test('OCR commit bounds remain independent from an expanded preview', () => {
  const projected = projectCommitBounds(placement(), {
    pageWidth: 600,
    pageHeight: 800,
    rotation: 0,
    scale: 2,
    offsetX: 0,
    offsetY: 0,
  });
  assert.equal(projected.left, '20px');
  assert.equal(projected.top, '40px');
  assert.equal(projected.width, '192px');
  assert.equal(projected.height, '60px');
});

test('placement rejects stale or incomplete identity and geometry', () => {
  assert.throws(() => createPageTextEditPlacement({
    documentId: '',
    pageNum: 0,
    pageWidth: 0,
    pageHeight: 0,
    canonicalBounds: {},
  }), /document and page identity/);
});

test('fixed-region previews grow instead of requiring an internal scrollbar', () => {
  assert.deepEqual(scrollFreePreviewSize({
    minimumWidth: 200,
    minimumHeight: 60,
    scrollWidth: 200,
    scrollHeight: 145,
  }), {
    width: 200,
    height: 145,
    overflowX: false,
    overflowY: true,
    overflowing: true,
  });
});

test('deleting content shrinks the preview back to immutable commit bounds', () => {
  const size = scrollFreePreviewSize({
    minimumWidth: 200,
    minimumHeight: 60,
    scrollWidth: 180,
    scrollHeight: 32,
  });
  assert.equal(size.height, 60);
  assert.equal(size.overflowing, false);
});

test('the text editor portal has no fixed-position fallback', async () => {
  const css = await readFile(new URL('../../styles/layout.css', import.meta.url), 'utf8');
  const portalRule = css.match(/\.pdf-text-edit-portal\s*\{([^}]*)\}/)?.[1] || '';
  const pageHostRule = css.match(/\.pdf-text-edit-layer\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(portalRule, /position:\s*absolute/);
  assert.doesNotMatch(portalRule, /position:\s*fixed/);
  assert.match(pageHostRule, /position:\s*absolute/);
});

test('display drags map back through every supported page rotation', () => {
  assert.deepEqual(canonicalDeltaFromDisplayDelta({ x: 20, y: 10 }, { scale: 2, rotation: 0 }), { x: 10, y: 5 });
  assert.deepEqual(canonicalDeltaFromDisplayDelta({ x: 20, y: 10 }, { scale: 2, rotation: 90 }), { x: 5, y: -10 });
  assert.deepEqual(canonicalDeltaFromDisplayDelta({ x: 20, y: 10 }, { scale: 2, rotation: 180 }), { x: -10, y: -5 });
  assert.deepEqual(canonicalDeltaFromDisplayDelta({ x: 20, y: 10 }, { scale: 2, rotation: 270 }), { x: -5, y: 10 });
});

test('direct manipulation clamps moved and resized editors to the page', () => {
  assert.deepEqual(clampPageTextEditBounds(
    { x: 190, y: -10, width: 40, height: 30 },
    { width: 200, height: 100 },
    { width: 24, height: 18 },
  ), { x: 160, y: 0, width: 40, height: 30 });
  assert.deepEqual(clampPageTextEditBounds(
    { x: 10, y: 10, width: 5, height: 500 },
    { width: 200, height: 100 },
    { width: 24, height: 18 },
  ), { x: 10, y: 0, width: 24, height: 100 });
});
