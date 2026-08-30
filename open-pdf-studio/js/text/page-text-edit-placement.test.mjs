import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  applyPageTextEditProjection,
  canonicalDeltaFromDisplayDelta,
  clampPageTextEditBounds,
  canonicalBoundsFromDisplayRect,
  canonicalEditorBoundsForRichText,
  createPageTextEditPlacement,
  createPageTextEditStyle,
  mergePageTextEditStyle,
  projectCommitBounds,
  projectPageTextEditPlacement,
  shallowEqualPageTextEditProjection,
  scrollFreePreviewSize,
} from './page-text-edit-placement.js';
import {
  createPageTextEditPlacementController,
  shouldCancelPageTextEditPlacement,
} from './page-text-edit-placement-controller.js';

const canonicalStyle = createPageTextEditStyle({
  geometry: { width: 100, height: 30, zIndex: 9 },
  typography: {
    fontFamily: 'Liberation Sans, sans-serif',
    fontSize: 9,
    lineHeight: 12,
    fontWeight: 'bold',
    fontStyle: 'italic',
    textAlign: 'center',
    color: '#333333',
    direction: 'ltr',
    fontSynthesis: 'none',
  },
  padding: { top: 1, right: 2, bottom: 3, left: 4 },
  border: { width: 0.5, style: 'solid', color: '#111111', boxSizing: 'border-box' },
  decoration: {
    backgroundColor: '#ffffff',
    outlineStyle: 'none',
    outlineOffset: 0.25,
    textDecorationLine: 'underline',
    textDecorationThicknessEm: 0.06,
    textUnderlineOffsetEm: 0.08,
    textShadow: 'none',
    caretColor: '#333333',
    textOffset: 1.5,
  },
  layout: {
    resize: 'none',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'normal',
  },
});

function placement(overrides = {}) {
  return createPageTextEditPlacement({
    documentId: 'doc-1',
    pageNum: 2,
    pageWidth: 600,
    pageHeight: 800,
    canonicalBounds: { x: 10, y: 20, width: 100, height: 30 },
    commitBounds: { x: 10, y: 20, width: 96, height: 30 },
    sourceScale: 2,
    canonicalStyle,
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
  assert.equal(projected['--text-offset'], '4.5px');
  assert.equal(projected['padding-left'], '12px');
  assert.equal(projected['border-width'], '1.5px');
  assert.equal(projected['text-decoration-thickness'], '0.06em');
  assert.equal(projected['background-color'], '#ffffff');
  assert.equal(projected['font-family'], 'Liberation Sans, sans-serif');
  assert.equal(projected['font-weight'], 'bold');
  assert.equal(projected['font-style'], 'italic');
  assert.equal(projected['text-align'], 'center');
  assert.equal(projected.color, '#333333');
  assert.equal(projected.transform, 'none');
  assert.equal(projected['z-index'], '9');
});

test('textbox and callout canonical geometry survives 100 to 250 to 100 view projection', () => {
  const annotations = [
    {
      type: 'textbox',
      x: 42.5,
      y: 84.25,
      width: 180,
      height: 64,
      rotation: 0,
      leaders: [{ id: 'leader-1', tipX: 18, tipY: 105, kneeX: 30, kneeY: 105 }],
      richText: { region: { x: 42.5, y: 84.25, width: 180, height: 64, rotation: 0 } },
    },
    {
      type: 'callout',
      x: 240.5,
      y: 310.25,
      width: 150,
      height: 60,
      rotation: 0,
      arrowX: 185.5,
      arrowY: 340.25,
      kneeX: 222.5,
      kneeY: 340.25,
      armOriginX: 240.5,
      armOriginY: 340.25,
      richText: { region: { x: 240.5, y: 310.25, width: 150, height: 60, rotation: 0 } },
    },
  ];

  for (const annotation of annotations) {
    const canonicalBefore = structuredClone(annotation);
    const annotationPlacement = placement({
      mode: annotation.type,
      canonicalBounds: {
        x: annotation.x,
        y: annotation.y,
        width: annotation.width,
        height: annotation.height,
      },
      commitBounds: structuredClone(annotation.richText.region),
    });
    const at100 = projectPageTextEditPlacement(annotationPlacement, {
      pageWidth: 600, pageHeight: 800, rotation: 0, scale: 1, offsetX: 0, offsetY: 0,
    });
    const at250 = projectPageTextEditPlacement(annotationPlacement, {
      pageWidth: 600, pageHeight: 800, rotation: 0, scale: 2.5, offsetX: 0, offsetY: 0,
    });
    const returnedTo100 = projectPageTextEditPlacement(annotationPlacement, {
      pageWidth: 600, pageHeight: 800, rotation: 0, scale: 1, offsetX: 0, offsetY: 0,
    });

    assert.notEqual(at250.height, at100.height, `${annotation.type} display height did not scale`);
    assert.deepEqual(returnedTo100, at100, `${annotation.type} did not return to its 100% projection`);
    assert.deepEqual(annotation, canonicalBefore, `${annotation.type} view projection mutated canonical geometry`);
  }
});

test('annotation editor has no display-height callback into canonical geometry', async () => {
  const source = await readFile(new URL('../tools/text-editing.js', import.meta.url), 'utf8');
  const annotationEditor = source.slice(
    source.indexOf('export async function startTextEditing'),
    source.indexOf('export function finishTextEditing'),
  );
  assert.doesNotMatch(annotationEditor, /onHeightChange\s*:/u);
  assert.doesNotMatch(annotationEditor, /displayHeight\s*\/\s*livePlacementScale/u);
});

test('annotation editor registers immutable ownership before exact-layout mounting', async () => {
  const source = await readFile(new URL('../tools/text-editing.js', import.meta.url), 'utf8');
  const annotationEditor = source.slice(
    source.indexOf('export async function startTextEditing'),
    source.indexOf('export function finishTextEditing'),
  );
  const registration = annotationEditor.indexOf('session = registerTextEditSession({');
  const mount = annotationEditor.indexOf('showPdfTextEditor(styleObj, initialText');
  assert.ok(registration >= 0, 'annotation editor session registration is missing');
  assert.ok(mount >= 0, 'annotation editor mount is missing');
  assert.ok(registration < mount,
    'exact layout must not mount before its immutable session identity exists');
});

test('clean annotation Apply distinguishes authored flush changes from layout normalization', async () => {
  const source = await readFile(new URL('../tools/text-editing.js', import.meta.url), 'utf8');
  const annotationEditor = source.slice(
    source.indexOf('export async function startTextEditing'),
    source.indexOf('export function finishTextEditing'),
  );
  const preFlushDirty = annotationEditor.indexOf('const wasDirtyBeforeFlush =');
  const flush = annotationEditor.indexOf('const snapshot = flushPdfEditorDraftForCommit({');
  const authoredFlush = annotationEditor.indexOf('snapshot.authoredChangedByFlush === true');
  assert.ok(preFlushDirty >= 0 && flush >= 0 && authoredFlush >= 0,
    'annotation Apply must retain both pre-flush and authored-flush dirty state');
  assert.ok(preFlushDirty < flush,
    'clean state must be captured before DOM sealing can normalize layout geometry');

  const overlay = await readFile(
    new URL('../solid/components/PdfTextEditOverlay.jsx', import.meta.url),
    'utf8',
  );
  const sync = overlay.slice(
    overlay.indexOf('const syncRichDocument = () => {'),
    overlay.indexOf('const captureRichBeforeInput ='),
  );
  assert.match(sync,
    /semanticRichTextSignature\(draft\)\s*!==\s*semanticRichTextSignature\(current\)/u,
    'DOM sealing must compare authored semantics without reflow-owned geometry');
  const authoredGuard = sync.indexOf('if (authoredChanged) {');
  const canonicalWrite = sync.indexOf('updateRichTextDraft(draft, {');
  assert.ok(authoredGuard >= 0 && canonicalWrite > authoredGuard,
    'a semantic no-op DOM seal must not replace the clean canonical draft');
});

test('keyed portal handoff clears stale editor refs before replacement sizing', async () => {
  const source = await readFile(
    new URL('../solid/components/PdfTextEditOverlay.jsx', import.meta.url),
    'utf8',
  );
  const capture = source.slice(
    source.indexOf('const capturePortalElement = (element) => {'),
    source.indexOf('const handleViewportRevision = () => {'),
  );
  const clearTextarea = capture.indexOf('textareaRef = undefined;');
  const clearRichEditor = capture.indexOf('richEditorRef = undefined;');
  const schedulePlacement = capture.indexOf('markPlacementDirty()');
  assert.ok(clearTextarea >= 0 && clearRichEditor >= 0,
    'portal handoff must clear both mutually exclusive editor refs');
  assert.ok(clearTextarea < schedulePlacement && clearRichEditor < schedulePlacement,
    'stale editor refs must be cleared before replacement placement work is scheduled');
});

test('outside-edit listeners are keyed to the editor mount rather than placement revisions', async () => {
  const source = await readFile(
    new URL('../solid/components/PdfTextEditOverlay.jsx', import.meta.url),
    'utf8',
  );
  const listenerEffect = source.slice(
    source.indexOf('// Global listeners and geometry observers exist only for an active editor.'),
    source.indexOf('\n  onCleanup(() => {', source.indexOf('// Global listeners and geometry observers exist only for an active editor.')),
  );
  assert.match(listenerEffect,
    /const observedSessionGeneration = untrack\(editorPlacement\)\?\.sessionGeneration/u);
  assert.doesNotMatch(listenerEffect,
    /const observedSessionGeneration = editorPlacement\(\)\?\.sessionGeneration/u);
});

test('page-host mutation handoff preserves only focus already owned by the editor', async () => {
  const source = await readFile(new URL('../solid/components/PdfTextEditOverlay.jsx', import.meta.url), 'utf8');
  assert.match(source, /if \(portalRef\?\.contains\(document\.activeElement\)\) \{\s*restoreFocusAfterHostTransition = true;/u);
  assert.match(source, /const preserveFocus = restoreFocusAfterHostTransition\s*\|\| portalRef\.contains\(document\.activeElement\);/u);
  assert.doesNotMatch(source, /(?:scroll|resize)[^\n]*restoreFocusAfterHostTransition = true/iu,
    'ordinary geometry revisions must not acquire editor focus');
});

test('unchanged exact-layout insets do not perpetually dirty editor placement', async () => {
  const source = await readFile(
    new URL('../solid/components/PdfTextEditOverlay.jsx', import.meta.url),
    'utf8',
  );
  const publisher = source.slice(
    source.indexOf('const publishContentInsetsPx ='),
    source.indexOf('const publishEditorBox ='),
  );
  assert.match(publisher, /shallowEqualPageTextEditProjection\(previous, next\)/u);
  const placementSync = source.slice(
    source.indexOf('const syncPagePlacement ='),
    source.indexOf('const resizeToContent ='),
  );
  assert.match(placementSync, /publishContentInsetsPx\(\{/u);
  assert.doesNotMatch(placementSync, /setContentInsetsPx\(\{/u);
});

test('canonical presentation ignores arbitrary CSS-shaped fields', () => {
  const style = createPageTextEditStyle({
    geometry: { width: 40, left: '999px', transform: 'scale(20)' },
    typography: { fontSize: 10, position: 'fixed' },
    padding: { all: 2 },
    arbitrary: { filter: 'url(evil)' },
  });
  assert.deepEqual(style.geometry, { width: 40 });
  assert.deepEqual(style.typography, { fontSize: 10 });
  assert.deepEqual(style.padding, { top: 2, right: 2, bottom: 2, left: 2 });
  assert.equal(Object.hasOwn(style, 'arbitrary'), false);
});

test('semantic patches update only explicit canonical fields', () => {
  const merged = mergePageTextEditStyle(canonicalStyle, {
    typography: { color: '#ff0000', fontSize: 11 },
    decoration: { textDecorationLine: 'line-through' },
    position: 'fixed',
  });
  assert.equal(merged.typography.color, '#ff0000');
  assert.equal(merged.typography.fontSize, 11);
  assert.equal(merged.typography.fontFamily, canonicalStyle.typography.fontFamily);
  assert.equal(merged.decoration.textDecorationLine, 'line-through');
  assert.equal(Object.hasOwn(merged, 'position'), false);
});

test('complete projected styles are shallow-compared before writes', () => {
  const projected = projectPageTextEditPlacement(placement(), {
    pageWidth: 600, pageHeight: 800, rotation: 0, scale: 2, offsetX: 0, offsetY: 0,
  });
  assert.equal(shallowEqualPageTextEditProjection(projected, { ...projected }), true);
  assert.equal(shallowEqualPageTextEditProjection(projected, { ...projected, color: '#ff0000' }), false);
  const missingColor = { ...projected };
  delete missingColor.color;
  assert.equal(shallowEqualPageTextEditProjection(projected, missingColor), false);

  const values = new Map();
  const writes = [];
  const element = { style: {
    setProperty(key, value) { writes.push(['set', key, value]); values.set(key, value); },
    removeProperty(key) { writes.push(['remove', key]); values.delete(key); },
  } };
  assert.equal(applyPageTextEditProjection(element, projected), true);
  const firstWriteCount = writes.length;
  assert.equal(applyPageTextEditProjection(element, { ...projected }, projected), false);
  assert.equal(writes.length, firstWriteCount);
  assert.equal(applyPageTextEditProjection(element, missingColor, projected), true);
  assert.deepEqual(writes.at(-1), ['remove', 'color']);
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

test('PDF rich-text source geometry projects from one immutable top-left at every rotation', () => {
  const canonicalBounds = canonicalEditorBoundsForRichText({
    x: 50, y: 100, width: 200, height: 40,
  }, 792);
  assert.deepEqual(canonicalBounds, { x: 50, y: 652, width: 200, height: 40 });
  const sourcePlacement = placement({
    pageWidth: 612,
    pageHeight: 792,
    canonicalBounds,
    canonicalStyle: createPageTextEditStyle({ geometry: { width: 200, height: 40 } }),
    sourceClientAnchor: null,
  });
  const expected = new Map([
    [0, ['50px', '652px']],
    [90, ['140px', '50px']],
    [180, ['562px', '140px']],
    [270, ['652px', '562px']],
  ]);
  for (const [rotation, [left, top]] of expected) {
    const projected = projectPageTextEditPlacement(sourcePlacement, {
      pageWidth: 612, pageHeight: 792, rotation, scale: 1, offsetX: 0, offsetY: 0,
    });
    assert.equal(projected.left, left);
    assert.equal(projected.top, top);
  }
});

test('native paragraph entry ignores the clicked span rectangle and minimum CSS seed box', async () => {
  const source = await readFile(new URL('../tools/text-edit-tool.js', import.meta.url), 'utf8');
  const entry = source.slice(
    source.indexOf('async function startPdfTextEditing'),
    source.indexOf('async function finishPdfTextEditing'),
  );
  assert.match(entry, /canonicalEditorBoundsForRichText\(\s*originalRichText\.region/u);
  assert.match(entry, /canonicalBounds,/u);
  assert.doesNotMatch(entry, /block\.rect|groupRect|Math\.max\([^\n]*,\s*80\)|Math\.max\([^\n]*,\s*24\)/u);
  const grouping = source.slice(
    source.indexOf('const groups = blocks.map'),
    source.indexOf('// ── Hover & click wiring'),
  );
  assert.match(grouping, /for \(const sp of allSpans\) spanToBlock\.set\(sp, group\)/u,
    'every first, middle, and final source span must resolve to the same paragraph group');
  const richSourceRegion = source.slice(
    source.indexOf('function richTextForNativeBlock'),
    source.indexOf('function selectionItemForRecord'),
  );
  assert.match(richSourceRegion, /const sourceAscent = fontSize \* 0\.8/u,
    'canonical native placement must share the text-layer baseline ascent');
  assert.match(richSourceRegion, /sourceAscent \+ sourceDescent/u);
  assert.doesNotMatch(richSourceRegion, /fontSize \* 1\.3/u);
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

test('integer scroll metrics do not report overflow for fractional projected bounds', () => {
  const size = scrollFreePreviewSize({
    minimumWidth: 609.46875,
    minimumHeight: 291,
    scrollWidth: 610,
    scrollHeight: 292,
  });
  assert.equal(size.overflowX, false);
  assert.equal(size.overflowY, false);
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

test('placement dirty controller coalesces work into one latest frame', () => {
  const callbacks = new Map();
  let nextFrame = 0;
  let updates = 0;
  let afterUpdates = 0;
  const controller = createPageTextEditPlacementController({
    isActive: () => true,
    update: () => { updates += 1; },
    afterUpdate: () => { afterUpdates += 1; },
    requestFrame(callback) {
      const frame = ++nextFrame;
      callbacks.set(frame, callback);
      return frame;
    },
    cancelFrame(frame) { callbacks.delete(frame); },
  });
  assert.equal(controller.markDirty(), true);
  assert.equal(controller.markDirty(), false);
  assert.equal(callbacks.size, 1);
  callbacks.get(1)();
  assert.equal(updates, 1);
  assert.equal(afterUpdates, 1);
  assert.equal(controller.pending, false);
  assert.equal(controller.markDirty(), true);
  callbacks.get(2)();
  assert.equal(updates, 2);
});

test('placement dirty controller cancels teardown work and does nothing while idle', () => {
  const callbacks = new Map();
  const cancelled = [];
  let active = false;
  let updates = 0;
  const controller = createPageTextEditPlacementController({
    isActive: () => active,
    update: () => { updates += 1; },
    requestFrame(callback) {
      callbacks.set(7, callback);
      return 7;
    },
    cancelFrame(frame) {
      cancelled.push(frame);
      callbacks.delete(frame);
    },
  });
  assert.equal(controller.markDirty(), false);
  active = true;
  assert.equal(controller.markDirty(), true);
  assert.equal(controller.cancel(), true);
  assert.deepEqual(cancelled, [7]);
  assert.equal(updates, 0);
  controller.dispose();
  assert.equal(controller.markDirty(), false);
});

test('placement dirty controller can schedule a second frame after creating a replacement host', () => {
  const callbacks = new Map();
  let nextFrame = 0;
  let updates = 0;
  let controller;
  controller = createPageTextEditPlacementController({
    isActive: () => true,
    update: () => {
      updates += 1;
      if (updates === 1) controller.markDirty();
    },
    requestFrame(callback) {
      const frame = ++nextFrame;
      callbacks.set(frame, callback);
      return frame;
    },
    cancelFrame(frame) { callbacks.delete(frame); },
  });

  controller.markDirty();
  callbacks.get(1)();
  assert.equal(controller.pending, true);
  callbacks.get(2)();
  assert.equal(updates, 2);
  assert.equal(controller.pending, false);
});

test('placement dirty controller retries an unsettled active portal handoff only up to its bound', () => {
  const callbacks = new Map();
  let nextFrame = 0;
  let updates = 0;
  const controller = createPageTextEditPlacementController({
    isActive: () => true,
    update: () => {
      updates += 1;
      return updates >= 3;
    },
    retryLimit: 4,
    requestFrame(callback) {
      const frame = ++nextFrame;
      callbacks.set(frame, callback);
      return frame;
    },
    cancelFrame(frame) { callbacks.delete(frame); },
  });

  controller.markDirty();
  callbacks.get(1)();
  assert.equal(controller.pending, true);
  callbacks.get(2)();
  assert.equal(controller.pending, true);
  callbacks.get(3)();
  assert.equal(updates, 3);
  assert.equal(controller.pending, false);
});

test('a cancelled host-creation retry can recover on the next external dirty event', () => {
  const callbacks = new Map();
  let nextFrame = 0;
  let settled = false;
  let updates = 0;
  const controller = createPageTextEditPlacementController({
    isActive: () => true,
    update: () => {
      updates += 1;
      return settled;
    },
    requestFrame(callback) {
      const frame = ++nextFrame;
      callbacks.set(frame, callback);
      return frame;
    },
    cancelFrame(frame) { callbacks.delete(frame); },
  });

  controller.markDirty();
  callbacks.get(1)();
  assert.equal(controller.pending, true, 'host creation should have queued attachment');
  assert.equal(controller.cancel(), true);
  settled = true;
  assert.equal(controller.markDirty(), true);
  callbacks.get(3)();
  assert.equal(updates, 2);
  assert.equal(controller.pending, false);
});

test('listener cleanup cancels only work owned by the observed editor mount', () => {
  const observed = {
    observedMountGeneration: 7,
    observedSessionGeneration: 11,
  };
  assert.equal(shouldCancelPageTextEditPlacement({
    active: false,
    ...observed,
    currentMountGeneration: 8,
    currentSessionGeneration: 12,
  }), true, 'inactive teardown always cancels pending placement');
  assert.equal(shouldCancelPageTextEditPlacement({
    active: true,
    ...observed,
    currentMountGeneration: 7,
    currentSessionGeneration: 11,
  }), true, 'same-session cleanup still owns its pending frame');
  assert.equal(shouldCancelPageTextEditPlacement({
    active: true,
    ...observed,
    currentMountGeneration: 8,
    currentSessionGeneration: 12,
  }), false, 'an old keyed cleanup must preserve the next session frame');
  assert.equal(shouldCancelPageTextEditPlacement({
    active: true,
    ...observed,
    currentMountGeneration: 8,
    currentSessionGeneration: 11,
  }), false, 'a replacement mount owns the controller even when session identity is reused');
});

test('placement dirty controller falls back once when animation frames are suspended', () => {
  const frames = new Map();
  const timers = new Map();
  const cancelledFrames = [];
  let nextFrame = 0;
  let nextTimer = 100;
  let updates = 0;
  const controller = createPageTextEditPlacementController({
    isActive: () => true,
    update: () => { updates += 1; },
    fallbackDelayMs: 100,
    requestFrame(callback) {
      const frame = ++nextFrame;
      frames.set(frame, callback);
      return frame;
    },
    cancelFrame(frame) {
      cancelledFrames.push(frame);
      frames.delete(frame);
    },
    requestFallback(callback, delay) {
      assert.equal(delay, 100);
      const timer = ++nextTimer;
      timers.set(timer, callback);
      return timer;
    },
    cancelFallback(timer) { timers.delete(timer); },
  });

  assert.equal(controller.markDirty(), true);
  const dormantFrame = frames.get(1);
  timers.get(101)();
  assert.deepEqual(cancelledFrames, [1]);
  assert.equal(updates, 1);
  assert.equal(controller.pending, false);
  dormantFrame();
  assert.equal(updates, 1, 'a late dormant frame must not repeat the fallback update');
});
