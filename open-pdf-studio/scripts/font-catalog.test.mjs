import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import {
  PACKAGED_FONT_FACES,
  resolvePackagedFace,
  setPackagedFontAssetLoader,
  shapeOwnedTextEditForPersistence,
  shapeRichTextDocument,
  shapeTextRun,
  shapedRunCacheMetrics,
} from '../js/text/font-catalog.js';
import { richTextFromPlainText } from '../js/text/rich-text.js';

const assetRoot = new URL('../public/pdfjs/web/standard_fonts/', import.meta.url);
setPackagedFontAssetLoader((face) => readFile(fileURLToPath(new URL(face.fileName, assetRoot))));

test('packaged font catalog contains every supported face with valid checksums and glyph data', async () => {
  assert.equal(PACKAGED_FONT_FACES.length, 12);
  assert.equal(new Set(PACKAGED_FONT_FACES.map((face) => face.id)).size, 12);
  for (const face of PACKAGED_FONT_FACES) {
    const bytes = await readFile(fileURLToPath(new URL(face.fileName, assetRoot)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), face.sha256, face.fileName);
    const parsed = await fontkit.create(bytes);
    assert.ok(parsed.unitsPerEm > 0, face.fileName);
    assert.ok(parsed.glyphsForString('Open PDF Studio 123').every((glyph) => glyph.id !== 0), face.fileName);
    assert.equal(face.license, 'SIL Open Font License 1.1');
  }
  assert.equal(resolvePackagedFace('serif', true, true).id, 'liberation-serif-bold-italic');
  assert.equal(resolvePackagedFace('monospace', false, true).id, 'liberation-mono-italic');
});

test('packaged shaping supplies shared advances, glyphs, decoration metrics, and overflow rejection', async () => {
  const shaped = await shapeTextRun({
    text: 'Café Ελληνικά Привет',
    faceId: 'liberation-serif-bold-italic',
    size: 14,
    direction: 'ltr',
  });
  assert.ok(shaped.glyphs.length > 10);
  assert.ok(shaped.advance > 0);
  assert.ok(shaped.metrics.ascent > 0);
  assert.ok(shaped.metrics.underlineThickness > 0);
  assert.ok(shaped.metrics.strikeoutPosition > 0);
  const withoutSpace = await shapeTextRun({
    text: 'THIRDEDIT', faceId: 'liberation-mono-regular', size: 18, direction: 'ltr',
  });
  const withSpace = await shapeTextRun({
    text: 'THIRD EDIT', faceId: 'liberation-mono-regular', size: 18, direction: 'ltr',
  });
  assert.equal(withSpace.inkBounds.top, withoutSpace.inkBounds.top);
  assert.equal(withSpace.inkBounds.bottom, withoutSpace.inkBounds.bottom);

  const document = richTextFromPlainText('A deliberately overflowing line', {
    faceId: 'liberation-sans-regular',
    size: 18,
  }, { x: 0, y: 0, width: 20, height: 20, baseline: 16 });
  const layout = await shapeRichTextDocument(document);
  assert.equal(layout.overflow, true);
  assert.match(layout.rejectionReasons.join('; '), /overflows fixed region/u);

  const absoluteBaseline = richTextFromPlainText('Fits', {
    faceId: 'liberation-sans-regular', size: 12,
  }, { x: 0, y: 780, width: 100, height: 20, baseline: 792 });
  const absoluteLayout = await shapeRichTextDocument(absoluteBaseline);
  assert.equal(absoluteLayout.overflow, false);
  assert.ok(absoluteLayout.height < 20);

  await assert.rejects(
    shapeTextRun({ text: 'שלום', faceId: 'liberation-sans-regular', size: 12, direction: 'ltr' }),
    /Unsupported shaping or text direction/u,
  );
  await assert.rejects(
    shapeTextRun({ text: '🫠', faceId: 'liberation-sans-regular', size: 12, direction: 'ltr' }),
    /Missing glyph/u,
  );
});

test('concurrent same-run shaping retains one bounded LRU entry', async () => {
  const loader = (face) => readFile(fileURLToPath(new URL(face.fileName, assetRoot)));
  const run = {
    text: 'Concurrent packaged shaping must share one cache entry',
    faceId: 'liberation-sans-regular',
    size: 11,
    direction: 'ltr',
  };
  setPackagedFontAssetLoader(loader);
  await shapeTextRun(run);
  const single = shapedRunCacheMetrics();

  setPackagedFontAssetLoader(loader);
  const [left, right] = await Promise.all([shapeTextRun(run), shapeTextRun({ ...run })]);
  const concurrent = shapedRunCacheMetrics();
  assert.deepEqual(right, left);
  assert.equal(concurrent.entries, 1);
  assert.equal(concurrent.bytes, single.bytes,
    'a concurrent same-key miss must not double-count the retained bytes');
});

test('persistence accepts the exact worker-validated vector-text geometry', async () => {
  const draft = richTextFromPlainText('Exact persisted width', {
    faceId: 'liberation-sans-regular',
    size: 12,
  }, { x: 40, y: 700, width: 300, height: 40, baseline: 712 });
  const measured = await shapeRichTextDocument(draft, { antialiasMargin: 0 });
  const exact = {
    ...draft,
    region: {
      ...draft.region,
      width: measured.width,
      height: measured.height,
    },
  };

  const previewBounds = await shapeRichTextDocument(exact);
  const persistedBounds = await shapeOwnedTextEditForPersistence(exact);
  assert.equal(previewBounds.overflow, true,
    'raster preview padding should exceed an exactly fitted vector-text region');
  assert.equal(persistedBounds.overflow, false,
    'save-time validation must preserve the exact geometry accepted by the worker');
  assert.equal(persistedBounds.width, measured.width);
  assert.equal(persistedBounds.height, measured.height);
});
