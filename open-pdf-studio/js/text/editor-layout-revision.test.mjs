import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditorLayoutRevision } from './editor-layout-revision.js';
import { resolveEditorStatus } from './editor-status-priority.js';
import { richTextFromPlainText } from './rich-text.js';

function fixture() {
  return richTextFromPlainText('alpha beta', {
    faceId: 'liberation-sans-regular', size: 12, color: '#111111',
    baselineAdvance: 14.4, alignment: 'left',
  }, { x: 10, y: 20, width: 100, height: 30, baseline: 32 });
}

test('layout revision changes for every paragraph, geometry, collision, and owner input', () => {
  const document = fixture();
  const config = {
    width: 100,
    contentWidth: 96,
    contentInset: 2,
    minimumHeight: 30,
    anchorTop: 50,
    inkPadding: 2,
    pageBounds: { x: 0, y: 0, width: 612, height: 792 },
    columnBounds: { left: 0, right: 200 },
    existingBounds: [{ id: 'neighbor', x: 110, y: 20, width: 20, height: 20 }],
  };
  const identity = { sessionId: 's1', ownerDocumentId: 'd1', ownerDocumentGeneration: 2 };
  const base = createEditorLayoutRevision(document, config, identity).fingerprint;
  const cases = [
    [() => { document.lines[0].alignment = 'right'; }, () => { document.lines[0].alignment = 'left'; }],
    [() => { document.lines[0].baselineAdvance += 1; }, () => { document.lines[0].baselineAdvance -= 1; }],
    [() => { document.region.width += 1; }, () => { document.region.width -= 1; }],
    [() => { config.contentWidth -= 1; }, () => { config.contentWidth += 1; }],
    [() => { config.contentInset += 1; }, () => { config.contentInset -= 1; }],
    [() => { config.existingBounds[0].x += 1; }, () => { config.existingBounds[0].x -= 1; }],
    [() => { config.directManipulationRevision = 1; }, () => { config.directManipulationRevision = 0; }],
    [() => { identity.ownerDocumentGeneration += 1; }, () => { identity.ownerDocumentGeneration -= 1; }],
  ];
  for (const [mutate, restore] of cases) {
    mutate();
    assert.notEqual(createEditorLayoutRevision(document, config, identity).fingerprint, base);
    restore();
  }
});

test('neighbor ordering does not change the revision', () => {
  const document = fixture();
  const neighbors = [
    { id: 'b', x: 4, y: 5, width: 6, height: 7 },
    { id: 'a', x: 1, y: 2, width: 3, height: 4 },
  ];
  const left = createEditorLayoutRevision(document, { existingBounds: neighbors });
  const right = createEditorLayoutRevision(document, { existingBounds: [...neighbors].reverse() });
  assert.equal(left.fingerprint, right.fingerprint);
});

test('editor status priority preserves owner, validity, shaping, overflow, then information', () => {
  const common = {
    editorStatus: 'informational instruction',
    pathologicalStatus: 'large paste',
    previewOverflow: true,
    overflowStatus: 'preview overflow',
    defaultStatus: 'default',
  };
  assert.equal(resolveEditorStatus({
    ...common, statusKind: 'stale-owner', editorStatus: 'stale owner',
  }), 'stale owner');
  assert.equal(resolveEditorStatus({
    ...common,
    layoutState: { pending: false, valid: false, message: 'invalid layout' },
  }), 'invalid layout');
  assert.equal(resolveEditorStatus({
    ...common,
    layoutState: { pending: true, valid: false, message: 'shaping' },
  }), 'shaping');
  assert.equal(resolveEditorStatus(common), 'large paste');
  assert.equal(resolveEditorStatus({
    ...common, pathologicalStatus: '',
  }), 'preview overflow');
  assert.equal(resolveEditorStatus({
    ...common,
    pathologicalStatus: '',
    previewOverflow: false,
    layoutState: { statuses: { overlap: 'overlap', contrast: 'contrast' } },
  }), 'overlap contrast');
});
