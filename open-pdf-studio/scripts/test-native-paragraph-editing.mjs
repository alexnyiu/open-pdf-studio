import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPlaywrightFailureArtifacts } from './playwright-failure-artifacts.mjs';

let executablePath;
try {
  await access(chromium.executablePath());
} catch {
  executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(executablePath);
}

async function publishSyntheticPageReadiness(page) {
  const ready = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const {
      PAGE_EDIT_READY_LAYERS,
      capturePageEditReadinessIdentity,
      markPageEditLayerReady,
      pageEditReadinessSatisfied,
    } = await import('/js/pdf/page-edit-readiness.js');
    const documentState = state.documents[state.activeDocumentIndex];
    const readinessToken = capturePageEditReadinessIdentity(documentState, 1);
    for (const layerName of PAGE_EDIT_READY_LAYERS) {
      markPageEditLayerReady(documentState, 1, layerName, readinessToken);
    }
    return pageEditReadinessSatisfied(documentState, 1);
  });
  assert.equal(ready, true, 'the synthetic page must satisfy the production edit-readiness barrier');
}

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
let page;
let failureArtifacts;

try {
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  failureArtifacts = await startPlaywrightFailureArtifacts(page.context(), 'native-paragraph-editing');
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  await page.goto('http://127.0.0.1:3041', { waitUntil: 'domcontentloaded' });

  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { registerPageSurface } = await import('/js/pdf/page-surface-registry.js');
    const { captureTextLayerOwner, stampTextLayerOwner } = await import('/js/text/text-layer-lifecycle.js');
    const { activateEditTextTool } = await import('/js/tools/text-edit-tool.js');

    // This fixture owns its page geometry. Do not inherit the application's
    // blank-document viewport zoom when measuring the synthetic PDF canvas.
    window.__pdfViewport = null;

    document.getElementById('canvas-container')?.setAttribute('id', 'app-canvas-container');
    const host = document.createElement('div');
    host.id = 'canvas-container';
    host.dataset.nativeParagraphTestHost = 'true';
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
    const sameParagraphLine = addSpan('Second paragraph line', 300, 280, 170);
    sameParagraphLine.dataset.testSameParagraphLine = 'true';
    const nextParagraph = addSpan('Next row', 300, 245, 70);
    nextParagraph.dataset.testNextParagraph = 'true';

    state.documents = [{
      id: 'native-paragraph-test-document', lifecycleGeneration: 0,
      currentPage: 1, scale: 1, viewMode: 'single',
      annotations: [], selectedAnnotations: [], textEdits: [], undoStack: [], redoStack: [],
      pageEditReadiness: {},
      pdfDoc: { numPages: 1, getPage: async () => ({
        getTextContent: async () => ({ items: [], styles: {} }),
        getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      }) }, pageDims: { 1: { widthPt: 700, heightPt: 400, rotation: 0 } },
    }];
    state.activeDocumentIndex = 0;
    state.currentTool = 'editText';
    stampTextLayerOwner(layer, captureTextLayerOwner(state.documents[0], 1), 1);
    registerPageSurface({
      documentState: state.documents[0],
      pageNum: 1,
      container: host,
      baseSurface: canvas,
      geometryCanvas: canvas,
      textLayer: layer,
      canonicalPageDimensions: { width: 700, height: 400 },
      cssScale: 1,
      dpr: 1,
      surfaceKind: 'single-viewport',
    });
    activateEditTextTool();
    target.dataset.testTarget = 'true';
  });

  const target = page.locator('[data-test-target="true"]');
  await target.hover();
  assert.equal(await page.locator('.edit-text-paragraph-outline').count(), 1,
    'hovering one paragraph must render one union outline');
  const outline = await page.locator('.edit-text-paragraph-outline').boundingBox();
  const targetBox = await target.boundingBox();
  const initialGrouping = await page.evaluate(async () => {
    const { detectNativeColumnTracks, groupNativeTextFragments, nativeTextLinePieces } = await import('/js/text/native-text-blocks.js');
    const spans = [...document.querySelectorAll('[data-native-paragraph-test-host] .textLayer span[data-pdf-transform]')];
    const fragments = spans.map((span) => {
      const transform = JSON.parse(span.dataset.pdfTransform);
      return { text: span.textContent, sourceText: span.textContent,
        pdfX: transform[4], pdfY: transform[5], pdfWidth: Number(span.dataset.pdfWidth),
        fontSize: Math.hypot(transform[2], transform[3]), fontFamily: span.style.fontFamily };
    });
    return {
      tracks: detectNativeColumnTracks(fragments),
      blocks: groupNativeTextFragments(fragments)
        .map((block) => ({ columnId: block.columnId,
          lines: block.lines.map((line) => nativeTextLinePieces(line).map((piece) => piece.text).join('')) })),
    };
  });
  assert.ok(outline.height >= 38,
    `paragraph outline must cover both lines (${outline.height}px): ${JSON.stringify(initialGrouping)}`);
  assert.ok(outline.x <= targetBox.x && outline.x + outline.width < 540,
    'paragraph outline must not include the adjacent table cell');

  await publishSyntheticPageReadiness(page);
  await target.click();
  const editor = page.locator('.pdf-text-editor');
  await editor.waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const host = document.querySelector('.pdf-text-editor')?.closest('.pdf-text-edit-layer');
    return host?.dataset.page === '1'
      && host?.dataset.documentId === 'native-paragraph-test-document';
  });
  const pageLocalState = await editor.evaluate((node) => ({
    editorPosition: getComputedStyle(node).position,
    portalPosition: getComputedStyle(node.closest('.pdf-text-edit-portal')).position,
    hostPage: node.closest('.pdf-text-edit-layer')?.dataset.page || null,
    hostDocument: node.closest('.pdf-text-edit-layer')?.dataset.documentId || null,
    boxShadow: getComputedStyle(node).boxShadow,
  }));
  assert.equal(pageLocalState.editorPosition, 'absolute');
  assert.equal(pageLocalState.portalPosition, 'absolute');
  assert.equal(pageLocalState.hostPage, '1');
  assert.equal(pageLocalState.hostDocument, 'native-paragraph-test-document');
  assert.equal(pageLocalState.boxShadow, 'none');
  await page.waitForFunction(() => {
    const activeEditor = document.querySelector('.pdf-text-editor');
    return activeEditor && document.activeElement === activeEditor;
  });
  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { registerPageSurface } = await import('/js/pdf/page-surface-registry.js');
    const previous = document.getElementById('canvas-container');
    previous.id = 'retired-native-page-container';
    const replacement = document.createElement('div');
    replacement.id = 'canvas-container';
    replacement.dataset.nativeParagraphTestHost = 'true';
    replacement.style.cssText = previous.style.cssText;
    for (const child of [...previous.children]) {
      if (!child.classList.contains('pdf-text-edit-layer')) replacement.appendChild(child);
    }
    previous.after(replacement);
    registerPageSurface({
      documentState: state.documents[state.activeDocumentIndex],
      pageNum: 1,
      container: replacement,
      baseSurface: replacement.querySelector('.pdf-canvas'),
      geometryCanvas: replacement.querySelector('.pdf-canvas'),
      textLayer: replacement.querySelector('.textLayer'),
      canonicalPageDimensions: { width: 700, height: 400 },
      cssScale: 1,
      dpr: 1,
      surfaceKind: 'single-viewport',
    });
  });
  await page.waitForFunction(() => (
    document.querySelector('.pdf-text-editor')?.closest('.pdf-text-edit-layer')?.parentElement?.id
      === 'canvas-container'
  ));
  try {
    await page.waitForFunction(() => {
      const activeEditor = document.querySelector('.pdf-text-editor');
      return activeEditor && document.activeElement === activeEditor;
    }, null, {
      timeout: 5_000,
    });
  } catch (error) {
    const focusState = await page.evaluate(() => ({
      activeTag: document.activeElement?.tagName || null,
      activeClass: document.activeElement?.className || null,
      editorConnected: document.querySelector('.pdf-text-editor')?.isConnected === true,
      editorParent: document.querySelector('.pdf-text-editor')
        ?.closest('.pdf-text-edit-layer')?.parentElement?.id || null,
      placement: window.__pdfTextEditPlacementDebug || null,
    }));
    throw new Error(`page-container replacement did not preserve editor focus: ${JSON.stringify(focusState)}`, {
      cause: error,
    });
  }
  await page.evaluate(() => document.getElementById('retired-native-page-container')?.remove());
  assert.equal(await target.evaluate((node) => node.style.visibility), 'hidden',
    'owned source spans must be hidden before the rich editor is painted');
  assert.equal((await editor.innerText()).replace(/\n\n/gu, '\n').replace(/[ \t]+\n/gu, '\n'),
    'Target first (mixed)\nSecond paragraph line');
  assert.equal(await page.locator('[role="dialog"]').filter({ hasText: 'source operators' }).count(), 0,
    'eligible visible text plus synthetic whitespace must not show an ambiguity modal');

  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  const moveHandle = page.getByRole('button', { name: 'Move text box' });
  const resizeHandle = page.getByRole('button', { name: 'Resize text box' });
  assert.equal(await moveHandle.count(), 1, 'native text box must expose one move handle');
  assert.equal(await resizeHandle.count(), 1, 'native text box must expose one corner resize handle');
  const beforeResize = await editor.boundingBox();
  const beforeResizeMinimumHeight = await page.evaluate(async () => (
    (await import('/js/solid/stores/pdfTextEditStore.js'))
      .editorOptions().expandableRegion.minimumHeight
  ));
  const resizeBox = await resizeHandle.boundingBox();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 36, resizeBox.y + resizeBox.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  const afterResize = await editor.boundingBox();
  const resizeState = await page.evaluate(async () => {
    const store = await import('/js/solid/stores/pdfTextEditStore.js');
    return {
      placement: store.editorPlacement(),
      options: store.editorOptions().expandableRegion,
    };
  });
  assert.ok(afterResize.width > beforeResize.width + 30,
    `dragging the corner must widen the canonical native text box (${beforeResize.width} -> ${afterResize.width})`);
  assert.ok(resizeState.options.minimumHeight > beforeResizeMinimumHeight + 8,
    'dragging the corner must increase the canonical native text box minimum height');
  assert.ok(afterResize.height > beforeResize.height + 8,
    `dragging the corner must increase the native text box minimum height (${beforeResize.height} -> ${afterResize.height}): ${JSON.stringify(resizeState)}`);

  const moveBox = await moveHandle.boundingBox();
  await page.mouse.move(moveBox.x + moveBox.width / 2, moveBox.y + moveBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(moveBox.x + moveBox.width / 2 - 28, moveBox.y + moveBox.height / 2 + 16, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const afterMove = await editor.boundingBox();
  assert.ok(Math.abs(afterMove.x - afterResize.x + 28) < 1.5,
    'dragging the move handle must relocate the text box horizontally');
  assert.ok(Math.abs(afterMove.y - afterResize.y - 16) < 1.5,
    'dragging the move handle must relocate the text box vertically');
  assert.equal(await editor.evaluate((node) => document.activeElement === node), true,
    'moving or resizing must restore editor focus');

  const originalEditorBox = await editor.boundingBox();
  const immutableMinimumHeight = await page.evaluate(async () => {
    const { editorOptions } = await import('/js/solid/stores/pdfTextEditStore.js');
    return editorOptions().expandableRegion.minimumHeight;
  });
  await editor.fill('This native paragraph is intentionally extended on one authored line and must not wrap automatically.');
  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  await page.waitForFunction((minimumWidth) => {
    const node = document.querySelector('.pdf-text-editor');
    if (!node) return false;
    return node.getBoundingClientRect().width > minimumWidth + 10
      && node.scrollWidth <= node.clientWidth + 2;
  }, originalEditorBox.width);
  const overlongEditorState = await editor.evaluate((node) => ({
    rect: node.getBoundingClientRect().toJSON(),
    overflow: getComputedStyle(node).overflow,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  const overlongLayout = await page.evaluate(async () => {
    const bridge = await import('/js/bridge.ts');
    const state = bridge.getPdfEditorLayoutState();
    return {
      valid: state?.valid,
      message: state?.message,
      lineCount: state?.result?.document?.lines?.length,
      breaks: state?.result?.document?.lines?.map((line) => line.breakAfter),
      manualLineBreaks: (await import('/js/solid/stores/pdfTextEditStore.js'))
        .editorOptions().expandableRegion?.manualLineBreaks,
    };
  });
  assert.equal(overlongLayout.lineCount, 1,
    'typing an overlong line must not create generated editor lines');
  assert.equal(overlongLayout.manualLineBreaks, true,
    'the native editor must use manual-line mode');
  assert.equal(overlongLayout.valid, false,
    'an overlong manual line must remain visible but uncommittable');
  assert.match(overlongLayout.message, /press Enter/i);
  assert.ok(overlongEditorState.rect.width > originalEditorBox.width,
    'the live text-box outline must expand to contain an overlong line');
  assert.equal(overlongEditorState.overflow, 'visible');
  assert.ok(overlongEditorState.scrollWidth <= overlongEditorState.clientWidth + 2,
    'the expanded text box must contain the complete authored line');
  assert.ok(overlongEditorState.scrollHeight <= overlongEditorState.clientHeight + 2,
    'the manual-line editor must not hide text behind an internal scrollbar');

  await editor.fill('First short line\nSecond short line\nThird short line\nFourth short line');
  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  await page.waitForFunction((minimumHeight) => {
    const node = document.querySelector('.pdf-text-editor');
    if (!node) return false;
    return node.getBoundingClientRect().height > minimumHeight + 10
      && node.scrollHeight <= node.clientHeight + 2;
  }, originalEditorBox.height);
  const grownEditorState = await editor.evaluate((node) => ({
    rect: node.getBoundingClientRect().toJSON(),
    overflow: getComputedStyle(node).overflow,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }));
  const grownLayoutState = await page.evaluate(async () => {
    const bridge = await import('/js/bridge.ts');
    const state = bridge.getPdfEditorLayoutState();
    return {
      valid: state?.valid,
      message: state?.message,
      requiredHeight: state?.result?.requiredHeight,
      lines: bridge.getPdfEditorRichText()?.lines?.map((line) => ({
        text: line.runs.map((run) => run.text).join(''),
        baselineAdvance: line.baselineAdvance,
      })),
    };
  });
  assert.ok(grownEditorState.rect.height > originalEditorBox.height,
    `native editor must grow downward after explicit Enter lines: ${JSON.stringify({ originalEditorBox, grownEditorState, grownLayoutState })}`);
  assert.ok(Math.abs(grownEditorState.rect.width - originalEditorBox.width) < 1,
    'short manual lines must retain the original text-box width');
  assert.equal(grownEditorState.overflow, 'visible');
  assert.ok(grownEditorState.scrollHeight <= grownEditorState.clientHeight + 2,
    'grown native editor must not hide text behind an internal scrollbar');

  await editor.fill('Edited first line');
  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  await page.waitForFunction((maximumHeight) => (
    (document.querySelector('.pdf-text-editor')?.getBoundingClientRect().height || Infinity)
      < maximumHeight
  ), grownEditorState.rect.height);
  const shrunkenEditorBox = await editor.boundingBox();
  assert.ok(shrunkenEditorBox.height < grownEditorState.rect.height,
    'deleting text must shrink the editor after exact layout');
  assert.ok(shrunkenEditorBox.height + 0.5 >= immutableMinimumHeight,
    `native editor must never shrink below its immutable original height (${shrunkenEditorBox.height} < ${immutableMinimumHeight})`);
  await editor.press('Enter');
  await page.keyboard.type('Edited second line');
  assert.equal(await editor.evaluate((node) => document.activeElement === node), true,
    'native editor must retain focus while exact layout revisions settle');
  await editor.press('Control+Enter');
  try {
    await editor.waitFor({ state: 'detached' });
  } catch (error) {
    const commitState = await page.evaluate(async () => {
      const bridge = await import('/js/bridge.ts');
      const sessions = await import('/js/text/text-edit-session.js');
      const richText = await import('/js/text/rich-text.js');
      const node = document.querySelector('.pdf-text-editor');
      const layout = bridge.getPdfEditorLayoutState();
      const draft = bridge.getPdfEditorRichText();
      return {
        layout,
        draftRegion: draft?.region || null,
        draftHash: draft ? richText.canonicalRichTextHash(draft) : null,
        validatedHash: layout?.result?.document
          ? richText.canonicalRichTextHash(layout.result.document) : null,
        status: document.getElementById('native-text-edit-status')?.textContent || '',
        text: bridge.getPdfEditorText(),
        activeSession: sessions.getActiveTextEditSession(),
        className: node?.className || '',
      };
    });
    throw new Error(`native editor did not Apply: ${JSON.stringify(commitState)}`, { cause: error });
  }

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
      region: { ...record.richText.region },
    };
  });
  assert.equal(firstCommit.count, 1);
  assert.equal(firstCommit.revision, 1);
  assert.equal(firstCommit.targetCount, 2);
  assert.ok(firstCommit.targetIds.every((id) => id === firstCommit.id));
  assert.ok(firstCommit.region.width > beforeResize.width,
    'committed native record must retain the resized width');

  // Reopen the owned multiline record, insert in the middle of a word, and
  // commit by clicking blank page space. The click-away must end the session
  // without replaying the page-wide text layer as another edit request.
  await publishSyntheticPageReadiness(page);
  await page.locator('[data-owned-text-edit-hit]').first().click({ force: true });
  await editor.waitFor({ state: 'visible' });
  await editor.evaluate((node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode && !textNode.textContent.includes('Edited')) textNode = walker.nextNode();
    if (!textNode) throw new Error('middle-insertion source word was not rendered');
    const offset = textNode.textContent.indexOf('Edited') + 3;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(textNode, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type('MIDDLE');
  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  const beforeClickAway = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const session = (await import('/js/text/text-edit-session.js')).getActiveTextEditSession();
    return {
      revision: state.documents[0].textEdits[0].revision,
      undoCount: state.documents[0].undoStack.length,
      sessionId: session?.sessionId || null,
      targetIdentity: session?.targetIdentity || null,
    };
  });
  assert.equal(beforeClickAway.targetIdentity?.type, 'owned-record');
  assert.equal(beforeClickAway.targetIdentity?.recordId, firstCommit.id);
  const blankLayerBox = await page.locator('[data-native-paragraph-test-host] .textLayer').boundingBox();
  await page.mouse.click(blankLayerBox.x + blankLayerBox.width - 10,
    blankLayerBox.y + blankLayerBox.height - 10);
  await editor.waitFor({ state: 'detached' });
  await page.waitForFunction(async () => (
    (await import('/js/text/text-edit-session.js')).getActiveTextEditSession() === null
  ));
  const middleCommit = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { richTextToPlainText } = await import('/js/text/rich-text.js');
    const record = state.documents[0].textEdits[0];
    return {
      count: state.documents[0].textEdits.length,
      revision: record.revision,
      undoCount: state.documents[0].undoStack.length,
      text: richTextToPlainText(record.richText),
      activeSession: (await import('/js/text/text-edit-session.js')).getActiveTextEditSession(),
    };
  });
  assert.equal(middleCommit.count, 1);
  assert.equal(middleCommit.revision, beforeClickAway.revision + 1);
  assert.equal(middleCommit.undoCount, beforeClickAway.undoCount + 1);
  assert.match(middleCommit.text, /EdiMIDDLEted first line/u);
  assert.equal(middleCommit.activeSession, null);

  // A pointer captured on another rendered line of that same owned record
  // commits the current draft but must not create a replacement session.
  await publishSyntheticPageReadiness(page);
  await page.locator('[data-owned-text-edit-hit]').first().click({ force: true });
  await editor.waitFor({ state: 'visible' });
  await editor.press('End');
  await page.keyboard.type(' SAME');
  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  const beforeSameRecordClick = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return {
      revision: state.documents[0].textEdits[0].revision,
      undoCount: state.documents[0].undoStack.length,
    };
  });
  await page.locator('[data-owned-text-edit-hit]').last().evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, pointerId: 41,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    };
    node.dispatchEvent(new PointerEvent('pointerdown', init));
    node.dispatchEvent(new PointerEvent('pointerup', init));
  });
  await editor.waitFor({ state: 'detached' });
  await page.waitForFunction(async () => (
    (await import('/js/text/text-edit-session.js')).getActiveTextEditSession() === null
  ));
  const sameRecordClick = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { richTextToPlainText } = await import('/js/text/rich-text.js');
    return {
      count: state.documents[0].textEdits.length,
      id: state.documents[0].textEdits[0].id,
      revision: state.documents[0].textEdits[0].revision,
      undoCount: state.documents[0].undoStack.length,
      text: richTextToPlainText(state.documents[0].textEdits[0].richText),
    };
  });
  assert.equal(sameRecordClick.count, 1);
  assert.equal(sameRecordClick.id, firstCommit.id);
  assert.equal(sameRecordClick.revision, beforeSameRecordClick.revision + 1);
  assert.equal(sameRecordClick.undoCount, beforeSameRecordClick.undoCount + 1);
  assert.match(sameRecordClick.text, /EdiMIDDLEted first line/u);
  assert.match(sameRecordClick.text, /SAME/u);

  // A different paragraph remains a one-gesture handoff: commit the owned
  // paragraph, then replay exactly once into the distinct native target.
  await publishSyntheticPageReadiness(page);
  await page.locator('[data-owned-text-edit-hit]').first().click({ force: true });
  await editor.waitFor({ state: 'visible' });
  await editor.press('Home');
  await editor.press('Delete');
  await page.keyboard.type('X');
  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  const sourceSessionId = await page.evaluate(async () => (
    (await import('/js/text/text-edit-session.js')).getActiveTextEditSession()?.sessionId
  ));
  const beforeDifferentParagraphClick = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return {
      revision: state.documents[0].textEdits[0].revision,
      undoCount: state.documents[0].undoStack.length,
    };
  });
  await page.locator('[data-test-next-paragraph="true"]').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const init = {
      bubbles: true, cancelable: true, pointerId: 42,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    };
    node.dispatchEvent(new PointerEvent('pointerdown', init));
    node.dispatchEvent(new PointerEvent('pointerup', init));
  });
  // The synthetic fixture has no renderer to republish page readiness after
  // the owned commit invalidates its text layer. Model that production render
  // completion so the queued, distinct target can activate.
  await page.waitForTimeout(50);
  await publishSyntheticPageReadiness(page);
  try {
    await page.waitForFunction(() => (
      document.querySelector('.pdf-text-editor')?.textContent.includes('Next row') === true
    ));
  } catch (error) {
    const replayState = await page.evaluate(async () => {
      const { state } = await import('/js/core/state.ts');
      const session = (await import('/js/text/text-edit-session.js')).getActiveTextEditSession();
      return {
        editorText: document.querySelector('.pdf-text-editor')?.textContent || null,
        activeSession: session,
        recordCount: state.documents[0].textEdits.length,
        recordRevision: state.documents[0].textEdits[0]?.revision,
        nextParagraphConnected: document.querySelector('[data-test-next-paragraph="true"]')
          ?.isConnected === true,
        nextParagraphVisibility: document.querySelector('[data-test-next-paragraph="true"]')
          ?.style.visibility || null,
      };
    });
    throw new Error(`different-paragraph replay did not open: ${JSON.stringify({ replayState, pageErrors })}`, {
      cause: error,
    });
  }
  const differentParagraphState = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return {
      activeSession: (await import('/js/text/text-edit-session.js')).getActiveTextEditSession(),
      revision: state.documents[0].textEdits[0].revision,
      undoCount: state.documents[0].undoStack.length,
    };
  });
  const differentParagraphSession = differentParagraphState.activeSession;
  assert.notEqual(differentParagraphSession?.sessionId, sourceSessionId);
  assert.equal(differentParagraphSession?.targetIdentity?.type, 'native-provenance');
  assert.equal(differentParagraphState.revision, beforeDifferentParagraphClick.revision + 1);
  assert.equal(differentParagraphState.undoCount, beforeDifferentParagraphClick.undoCount + 1);
  await editor.waitFor({ state: 'visible' });
  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  assert.match(await editor.innerText(), /Next row/u);
  await editor.press('Escape');
  await editor.waitFor({ state: 'detached' });

  const hitTargetState = await page.locator('[data-owned-text-edit-hit]').first().evaluate((node) => ({
    rect: node.getBoundingClientRect().toJSON(),
    pointerEvents: getComputedStyle(node).pointerEvents,
    editId: node.dataset.editId,
  }));
  assert.ok(hitTargetState.rect.width > 0 && hitTargetState.rect.height > 0);
  assert.equal(hitTargetState.pointerEvents, 'auto');
  await publishSyntheticPageReadiness(page);
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
  await editor.fill('Re-edited first line');
  await editor.press('Enter');
  await page.keyboard.type('Re-edited second line');
  await page.keyboard.press('Control+Enter');
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
  assert.equal(secondCommit.revision, 5,
    JSON.stringify({ firstCommit, middleCommit, sameRecordClick, secondCommit }));
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
  await publishSyntheticPageReadiness(page);
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
  const combinedDraft = (await editor.innerText()).replace(/\n\n/gu, '\n');
  assert.match(combinedDraft, /Re-edited first line/u);
  assert.match(combinedDraft, /Right cell/u);
  await editor.fill('Combined paragraph one');
  await page.waitForFunction(async (expected) => {
    const { getEditorText } = await import('/js/solid/stores/pdfTextEditStore.js');
    return getEditorText() === expected;
  }, 'Combined paragraph one');
  await editor.press('Enter');
  await editor.pressSequentially('Combined paragraph two');
  await page.waitForFunction(async (expected) => {
    const { getEditorText } = await import('/js/solid/stores/pdfTextEditStore.js');
    return getEditorText() === expected;
  }, 'Combined paragraph one\nCombined paragraph two');
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
  assert.equal(mergedState.revision, 6);
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
    const { state } = await import('/js/core/state.ts');
    const { registerPageSurface } = await import('/js/pdf/page-surface-registry.js');
    const { injectSyntheticTextSpans } = await import('/js/text/text-layer.js');
    const { captureTextLayerOwner, stampTextLayerOwner } = await import('/js/text/text-layer-lifecycle.js');
    const { activateEditTextTool } = await import('/js/tools/text-edit-tool.js');
    const host = document.querySelector('[data-native-paragraph-test-host]');
    host.querySelector('.textLayer').remove();
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    layer.dataset.page = '1';
    Object.assign(layer.style, { position: 'absolute', inset: '0', width: '700px', height: '400px', transform: 'none' });
    host.appendChild(layer);
    stampTextLayerOwner(layer, captureTextLayerOwner(state.documents[0], 1), 2);
    registerPageSurface({
      documentState: state.documents[0],
      pageNum: 1,
      container: host,
      baseSurface: host.querySelector('.pdf-canvas'),
      geometryCanvas: host.querySelector('.pdf-canvas'),
      textLayer: layer,
      canonicalPageDimensions: { width: 700, height: 400 },
      cssScale: 1,
      dpr: 1,
      surfaceKind: 'single-viewport',
    });
    injectSyntheticTextSpans(layer, 1, 700, 400);
    activateEditTextTool();
  });
  assert.equal(await page.locator('[data-owned-text-edit-hit]').count(), 2,
    'text-layer rebuild must recreate one hit region per canonical line');
  await publishSyntheticPageReadiness(page);
  await page.locator('[data-owned-text-edit-hit]').last().click();
  await editor.waitFor({ state: 'visible' });
  assert.match((await editor.innerText()).replace(/\n\n/gu, '\n'), /Combined paragraph one\nCombined paragraph two/u);
  await editor.press('Escape');

  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    const { registerPageSurface } = await import('/js/pdf/page-surface-registry.js');
    const { captureTextLayerOwner, stampTextLayerOwner } = await import('/js/text/text-layer-lifecycle.js');
    const { activateEditTextTool } = await import('/js/tools/text-edit-tool.js');
    document.querySelector('[data-native-paragraph-test-host]')?.remove();
    const host = document.createElement('div');
    host.id = 'canvas-container';
    host.dataset.nativeSideBySideTestHost = 'true';
    Object.assign(host.style, {
      position: 'fixed', left: '20px', top: '20px', width: '700px', height: '420px',
      zIndex: '10000', background: '#fff',
    });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = 700;
    canvas.height = 420;
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '700px', height: '420px' });
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 700, 420);
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    layer.dataset.page = '1';
    Object.assign(layer.style, { position: 'absolute', inset: '0', width: '700px', height: '420px', transform: 'none' });
    host.append(canvas, layer);
    document.body.append(host);

    let operatorIndex = 0;
    const addSpan = (text, x, baseline, width, color, size = 12, testId = '') => {
      context.fillStyle = color;
      context.font = `${size}px Arial`;
      context.fillText(text, x, 420 - baseline);
      const span = document.createElement('span');
      span.textContent = text;
      Object.assign(span.style, {
        position: 'absolute', left: `${x}px`, top: `${420 - baseline - size}px`,
        width: `${width}px`, height: `${size}px`, font: `${size}px / ${size}px Arial`,
        color: 'transparent', transform: 'none',
      });
      span.dataset.pdfTransform = JSON.stringify([size, 0, 0, size, x, baseline]);
      span.dataset.pdfWidth = String(width);
      span.dataset.pdfFontFamily = 'sans-serif';
      span.dataset.pdfFontName = 'LiberationSans';
      span.dataset.pdfActualFontName = 'Liberation Sans';
      span.dataset.pdfLoadedFontName = '';
      span.dataset.pdfBold = 'false';
      span.dataset.pdfItalic = 'false';
      if (testId) span.dataset[testId] = 'true';
      const source = [{
        markerId: `side-${operatorIndex}`,
        streamObjectId: '20 0 R',
        operatorIndex: operatorIndex++,
        decodedText: text,
        eligibility: { eligible: true },
      }];
      span.dataset.nativeTextProvenance = JSON.stringify(source);
      span.dataset.nativeTextMarkerIds = source[0].markerId;
      layer.appendChild(span);
      return span;
    };

    addSpan('LEFT HEADING', 20, 340, 90, '#0057a8', 10);
    addSpan('RIGHT HEADING', 320, 340, 100, '#0057a8', 10);
    addSpan('Left paragraph first line', 20, 320, 275, '#111111', 12, 'sideLeft');
    addSpan('and colored ', 20, 304, 100, '#111111', 12);
    addSpan('blue', 120, 304, 40, '#0057a8', 12);
    addSpan(' gray ', 160, 304, 60, '#666666', 6.8);
    addSpan('pale', 220, 304, 50, '#f4f4f4', 6.8);
    addSpan('left paragraph final line.', 20, 288, 210, '#111111', 12);
    addSpan('Right paragraph first line', 320, 320, 250, '#111111', 12, 'sideRight');
    addSpan('right paragraph second line', 320, 304, 245, '#111111');
    addSpan('right paragraph third line', 320, 288, 240, '#666666');
    addSpan('right paragraph fourth line', 320, 272, 250, '#111111');
    addSpan('right paragraph final line.', 320, 256, 210, '#111111');

    state.documents = [{
      id: 'native-side-by-side-document', lifecycleGeneration: 0,
      currentPage: 1, scale: 1, viewMode: 'single',
      annotations: [], selectedAnnotations: [], textEdits: [], undoStack: [], redoStack: [],
      pageEditReadiness: {},
      pdfDoc: { numPages: 1, getPage: async () => ({
        getTextContent: async () => ({ items: [], styles: {} }),
        getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      }) }, pageDims: { 1: { widthPt: 700, heightPt: 420, rotation: 0 } },
    }];
    state.activeDocumentIndex = 0;
    state.currentTool = 'editText';
    stampTextLayerOwner(layer, captureTextLayerOwner(state.documents[0], 1), 1);
    registerPageSurface({
      documentState: state.documents[0],
      pageNum: 1,
      container: host,
      baseSurface: canvas,
      geometryCanvas: canvas,
      textLayer: layer,
      canonicalPageDimensions: { width: 700, height: 420 },
      cssScale: 1,
      dpr: 1,
      surfaceKind: 'single-viewport',
    });
    activateEditTextTool();
  });

  const leftTarget = page.locator('[data-side-left="true"]');
  const rightTarget = page.locator('[data-side-right="true"]');
  await leftTarget.hover();
  const leftOutline = await page.locator('.edit-text-paragraph-outline').boundingBox();
  const rightTargetBox = await rightTarget.boundingBox();
  assert.ok(leftOutline.x + leftOutline.width < rightTargetBox.x,
    'side-by-side paragraph outline must stop before the neighboring column');
  await publishSyntheticPageReadiness(page);
  await leftTarget.click();
  await editor.waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const host = document.querySelector('.pdf-text-editor')?.closest('.pdf-text-edit-layer');
    return host?.dataset.page === '1'
      && host?.dataset.documentId === 'native-side-by-side-document';
  });
  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  assert.match(await editor.innerText(), /Left paragraph first line/u);
  assert.doesNotMatch(await editor.innerText(), /Right paragraph/u);
  const sideEditorBox = await editor.boundingBox();
  assert.ok(sideEditorBox.x + sideEditorBox.width < rightTargetBox.x,
    'native editor width must remain inside its inferred column');
  const colorState = await editor.evaluate((node) => [...node.querySelectorAll('[data-rich-run]')]
    .map((run) => ({ text: run.textContent, color: run.dataset.color,
      size: Number(run.dataset.size),
      contrastAid: run.dataset.contrastAid,
      textShadow: getComputedStyle(run).textShadow,
      backgroundColor: getComputedStyle(run).backgroundColor })));
  assert.ok(colorState.some((run) => run.color === '#0057a8' && run.text.includes('blue')),
    `blue mixed-format run was not retained: ${JSON.stringify(colorState)}`);
  const grayRunState = colorState.find((run) => run.text.includes('gray'));
  assert.equal(grayRunState?.size, 6.8,
    `small gray mixed-format run was not retained: ${JSON.stringify(colorState)}`);
  assert.notEqual(grayRunState?.color, '#000000');
  assert.ok(colorState.every((run) => run.textShadow === 'none'),
    `no native editing run may use a blurring text shadow: ${JSON.stringify(colorState)}`);
  const paleRun = colorState.find((run) => run.color === '#f4f4f4');
  assert.equal(paleRun?.contrastAid, 'true');
  assert.equal(paleRun?.textShadow, 'none');
  assert.equal(paleRun?.backgroundColor, 'rgb(0, 0, 0)');
  assert.match((await page.locator('#native-text-edit-status').innerText()), /editing-only backing/u);
  const inkContainment = await page.evaluate(async () => {
    const bridge = await import('/js/bridge.ts');
    const result = bridge.getPdfEditorLayoutState()?.result;
    return {
      editorBounds: result?.editorBounds,
      lineInkBounds: result?.lineInkBounds,
      contentWidth: result?.contentWidth,
    };
  });
  assert.ok(inkContainment.contentWidth > 0);
  assert.ok(inkContainment.lineInkBounds.every((bounds) => (
    bounds.x >= inkContainment.editorBounds.x - 1e-6
      && bounds.x + bounds.width
        <= inkContainment.editorBounds.x + inkContainment.editorBounds.width + 1e-6
  )), `shaped glyph ink escaped the native editor: ${JSON.stringify(inkContainment)}`);
  const scrollContainment = await editor.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }));
  assert.ok(scrollContainment.scrollWidth <= scrollContainment.clientWidth + 1,
    `native editor has horizontal overflow: ${JSON.stringify(scrollContainment)}`);
  assert.ok(scrollContainment.scrollHeight <= scrollContainment.clientHeight + 2,
    `native editor has hidden vertical overflow: ${JSON.stringify(scrollContainment)}`);

  await editor.locator('[data-color="#0057a8"]').filter({ hasText: 'blue' }).evaluate((run) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(run.firstChild, run.firstChild.textContent.length);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type('X');
  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  const typedColor = await page.evaluate(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorRichText().lines.flatMap((line) => line.runs)
      .find((run) => run.text.includes('blueX'))?.color;
  });
  assert.equal(typedColor, '#0057a8', 'typing inside a colored run must inherit that run color');
  const blueSourceFormat = await page.evaluate(async () => {
    const bridge = await import('/js/bridge.ts');
    const document = bridge.getPdfEditorRichText();
    const line = document.lines.find((candidate) => candidate.runs.some((run) => run.text.includes('blueX')));
    const run = line.runs.find((candidate) => candidate.text.includes('blueX'));
    return {
      run: {
        faceId: run.faceId, size: run.size, color: run.color,
        bold: run.bold, italic: run.italic,
        underline: run.underline, strikeout: run.strikeout,
      },
      line: { alignment: line.alignment, baselineAdvance: line.baselineAdvance },
    };
  });
  await editor.press('Enter');
  await page.keyboard.type('Blue continuation');
  await page.waitForFunction(async () => {
    const bridge = await import('/js/bridge.ts');
    return bridge.getPdfEditorLayoutState()?.pending === false;
  });
  const continuationFormat = await page.evaluate(async () => {
    const bridge = await import('/js/bridge.ts');
    const document = bridge.getPdfEditorRichText();
    const line = document.lines.find((candidate) => (
      candidate.runs.some((run) => run.text.includes('Blue continuation'))
    ));
    const run = line?.runs.find((candidate) => candidate.text.includes('Blue continuation'));
    return run ? {
      run: {
        faceId: run.faceId, size: run.size, color: run.color,
        bold: run.bold, italic: run.italic,
        underline: run.underline, strikeout: run.strikeout,
      },
      line: { alignment: line.alignment, baselineAdvance: line.baselineAdvance },
    } : null;
  });
  assert.deepEqual(continuationFormat, blueSourceFormat,
    'an Enter-created line must inherit the complete caret run and paragraph format');
  await page.keyboard.press('Control+Enter');
  await editor.waitFor({ state: 'detached' });

  const leftEditId = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return String(state.documents[0].textEdits[0].id);
  });
  await publishSyntheticPageReadiness(page);
  await page.locator(`[data-owned-text-edit-hit][data-edit-id="${leftEditId}"]`).first().click({ force: true });
  await editor.waitFor({ state: 'visible' });
  const reopenedContinuationFormat = await page.evaluate(async () => {
    const bridge = await import('/js/bridge.ts');
    const document = bridge.getPdfEditorRichText();
    const line = document.lines.find((candidate) => (
      candidate.runs.some((run) => run.text.includes('Blue continuation'))
    ));
    const run = line?.runs.find((candidate) => candidate.text.includes('Blue continuation'));
    return run ? {
      run: {
        faceId: run.faceId, size: run.size, color: run.color,
        bold: run.bold, italic: run.italic,
        underline: run.underline, strikeout: run.strikeout,
      },
      line: { alignment: line.alignment, baselineAdvance: line.baselineAdvance },
    } : null;
  });
  assert.deepEqual(reopenedContinuationFormat, blueSourceFormat,
    're-editing must restore the complete inherited run and line format');
  await editor.press('Escape');
  await editor.waitFor({ state: 'detached' });

  await rightTarget.click();
  await editor.waitFor({ state: 'visible' });
  assert.match(await editor.innerText(), /Right paragraph first line/u);
  assert.doesNotMatch(await editor.innerText(), /Left paragraph/u);
  await editor.fill('Independent right paragraph replacement');
  await page.keyboard.press('Control+Enter');
  await editor.waitFor({ state: 'detached' });
  const sideBySideRecords = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return state.documents[0].textEdits.map((record) => ({
      region: record.richText.region,
      colors: [...new Set(record.richText.lines.flatMap((line) => line.runs.map((run) => run.color)))],
      continuation: record.richText.lines.flatMap((line) => line.runs)
        .find((run) => run.text.includes('Blue continuation')) || null,
    })).sort((left, right) => left.region.x - right.region.x);
  });
  assert.equal(sideBySideRecords.length, 2);
  assert.ok(sideBySideRecords[0].region.x + sideBySideRecords[0].region.width
    < sideBySideRecords[1].region.x);
  assert.ok(sideBySideRecords[0].colors.includes('#0057a8'));
  assert.ok(sideBySideRecords[0].colors.includes(grayRunState.color));
  assert.ok(sideBySideRecords[0].colors.includes('#f4f4f4'));
  assert.equal(sideBySideRecords[0].continuation?.color, '#0057a8');
  assert.equal(sideBySideRecords[0].continuation?.size, blueSourceFormat.run.size);
  assert.equal(sideBySideRecords[0].continuation?.faceId, blueSourceFormat.run.faceId);

  const savedRunOperators = await page.evaluate(async () => {
    const { PDFDocument } = await import('/@id/pdf-lib');
    const { state } = await import('/js/core/state.ts');
    const { saveTextEditsToPages } = await import('/js/pdf/saver/text-edits.js');
    const { createTextEditRecordV2 } = await import('/js/text/rich-text.js');
    const sourceRecord = state.documents[0].textEdits.find((record) => (
      record.richText.lines.some((line) => line.runs.some((run) => run.text.includes('Blue continuation')))
    ));
    const source = createTextEditRecordV2({
      id: 'saved-format-operators',
      page: 1,
      richText: JSON.parse(JSON.stringify(sourceRecord.richText)),
    });
    const output = await PDFDocument.create();
    const outputPage = output.addPage([612, 792]);
    const calls = [];
    const drawText = outputPage.drawText.bind(outputPage);
    outputPage.drawText = (value, options) => {
      calls.push({
        value,
        size: options.size,
        fontName: options.font.name,
        color: [options.color.red, options.color.green, options.color.blue],
      });
      return drawText(value, options);
    };
    await saveTextEditsToPages(output, [outputPage], {
      documentId: 'saved-format-operators',
      textEdits: [source],
      textEditManifest: null,
    });
    const operators = [...outputPage.getContentStream().getContentsString().matchAll(
      /([0-9.]+) ([0-9.]+) ([0-9.]+) rg\n\/([^\s]+) ([0-9.]+) Tf/gu,
    )].map((match) => ({
      color: match.slice(1, 4).map(Number),
      fontName: match[4],
      size: Number(match[5]),
    }));
    return { calls, operators };
  });
  assert.equal(savedRunOperators.operators.length, savedRunOperators.calls.length,
    'every saved rich-text run must emit its own RGB and font operators');
  savedRunOperators.calls.forEach((call, index) => {
    assert.match(savedRunOperators.operators[index].fontName,
      new RegExp(`^${call.fontName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-`, 'u'));
    assert.equal(savedRunOperators.operators[index].size, call.size);
    assert.deepEqual(savedRunOperators.operators[index].color, call.color);
  });
  const savedContinuation = savedRunOperators.calls.find((call) => call.value.includes('Blue continuation'));
  assert.ok(savedContinuation, 'the inherited continuation must reach the saved PDF content stream');
  assert.equal(savedContinuation.size, blueSourceFormat.run.size);
  assert.deepEqual(savedContinuation.color, [0, 87 / 255, 168 / 255]);

  console.log('Native paragraph, side-by-side color, multi-box merge, atomic undo, and stable re-edit targets test passed');
} catch (error) {
  await failureArtifacts?.capture(page);
  throw error;
} finally {
  await failureArtifacts?.discard();
  await browser.close();
}
