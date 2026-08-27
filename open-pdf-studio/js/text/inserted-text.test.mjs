import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INSERTED_TEXT_DEFAULT_FONT_SIZE,
  createInsertedTextDraft,
} from './inserted-text.js';
import { projectTextEditRecord, richTextToPlainText } from './rich-text.js';
import { layoutExpandableNativeText } from './native-expandable-layout.js';

test('inserted text draft is runtime-only V2 content with packaged Liberation defaults', () => {
  const draft = createInsertedTextDraft({
    id: 'inserted-1', page: 1, x: 72, y: 96, pageWidth: 612, pageHeight: 792,
  });

  assert.equal(draft.schema, 'open-pdf-studio.text-edit-record');
  assert.equal(draft.version, 2);
  assert.equal(draft.original, null);
  assert.equal(draft.sourceProvenance, null);
  assert.equal(draft.substitution, null);
  assert.equal(draft.richText.lines[0].runs[0].faceId, 'liberation-sans-regular');
  assert.equal(draft.richText.lines[0].runs[0].size, INSERTED_TEXT_DEFAULT_FONT_SIZE);
  assert.equal(projectTextEditRecord(draft).newText, '');
  assert.equal(draft.richText.region.x, 72);
  assert.equal(draft.richText.lines[0].baseline, 696);
});

test('inserted text converts rotated display coordinates into canonical PDF geometry', () => {
  const draft = createInsertedTextDraft({
    id: 'inserted-rotated', page: 2, x: 100, y: 50,
    pageWidth: 600, pageHeight: 800, pageRotation: 90,
  });

  // 90-degree display point (100, 50) maps to unrotated (50, 700),
  // whose PDF baseline is 100 points from the bottom.
  assert.equal(draft.richText.region.x, 50);
  assert.equal(draft.richText.lines[0].baseline, 100);
});

test('inserted text clamps its complete initial edit region inside the page', () => {
  const draft = createInsertedTextDraft({
    id: 'inserted-edge', page: 1, x: 499, y: 999, pageWidth: 500, pageHeight: 700,
  });
  const { region } = draft.richText;

  assert.ok(region.x >= 0);
  assert.ok(region.y >= 0);
  assert.ok(region.x + region.width <= 500);
  assert.ok(region.y + region.height <= 700);
  assert.equal(region.width, 96);
});

test('inserted text rejects missing canonical page dimensions', () => {
  assert.throws(
    () => createInsertedTextDraft({ page: 1, x: 1, y: 1, pageWidth: 0, pageHeight: 792 }),
    /trustworthy page dimensions/u,
  );
});

test('inserted text re-edit can soft-wrap and grow without fixed-width rejection', async () => {
  const draft = createInsertedTextDraft({
    id: 'inserted-reedit', page: 1, x: 72, y: 300, pageWidth: 612, pageHeight: 792,
  });
  const authoredText = 'Inserted text grows through exact layout and keeps the complete canonical value.';
  draft.richText.lines[0].runs[0].text = authoredText;
  const result = await layoutExpandableNativeText(draft.richText, {
    width: draft.richText.region.width,
    minimumHeight: draft.richText.region.height,
    anchorTop: draft.richText.region.y + draft.richText.region.height,
    pageBounds: { x: 0, y: 0, width: 612, height: 792 },
    manualLineBreaks: false,
  });

  assert.equal(result.valid, true);
  assert.ok(result.document.lines.length > 1);
  assert.equal(richTextToPlainText(result.document), authoredText);
  assert.ok(result.document.region.height > draft.richText.region.height);
});
