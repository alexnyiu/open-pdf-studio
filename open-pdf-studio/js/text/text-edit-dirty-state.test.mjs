import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRichTextDocument,
  createTextLine,
  createTextRun,
} from './rich-text.js';
import {
  createTextEditDirtyBaseline,
  textEditDraftIsDirty,
  textEditGeometryChanged,
} from './text-edit-dirty-state.js';
import { layoutExpandableNativeText } from './native-expandable-layout.js';

function richTextFixture() {
  return createRichTextDocument([
    createTextLine([
      createTextRun('First line', {
        faceId: 'liberation-sans-regular',
        size: 12,
        color: '#000000',
      }),
    ], {
      baseline: 40,
      baselineAdvance: 14.4,
      alignment: 'left',
    }),
    createTextLine([
      createTextRun('Second line', {
        faceId: 'liberation-sans-regular',
        size: 12,
        color: '#000000',
      }),
    ], {
      baseline: 25.6,
      baselineAdvance: 14.4,
      alignment: 'left',
    }),
  ], {
    x: 20,
    y: 20,
    width: 180,
    height: 40,
    baselineDirection: 'decreasing-y',
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('unchanged canonical rich-text draft remains clean without mutating its source', () => {
  const source = richTextFixture();
  const before = clone(source);
  const baseline = createTextEditDirtyBaseline({ text: 'First line\nSecond line', richText: source });
  const draft = clone(source);

  assert.equal(textEditDraftIsDirty(baseline, {
    text: 'First line\nSecond line',
    richText: draft,
  }), false);
  assert.deepEqual(source, before);
});

test('exact layout run coalescing does not dirty an unchanged native draft', async () => {
  const style = {
    faceId: 'liberation-sans-italic',
    size: 12,
    color: '#000000',
    italic: true,
  };
  const source = createRichTextDocument([
    createTextLine([
      createTextRun('ARCALYST-shaped source', style),
      createTextRun(' ', style),
    ], {
      baseline: 40,
      baselineAdvance: 14.4,
      alignment: 'left',
      breakAfter: 'hard',
    }),
  ], {
    x: 20,
    y: 20,
    width: 240,
    height: 30,
    baselineDirection: 'decreasing-y',
  });
  source.region = {
    baselineDirection: source.region.baselineDirection,
    height: source.region.height,
    rotation: source.region.rotation,
    width: source.region.width,
    x: source.region.x,
    y: source.region.y,
  };
  const baseline = createTextEditDirtyBaseline({
    text: 'ARCALYST-shaped source ',
    richText: source,
  });
  const layout = await layoutExpandableNativeText(source, {
    width: source.region.width,
    contentWidth: source.region.width,
    minimumHeight: source.region.height,
    anchorTop: source.region.y + source.region.height,
    manualLineBreaks: true,
    pageBounds: { x: 0, y: 0, width: 612, height: 792 },
  });

  assert.equal(source.lines[0].runs.length, 2);
  assert.deepEqual(Object.keys(source.region), [
    'baselineDirection', 'height', 'rotation', 'width', 'x', 'y',
  ]);
  assert.equal(layout.document.lines[0].runs.length, 1);
  assert.equal(textEditDraftIsDirty(baseline, {
    text: 'ARCALYST-shaped source ',
    richText: layout.document,
  }), false);
});

test('run-format-only changes make the draft dirty', () => {
  const source = richTextFixture();
  const baseline = createTextEditDirtyBaseline({ text: 'First line\nSecond line', richText: source });
  const draft = clone(source);
  Object.assign(draft.lines[0].runs[0], {
    faceId: 'liberation-sans-bold',
    bold: true,
    color: '#c00000',
  });

  assert.equal(textEditDraftIsDirty(baseline, {
    text: 'First line\nSecond line',
    richText: draft,
  }), true);
});

test('alignment-only paragraph formatting makes the draft dirty', () => {
  const source = richTextFixture();
  const baseline = createTextEditDirtyBaseline({ text: 'First line\nSecond line', richText: source });
  const draft = clone(source);
  draft.lines[0].alignment = 'right';

  assert.equal(textEditDraftIsDirty(baseline, {
    text: 'First line\nSecond line',
    richText: draft,
  }), true);
});

test('line-spacing-only paragraph formatting makes the draft dirty', () => {
  const source = richTextFixture();
  const baseline = createTextEditDirtyBaseline({ text: 'First line\nSecond line', richText: source });
  const draft = clone(source);
  draft.lines[1].baselineAdvance = 18;

  assert.equal(textEditDraftIsDirty(baseline, {
    text: 'First line\nSecond line',
    richText: draft,
  }), true);
});

test('authored hard and soft break changes make the draft dirty', () => {
  const source = richTextFixture();
  const baseline = createTextEditDirtyBaseline({ text: 'First line\nSecond line', richText: source });
  const draft = clone(source);
  draft.lines[0].breakAfter = 'soft';

  assert.equal(textEditDraftIsDirty(baseline, {
    text: 'First lineSecond line',
    richText: draft,
  }), true);
});

test('each canonical region coordinate and dimension participates in dirty state', () => {
  const source = richTextFixture();
  const baseline = createTextEditDirtyBaseline({ text: 'First line\nSecond line', richText: source });

  for (const key of ['x', 'y', 'width', 'height']) {
    const draft = clone(source);
    draft.region[key] += 1;
    assert.equal(textEditDraftIsDirty(baseline, {
      text: 'First line\nSecond line',
      richText: draft,
    }), true, `${key} must mark the draft dirty`);
  }
});

test('PDF-number round-trip noise stays clean while authored geometry changes remain dirty', () => {
  const source = richTextFixture();
  const baseline = createTextEditDirtyBaseline({
    text: 'First line\nSecond line',
    richText: source,
  });
  const roundTripped = clone(source);
  roundTripped.region.y += 1e-12;
  roundTripped.region.height += 1e-12;
  roundTripped.lines[0].baseline += 1e-12;
  roundTripped.lines[1].baselineAdvance += 1e-12;

  assert.equal(textEditDraftIsDirty(baseline, {
    text: 'First line\nSecond line',
    richText: roundTripped,
  }), false);
  assert.equal(textEditGeometryChanged(78.50439146800511, 78.50439146800522), false);
  assert.equal(textEditGeometryChanged(78.50439146800511, 78.50539146800511), true);
});

test('record-only geometry and legacy-style mutations make the draft dirty', () => {
  const record = {
    id: 'owned-1',
    page: 1,
    pdfX: 10,
    pdfY: 20,
    pdfWidth: 80,
    fontFamily: 'Helvetica',
  };
  const baseline = createTextEditDirtyBaseline({ text: 'Owned', record });
  const moved = clone(record);
  moved.pdfX += 1;
  assert.equal(textEditDraftIsDirty(baseline, { text: 'Owned', record: moved }), true);

  const formatted = clone(record);
  formatted.fontFamily = 'Courier';
  assert.equal(textEditDraftIsDirty(baseline, { text: 'Owned', record: formatted }), true);
});

test('textbox appearance-only draft changes remain observable until Apply', () => {
  const record = {
    id: 'textbox-1',
    type: 'textbox',
    fillColor: '#ffffff',
    strokeColor: '#000000',
    opacity: 1,
    borderStyle: 'solid',
  };
  const baseline = createTextEditDirtyBaseline({ text: 'Textbox', record });
  for (const [key, value] of [
    ['fillColor', '#ffeeaa'],
    ['strokeColor', '#c00000'],
    ['opacity', 0.5],
    ['borderStyle', 'dashed'],
  ]) {
    const draft = clone(record);
    draft[key] = value;
    assert.equal(textEditDraftIsDirty(baseline, { text: 'Textbox', record: draft }), true, key);
  }
});

test('OCR explicit style markers and layout-only height changes remain observable', () => {
  const baseline = createTextEditDirtyBaseline({ text: 'Recognized text' });
  assert.equal(textEditDraftIsDirty(baseline, {
    text: 'Recognized text',
    transientStyleChanged: true,
  }), true);
  assert.equal(textEditDraftIsDirty(baseline, {
    text: 'Recognized text',
    geometryChanged: true,
  }), true);
});
