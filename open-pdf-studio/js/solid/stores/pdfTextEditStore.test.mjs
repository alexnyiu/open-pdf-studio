import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRichTextDraftParagraphFormat,
  adoptFinalTextLayoutDecision,
  flushEditorDraftForCommit,
  getEditorRichText,
  hidePdfTextEditor,
  editorMountGeneration,
  editorOptions,
  editorPlacement,
  recordEditorGeometryHistory,
  redoRichTextDraft,
  richTextDraftRevision,
  richTextHistoryMetrics,
  showPdfTextEditor,
  shiftEditorPosition,
  setEditorDraftFlushHandler,
  undoRichTextDraft,
  updateEditorGeometry,
  updateEditorStyle,
  updateRichTextDraft,
} from './pdfTextEditStore.js';
import {
  createRichTextDocument,
  createTextLine,
  createTextRun,
  richTextToPlainText,
} from '../../text/rich-text.js';

const style = {
  faceId: 'liberation-sans-regular',
  size: 12,
  color: '#111111',
  bold: false,
  italic: false,
  underline: false,
  strikeout: false,
  direction: 'ltr',
};

function documentWithText(value) {
  return createRichTextDocument([
    createTextLine([createTextRun(value, style, { id: 'run-1' })], {
      id: 'line-1', baseline: 20, baselineAdvance: 14, alignment: 'left',
    }),
  ], { x: 0, y: 0, width: 100, height: 20 });
}

function open(value = 'a') {
  showPdfTextEditor({}, value, {
    options: { richTextDocument: documentWithText(value) },
    onCommit() {},
    onCancel() {},
  });
}

test('every editor open receives a distinct Solid mount generation', () => {
  const before = editorMountGeneration();
  open('first');
  const first = editorMountGeneration();
  hidePdfTextEditor();
  open('second');
  const second = editorMountGeneration();
  assert.ok(first > before);
  assert.ok(second > first);
  hidePdfTextEditor();
});

test('typing patches coalesce into one reversible 350 ms undo unit', () => {
  open('a');
  updateRichTextDraft(documentWithText('ab'));
  updateRichTextDraft(documentWithText('abc'));
  assert.equal(richTextHistoryMetrics().entries, 1);
  assert.equal(undoRichTextDraft(), true);
  assert.equal(richTextToPlainText(getEditorRichText()), 'a');
  assert.equal(redoRichTextDraft(), true);
  assert.equal(richTextToPlainText(getEditorRichText()), 'abc');
  hidePdfTextEditor();
});

test('draft revision invalidates cached line grapheme offsets on every content lifecycle change', () => {
  const beforeOpen = richTextDraftRevision();
  open('cache');
  const afterOpen = richTextDraftRevision();
  assert.ok(afterOpen > beforeOpen);
  updateRichTextDraft(documentWithText('cache updated'));
  const afterUpdate = richTextDraftRevision();
  assert.ok(afterUpdate > afterOpen);
  hidePdfTextEditor();
  assert.ok(richTextDraftRevision() > afterUpdate);
});

test('typing at a non-adjacent caret starts a separate undo unit', () => {
  open('abcd');
  updateRichTextDraft(documentWithText('abcde'));
  updateRichTextDraft(documentWithText('Xabcde'));
  assert.equal(richTextHistoryMetrics().entries, 2);
  assert.equal(undoRichTextDraft(), true);
  assert.equal(richTextToPlainText(getEditorRichText()), 'abcde');
  assert.equal(undoRichTextDraft(), true);
  assert.equal(richTextToPlainText(getEditorRichText()), 'abcd');
  hidePdfTextEditor();
});

test('coalesced typing replaces intermediate identity churn with one bounded patch', () => {
  open('source');
  for (let index = 1; index <= 500; index += 1) {
    const value = 'x'.repeat(index);
    const document = createRichTextDocument([
      createTextLine([createTextRun(value, style, { id: `run-${index}` })], {
        id: `line-${index}`, baseline: 20, baselineAdvance: 14, alignment: 'left',
      }),
    ], { x: 0, y: 0, width: 100, height: 20 });
    updateRichTextDraft(document);
  }
  const metrics = richTextHistoryMetrics();
  assert.equal(metrics.entries, 1);
  assert.ok(metrics.approximateBytes <= metrics.maxBytes);
  assert.equal(undoRichTextDraft(), true);
  assert.equal(richTextToPlainText(getEditorRichText()), 'source');
  assert.equal(redoRichTextDraft(), true);
  assert.equal(richTextToPlainText(getEditorRichText()), 'x'.repeat(500));
  hidePdfTextEditor();
});

test('history evicts complete oldest units at 100 entries and stays within 12 MB', () => {
  open('0');
  for (let index = 1; index <= 110; index += 1) {
    updateRichTextDraft(documentWithText(String(index)), { historyKind: 'paragraph-format' });
  }
  const metrics = richTextHistoryMetrics();
  assert.equal(metrics.entries, 100);
  assert.ok(metrics.approximateBytes <= metrics.maxBytes);
  hidePdfTextEditor();
});

test('large canonical insertion is retained as one compact undoable range patch', () => {
  open('prefix');
  const inserted = `prefix${'x'.repeat(25_000)}`;
  updateRichTextDraft(documentWithText(inserted), { historyKind: 'paste' });
  assert.equal(richTextToPlainText(getEditorRichText()), inserted);
  assert.equal(richTextHistoryMetrics().entries, 1);
  assert.ok(richTextHistoryMetrics().approximateBytes < 12 * 1024 * 1024);
  undoRichTextDraft();
  assert.equal(richTextToPlainText(getEditorRichText()), 'prefix');
  hidePdfTextEditor();
});

test('an oversized paste remains undoable without exceeding the hard history budget', () => {
  open('prefix');
  const inserted = `prefix${'x'.repeat(6_500_000)}`;
  updateRichTextDraft(documentWithText(inserted), { historyKind: 'paste' });
  const metrics = richTextHistoryMetrics();
  assert.equal(metrics.entries, 1);
  assert.equal(metrics.redoUnavailableEntries, 1);
  assert.ok(metrics.approximateBytes <= metrics.maxBytes);
  assert.equal(undoRichTextDraft(), true);
  assert.equal(richTextToPlainText(getEditorRichText()), 'prefix');
  assert.equal(redoRichTextDraft(), false);
  hidePdfTextEditor();
});

test('line-spacing multiplier uses each selected line maximum run size', () => {
  const document = createRichTextDocument([
    createTextLine([
      createTextRun('small', style, { id: 'run-a' }),
      createTextRun('large', { ...style, size: 20 }, { id: 'run-b' }),
    ], { id: 'line-a', baseline: 40, baselineAdvance: 18, alignment: 'left' }),
    createTextLine([
      createTextRun('second', { ...style, size: 10 }, { id: 'run-c' }),
    ], { id: 'line-b', baseline: 22, baselineAdvance: 15, alignment: 'left' }),
  ], { x: 0, y: 0, width: 100, height: 40 });
  showPdfTextEditor({}, 'smalllargesecond', {
    options: { richTextDocument: document }, onCommit() {}, onCancel() {},
  });
  applyRichTextDraftParagraphFormat('lineSpacingMultiplier', 1.5);
  const updated = getEditorRichText();
  assert.equal(updated.lines[0].baselineAdvance, 30);
  assert.equal(updated.lines[1].baselineAdvance, 15);
  assert.equal(updated.lines[1].baseline, 10);
  hidePdfTextEditor();
});

test('a completed geometry gesture is one reversible document and placement unit', () => {
  const beforeDocument = documentWithText('move me');
  const placement = {
    documentId: 'document-1',
    pageNum: 1,
    generation: 0,
    pageWidth: 600,
    pageHeight: 800,
    sourceScale: 1,
    sourceRotation: 0,
    canonicalStyle: {
      geometry: { width: 100, height: 20 },
      typography: {}, padding: {}, border: {}, decoration: {}, layout: {},
    },
    canonicalBounds: { x: 10, y: 20, width: 100, height: 20 },
  };
  showPdfTextEditor({}, 'move me', {
    options: {
      richTextDocument: beforeDocument,
      placement,
      expandableRegion: {
        width: 100,
        contentWidth: 96,
        contentInset: 2,
        inkPadding: 9,
        minimumHeight: 20,
        anchorTop: 20,
      },
    },
    onCommit() {},
    onCancel() {},
  });
  const afterDocument = structuredClone(beforeDocument);
  afterDocument.region.x = 25;
  afterDocument.region.y = 8;
  afterDocument.lines[0].baseline += 8;
  updateEditorGeometry({
    canonicalBounds: { x: 25, y: 12, width: 100, height: 20 },
    width: 100,
    minimumHeight: 20,
    anchorTop: 28,
  });
  assert.equal(editorOptions().expandableRegion.contentWidth, 96,
    'canonical content inset, not visual ink padding, owns resized content width');
  updateRichTextDraft(afterDocument, { recordHistory: false });
  assert.equal(recordEditorGeometryHistory({
    beforeDocument,
    afterDocument,
    beforeGeometry: {
      canonicalBounds: placement.canonicalBounds,
      width: 100,
      minimumHeight: 20,
      anchorTop: 20,
    },
    afterGeometry: {
      canonicalBounds: { x: 25, y: 12, width: 100, height: 20 },
      width: 100,
      minimumHeight: 20,
      anchorTop: 28,
    },
  }), true);
  assert.equal(richTextHistoryMetrics().entries, 1);
  assert.equal(undoRichTextDraft(), true);
  assert.equal(getEditorRichText().region.x, 0);
  assert.equal(editorPlacement().canonicalBounds.x, 10);
  assert.equal(redoRichTextDraft(), true);
  assert.equal(getEditorRichText().region.x, 25);
  assert.equal(editorPlacement().canonicalBounds.x, 25);
  hidePdfTextEditor();
});

test('live style updates merge an explicit canonical patch instead of parsing CSS', () => {
  const placement = {
    documentId: 'document-1', pageNum: 1, generation: 0,
    pageWidth: 600, pageHeight: 800, sourceScale: 2, sourceRotation: 0,
    sourceClientAnchor: { left: 20, top: 40 },
    canonicalStyle: {
      geometry: { width: 100, height: 20 },
      typography: { color: '#111111', fontSize: 12 },
      padding: {}, border: {}, decoration: {}, layout: {},
    },
    canonicalBounds: { x: 10, y: 20, width: 100, height: 20 },
  };
  showPdfTextEditor({}, 'style me', {
    options: { placement }, onCommit() {}, onCancel() {},
  });
  updateEditorStyle({ color: '#ff0000', filter: 'url(untrusted)' }, {
    typography: { color: '#ff0000', fontWeight: 'bold' },
  });
  assert.equal(editorPlacement().canonicalStyle.typography.color, '#ff0000');
  assert.equal(editorPlacement().canonicalStyle.typography.fontWeight, 'bold');
  assert.equal(Object.hasOwn(editorPlacement().canonicalStyle, 'filter'), false);
  hidePdfTextEditor();
});

test('keyboard shifts mutate canonical bounds through source rotation', () => {
  const placement = {
    documentId: 'document-1', pageNum: 1, generation: 0,
    pageWidth: 600, pageHeight: 800, sourceScale: 2, sourceRotation: 90,
    canonicalStyle: {
      geometry: { width: 100, height: 20 },
      typography: {}, padding: {}, border: {}, decoration: {}, layout: {},
    },
    canonicalBounds: { x: 10, y: 20, width: 100, height: 20 },
  };
  showPdfTextEditor({ left: '20px', top: '40px' }, 'move me', {
    options: { placement }, onCommit() {}, onCancel() {},
  });
  shiftEditorPosition(20, 10);
  assert.equal(editorPlacement().canonicalBounds.x, 15);
  assert.equal(editorPlacement().canonicalBounds.y, 10);
  hidePdfTextEditor();
});

test('final commit flush returns an immutable session and draft-revision snapshot', () => {
  const placement = {
    documentId: 'document-1', pageNum: 1, generation: 0, sessionGeneration: 12,
    pageWidth: 600, pageHeight: 800, sourceScale: 2, sourceRotation: 0,
    canonicalStyle: {
      geometry: { width: 100, height: 20 },
      typography: {}, padding: {}, border: {}, decoration: {}, layout: {},
    },
    canonicalBounds: { x: 10, y: 20, width: 100, height: 20 },
  };
  showPdfTextEditor({}, 'before', {
    options: {
      placement,
      richTextDocument: documentWithText('before'),
      expandableRegion: {
        width: 100, contentWidth: 100, effectiveContentWidth: 100,
        minimumHeight: 20, anchorTop: 20,
        pageBounds: { x: 0, y: 0, width: 600, height: 800 },
      },
    },
    onCommit() {}, onCancel() {},
  });
  setEditorDraftFlushHandler(() => {
    updateRichTextDraft(documentWithText('final draft'));
    return true;
  });
  const snapshot = flushEditorDraftForCommit({
    sessionId: 'session-1',
    ownerDocumentId: 'document-1',
    ownerDocumentGeneration: 9,
  });
  assert.equal(snapshot.plainText, 'final draft');
  assert.equal(snapshot.sessionId, 'session-1');
  assert.equal(snapshot.ownerDocumentGeneration, 9);
  assert.equal(snapshot.authoredChangedByFlush, true);
  assert.equal(snapshot.placementGeneration, editorPlacement().sessionGeneration);
  assert.equal(snapshot.layoutRevision.payload.identity.draftRevision, snapshot.draftRevision);
  assert.equal(snapshot.layoutRevision.payload.identity.editorMountGeneration, editorMountGeneration());
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.document), true);

  updateRichTextDraft(documentWithText('newer mutable draft'));
  assert.equal(snapshot.plainText, 'final draft');
  assert.equal(richTextToPlainText(snapshot.document), 'final draft');
  hidePdfTextEditor();
});

test('adopting an exact auto-fit layout does not create a second draft revision', () => {
  const placement = {
    documentId: 'document-1', pageNum: 1, generation: 0, sessionGeneration: 3,
    pageWidth: 600, pageHeight: 800, sourceScale: 2, sourceRotation: 0,
    canonicalStyle: {
      geometry: { width: 100, height: 20 },
      typography: {}, padding: {}, border: {}, decoration: {}, layout: {},
    },
    canonicalBounds: { x: 10, y: 20, width: 100, height: 20 },
  };
  const document = documentWithText('fit me');
  showPdfTextEditor({}, 'fit me', {
    options: {
      placement, richTextDocument: document,
      expandableRegion: {
        width: 100, contentWidth: 100, effectiveContentWidth: 100,
        minimumHeight: 20, anchorTop: 20,
      },
    },
    onCommit() {}, onCancel() {},
  });
  const before = richTextDraftRevision();
  const fitted = documentWithText('fit me');
  fitted.region.width = 110;
  assert.equal(adoptFinalTextLayoutDecision({
    status: 'auto-fitted',
    requestedFingerprint: 'fit-2',
    validatedFingerprint: 'fit-2',
    document: fitted,
  }), true);
  assert.equal(richTextDraftRevision(), before);
  assert.equal(getEditorRichText().region.width, 110);
  assert.equal(editorOptions().expandableRegion.width, 110);
  assert.equal(editorOptions().expandableRegion.effectiveContentWidth, 110);
  hidePdfTextEditor();
});
