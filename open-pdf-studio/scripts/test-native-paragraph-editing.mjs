import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';

let executablePath;
try {
  await access(chromium.executablePath());
} catch {
  executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
}

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  await page.goto('http://127.0.0.1:3041', { waitUntil: 'domcontentloaded' });

  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { activateEditTextTool } = await import('/js/tools/text-edit-tool.js');

    const host = document.createElement('div');
    host.id = 'native-paragraph-test-host';
    Object.assign(host.style, {
      position: 'fixed', left: '20px', top: '20px', width: '700px', height: '400px',
      zIndex: '10000', background: '#fff',
    });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = 700;
    canvas.height = 400;
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '700px', height: '400px' });
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    layer.dataset.page = '1';
    Object.assign(layer.style, { position: 'absolute', inset: '0', width: '700px', height: '400px', transform: 'none' });
    host.append(canvas, layer);
    document.body.append(host);

    let operatorIndex = 0;
    const addSpan = (text, x, baseline, width, { sourceText = text, whitespace = false } = {}) => {
      const span = document.createElement('span');
      span.textContent = text;
      Object.assign(span.style, {
        position: 'absolute', left: `${x}px`, top: `${400 - baseline - 14}px`,
        width: `${width}px`, height: '18px', font: '16px / 18px Arial',
        color: 'transparent', transform: 'none',
      });
      span.dataset.pdfTransform = JSON.stringify([16, 0, 0, 16, x, baseline]);
      span.dataset.pdfWidth = String(width);
      span.dataset.pdfFontFamily = 'sans-serif';
      span.dataset.pdfFontName = 'LiberationSans';
      span.dataset.pdfActualFontName = 'Liberation Sans';
      span.dataset.pdfLoadedFontName = '';
      span.dataset.pdfBold = 'false';
      span.dataset.pdfItalic = 'false';
      if (whitespace) {
        span.dataset.ws = '1';
      } else {
        const source = [{
          markerId: `native-${operatorIndex}`,
          streamObjectId: '10 0 R',
          operatorIndex: operatorIndex++,
          decodedText: sourceText,
          eligibility: { eligible: true },
        }];
        span.dataset.nativeTextProvenance = JSON.stringify(source);
        span.dataset.nativeTextMarkerIds = source[0].markerId;
      }
      layer.appendChild(span);
      return span;
    };

    addSpan('Left cell', 20, 300, 70);
    addSpan('                     ', 91, 300, 200, { whitespace: true });
    const target = addSpan('Target first', 300, 300, 90, { sourceText: 'Target first ' });
    addSpan('(mixed)', 392, 300, 55);
    const right = addSpan('Right cell', 560, 300, 75);
    right.dataset.testRight = 'true';
    addSpan('Second paragraph line', 300, 280, 170);
    addSpan('Next row', 300, 245, 70);

    state.documents = [{
      id: 'native-paragraph-test-document', currentPage: 1, scale: 1, viewMode: 'single',
      annotations: [], selectedAnnotations: [], textEdits: [], undoStack: [], redoStack: [],
      pdfDoc: { numPages: 1, getPage: async () => ({
        getTextContent: async () => ({ items: [], styles: {} }),
        getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      }) }, pageDims: { 1: { widthPt: 700, heightPt: 400, rotation: 0 } },
    }];
    state.activeDocumentIndex = 0;
    state.currentTool = 'editText';
    activateEditTextTool();
    target.dataset.testTarget = 'true';
  });

  const target = page.locator('[data-test-target="true"]');
  await target.hover();
  assert.equal(await page.locator('.edit-text-paragraph-outline').count(), 1,
    'hovering one paragraph must render one union outline');
  const outline = await page.locator('.edit-text-paragraph-outline').boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(outline.height >= 38, `paragraph outline must cover both lines (${outline.height}px)`);
  assert.ok(outline.x <= targetBox.x && outline.x + outline.width < 540,
    'paragraph outline must not include the adjacent table cell');

  await target.click();
  const editor = page.locator('.pdf-text-editor');
  await editor.waitFor({ state: 'visible' });
  assert.equal((await editor.innerText()).replace(/\n\n/gu, '\n'),
    'Target first (mixed)\nSecond paragraph line');
  assert.equal(await page.locator('[role="dialog"]').filter({ hasText: 'source operators' }).count(), 0,
    'eligible visible text plus synthetic whitespace must not show an ambiguity modal');

  await editor.fill('Edited first line\nEdited second line');
  await editor.press('Control+Enter');
  await editor.waitFor({ state: 'detached' });

  const firstCommit = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const record = state.documents[0].textEdits[0];
    return {
      count: state.documents[0].textEdits.length,
      id: record.id,
      revision: record.revision,
      ownedLayerId: record.ownedLayerId,
      provenance: JSON.stringify(record.sourceProvenance),
      targetCount: document.querySelectorAll('[data-owned-text-edit-hit]').length,
      targetIds: [...document.querySelectorAll('[data-owned-text-edit-hit]')]
        .map((node) => node.dataset.editId),
    };
  });
  assert.equal(firstCommit.count, 1);
  assert.equal(firstCommit.revision, 1);
  assert.equal(firstCommit.targetCount, 2);
  assert.ok(firstCommit.targetIds.every((id) => id === firstCommit.id));

  const hitTargetState = await page.locator('[data-owned-text-edit-hit]').first().evaluate((node) => ({
    rect: node.getBoundingClientRect().toJSON(),
    pointerEvents: getComputedStyle(node).pointerEvents,
    editId: node.dataset.editId,
  }));
  assert.ok(hitTargetState.rect.width > 0 && hitTargetState.rect.height > 0);
  assert.equal(hitTargetState.pointerEvents, 'auto');
  await page.locator('[data-owned-text-edit-hit]').first().click({ force: true });
  await page.waitForTimeout(100);
  if (await editor.count() === 0) {
    const state = await page.evaluate(async () => {
      const { state } = await import('/js/core/state.ts');
      return {
        currentTool: state.currentTool,
        isEditingPdfText: state.isEditingPdfText,
        activeKind: state.pdfTextEditState?.kind || null,
        recordIds: state.documents[0].textEdits.map((record) => String(record.id)),
      };
    });
    throw new Error(`Owned line target did not reopen its record: ${JSON.stringify({ hitTargetState, state, pageErrors })}`);
  }
  await editor.waitFor({ state: 'visible' });
  await editor.fill('Re-edited first line\nRe-edited second line');
  await editor.press('Control+Enter');
  await editor.waitFor({ state: 'detached' });

  const secondCommit = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { richTextToPlainText } = await import('/js/text/rich-text.js');
    const record = state.documents[0].textEdits[0];
    return {
      count: state.documents[0].textEdits.length,
      id: record.id,
      revision: record.revision,
      ownedLayerId: record.ownedLayerId,
      provenance: JSON.stringify(record.sourceProvenance),
      text: richTextToPlainText(record.richText),
      lineCount: record.richText.lines.length,
    };
  });
  assert.equal(secondCommit.count, 1);
  assert.equal(secondCommit.id, firstCommit.id);
  assert.equal(secondCommit.ownedLayerId, firstCommit.ownedLayerId);
  assert.equal(secondCommit.provenance, firstCommit.provenance);
  assert.equal(secondCommit.revision, 2);
  assert.equal(secondCommit.text, 'Re-edited first line\nRe-edited second line');
  assert.equal(secondCommit.lineCount, 2);

  // Shift-drag on page whitespace selects box centers, draws individual and
  // union outlines, and Escape clears without opening an editor.
  await page.keyboard.down('Shift');
  await page.mouse.move(280, 80);
  await page.mouse.down();
  await page.mouse.move(670, 155, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  assert.ok(await page.locator('.edit-text-selection-box').count() >= 2);
  assert.equal(await page.locator('.edit-text-selection-union').count(), 1);
  const beforeEscapeTool = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return { tool: state.currentTool, editing: state.isEditingPdfText };
  });
  assert.deepEqual(beforeEscapeTool, { tool: 'editText', editing: true });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.edit-text-selection-box').count(), 0);

  // Shift-click combines an owned paragraph and an untouched native box. The
  // first owned record keeps its stable id and the set replacement is atomic.
  await page.keyboard.down('Shift');
  await page.locator('[data-owned-text-edit-hit]').first().click({ force: true });
  const afterOwnedSelection = await page.locator('.edit-text-selection-box').count();
  await page.locator('[data-test-right="true"]').click({ force: true });
  await page.keyboard.up('Shift');
  assert.equal(await page.locator('.edit-text-selection-box').count(), 2,
    `Shift selection failed: afterOwned=${afterOwnedSelection}; errors=${pageErrors.join(' | ')}`);
  assert.equal(await page.locator('.edit-text-selection-union').count(), 1);
  await page.keyboard.press('Enter');
  await editor.waitFor({ state: 'visible' });
  assert.match((await editor.innerText()).replace(/\n\n/gu, '\n'), /Re-edited first line[\s\S]*Right cell/u);
  await editor.fill('Combined paragraph one\nCombined paragraph two');
  await editor.press('Control+Enter');
  await editor.waitFor({ state: 'detached' });

  const mergedState = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { richTextToPlainText } = await import('/js/text/rich-text.js');
    const record = state.documents[0].textEdits[0];
    return { count: state.documents[0].textEdits.length, id: record.id,
      revision: record.revision, text: richTextToPlainText(record.richText),
      provenanceCount: record.sourceProvenance.length };
  });
  assert.equal(mergedState.count, 1);
  assert.equal(mergedState.id, firstCommit.id);
  assert.equal(mergedState.revision, 3);
  assert.equal(mergedState.text, 'Combined paragraph one\nCombined paragraph two');
  assert.ok(mergedState.provenanceCount > JSON.parse(firstCommit.provenance).length);

  await page.evaluate(async () => { const { undo } = await import('/js/core/undo-manager.js'); await undo(); });
  const undoText = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { richTextToPlainText } = await import('/js/text/rich-text.js');
    return richTextToPlainText(state.documents[0].textEdits[0].richText);
  });
  assert.equal(undoText, 'Re-edited first line\nRe-edited second line');
  await page.evaluate(async () => { const { redo } = await import('/js/core/undo-manager.js'); await redo(); });
  const redoText = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { richTextToPlainText } = await import('/js/text/rich-text.js');
    return richTextToPlainText(state.documents[0].textEdits[0].richText);
  });
  assert.equal(redoText, mergedState.text);

  await page.evaluate(async () => {
    const { injectSyntheticTextSpans } = await import('/js/text/text-layer.js');
    const host = document.getElementById('native-paragraph-test-host');
    host.querySelector('.textLayer').remove();
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    layer.dataset.page = '1';
    Object.assign(layer.style, { position: 'absolute', inset: '0', width: '700px', height: '400px', transform: 'none' });
    host.appendChild(layer);
    injectSyntheticTextSpans(layer, 1, 700, 400);
  });
  assert.equal(await page.locator('[data-owned-text-edit-hit]').count(), 2,
    'text-layer rebuild must recreate one hit region per canonical line');
  await page.locator('[data-owned-text-edit-hit]').last().click();
  await editor.waitFor({ state: 'visible' });
  assert.match((await editor.innerText()).replace(/\n\n/gu, '\n'), /Combined paragraph one\nCombined paragraph two/u);
  await editor.press('Escape');

  console.log('Native paragraph, multi-box merge, atomic undo, and stable re-edit targets test passed');
} finally {
  await browser.close();
}
