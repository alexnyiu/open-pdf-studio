import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paragraphRotationControlVisible } from '../solid/components/properties-panel/paragraph-control-policy.js';

const localeRoot = join(dirname(fileURLToPath(import.meta.url)), 'locales');
const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const HARDENED_EDITOR_SOURCES = Object.freeze([
  join(sourceRoot, 'tools', 'text-edit-tool.js'),
  join(sourceRoot, 'tools', 'text-editing.js'),
  join(sourceRoot, 'solid', 'components', 'PdfTextEditOverlay.jsx'),
  join(sourceRoot, 'solid', 'components', 'ContextMenu.jsx'),
  join(sourceRoot, 'solid', 'components', 'properties-panel', 'ParagraphSection.jsx'),
  join(sourceRoot, 'solid', 'components', 'dialogs', 'OcrRegionMergeDialog.jsx'),
  join(sourceRoot, 'solid', 'components', 'dialogs', 'OcrRegionSplitDialog.jsx'),
]);

const FORBIDDEN_EDITOR_UI_LITERALS = Object.freeze([
  'Previously edited text is read-only; the document was left untouched.',
  'Selected OCR paragraph with ${region.lineIds.length} lines',
  'OCR paragraph grouping was not changed:',
  'Text could not be inserted:',
  'The document changed while Add Text was open. The draft was discarded.',
  'The inserted text could not be applied because its owner record already exists.',
  'The selection spans multiple OCR paragraphs. Review the separate outlines and use Merge explicitly. Cross-column merges remain disabled.',
  'Scanned text cannot be edited:',
  'This paragraph crosses an inferred native column boundary. Editing was blocked and the document was left untouched.',
  'This paragraph contains visible text that could not be linked to eligible source operators. The document was left untouched.',
  'Scanned text removal failed:',
  'This native PDF text cannot be deleted safely because its exact source operators are ambiguous. The document was left untouched.',
  'Both current owned OCR regions are required.',
  'The current application-owned OCR source is unavailable.',
  'Validating the combined repair region…',
  'Validating both child regions…',
  'Merge rejected:',
  'Split rejected:',
  'Merge OCR Regions',
  'Split OCR Region',
  'The existing texts are separated by a preserved hard line break.',
  'Merged OCR text',
  'First region',
  'Second region',
  'Source lines:',
]);

test('unsupported rotation stays hidden only for active text-edit panels', () => {
  assert.equal(paragraphRotationControlVisible({
    panelMode: 'textEdit',
    scannedTextEstimate: false,
  }), false);
  assert.equal(paragraphRotationControlVisible({
    panelMode: 'annotation',
    scannedTextEstimate: false,
  }), true);
  assert.equal(paragraphRotationControlVisible({
    panelMode: 'annotation',
    scannedTextEstimate: true,
  }), false);
});

function leafKeys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object' && !Array.isArray(child)
      ? leafKeys(child, path)
      : [path];
  });
}

const REQUIRED_OCR_ORGANIZE_KEYS = Object.freeze([
  'recognizeText',
  'recognizeCurrentPage',
  'cancelOcr',
  'retryOcr',
  'dismissOcr',
  'hideOcr',
  'showOcr',
  'ocrRunning',
  'ocrFailed',
  'ocrProgressTitle',
  'ocrPage',
  'ocrOverallProgress',
  'ocrCounts',
  'ocrCancelling',
  'ocrActionFailed',
  'ocrRetryGuidance',
  'ocrFailureDetail',
  'ocrLiveUpdate',
  'ocrStates.queued',
  'ocrStates.rasterizing',
  'ocrStates.preprocessing',
  'ocrStates.recognizing',
  'ocrStates.validating',
  'ocrStates.applying',
  'ocrStates.completed',
  'ocrStates.skipped',
  'ocrStates.unsupported',
  'ocrStates.failed',
  'ocrStates.cancelled',
  'ocrStates.cancelling',
  'ocrTerminal.completed',
  'ocrTerminal.failed',
  'ocrTerminal.cancelled',
]);

function valueAtPath(value, path) {
  return path.split('.').reduce((current, part) => current?.[part], value);
}

function placeholders(value) {
  return [...String(value).matchAll(/\{\{\s*([^}\s]+)\s*\}\}/gu)]
    .map((match) => match[1])
    .sort();
}

test('release-hardening translations have key parity in every supported locale', async () => {
  const languages = (await readdir(localeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const english = JSON.parse(await readFile(join(localeRoot, 'en', 'hardening.json'), 'utf8'));
  const expectedKeys = leafKeys(english).sort();
  assert.ok(expectedKeys.length > 0);
  for (const language of languages) {
    const resource = JSON.parse(await readFile(join(localeRoot, language, 'hardening.json'), 'utf8'));
    assert.deepEqual(leafKeys(resource).sort(), expectedKeys, `${language} hardening keys`);
    for (const key of expectedKeys) {
      const value = key.split('.').reduce((current, part) => current?.[part], resource);
      assert.equal(typeof value, 'string', `${language}:${key}`);
      assert.notEqual(value.trim(), '', `${language}:${key}`);
      assert.deepEqual(placeholders(value), placeholders(valueAtPath(english, key)),
        `${language}:${key} placeholders`);
    }
    if (language !== 'en') {
      const translated = expectedKeys.filter((key) => (
        valueAtPath(resource, key) !== valueAtPath(english, key)
      ));
      assert.ok(translated.length >= Math.ceil(expectedKeys.length * 0.6),
        `${language} hardening namespace is still substantially an English placeholder copy`);
    }
  }
});

test('OCR workflow controls and statuses exist in every supported ribbon locale', async () => {
  const languages = (await readdir(localeRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.equal(languages.length, 39, 'supported locale count');
  const english = JSON.parse(await readFile(join(localeRoot, 'en', 'ribbon.json'), 'utf8'));
  for (const language of languages) {
    const resource = JSON.parse(await readFile(join(localeRoot, language, 'ribbon.json'), 'utf8'));
    for (const key of REQUIRED_OCR_ORGANIZE_KEYS) {
      const value = valueAtPath(resource.organize, key);
      assert.equal(typeof value, 'string', `${language}:organize.${key}`);
      assert.notEqual(value.trim(), '', `${language}:organize.${key}`);
      assert.deepEqual(placeholders(value), placeholders(valueAtPath(english.organize, key)),
        `${language}:organize.${key} placeholders`);
    }
    if (language !== 'en') {
      const translated = REQUIRED_OCR_ORGANIZE_KEYS.filter((key) => (
        valueAtPath(resource.organize, key) !== valueAtPath(english.organize, key)
      ));
      assert.ok(translated.length >= Math.ceil(REQUIRED_OCR_ORGANIZE_KEYS.length * 0.6),
        `${language} OCR ribbon strings are still substantially an English placeholder copy`);
    }
  }
});

test('production editor feedback and accessibility text cannot bypass hardening translations', async () => {
  const english = JSON.parse(await readFile(join(localeRoot, 'en', 'hardening.json'), 'utf8'));
  const sources = await Promise.all(HARDENED_EDITOR_SOURCES.map(async (path) => ({
    path,
    source: await readFile(path, 'utf8'),
  })));
  const combinedSource = sources.map(({ source }) => source).join('\n');

  for (const literal of FORBIDDEN_EDITOR_UI_LITERALS) {
    assert.equal(combinedSource.includes(literal), false, `hard-coded editor UI text: ${literal}`);
  }

  const textEditTool = sources.find(({ path }) => path.endsWith('/tools/text-edit-tool.js'))?.source || '';
  const messageCalls = [...textEditTool.matchAll(/\bshowMessage\(([^;\n]+)\);/gu)]
    .map((match) => match[1].trim());
  assert.ok(messageCalls.length > 0, 'editor has visible feedback calls');
  for (const expression of messageCalls) {
    assert.ok(expression.startsWith('hardeningText(') || expression === 'rejection',
      `showMessage must receive localized editor feedback, received: ${expression}`);
  }

  assert.doesNotMatch(textEditTool,
    /setAttribute\(\s*['"]aria-label['"]\s*,\s*['"`]/gu,
    'editor aria labels must not be string literals');
  assert.doesNotMatch(combinedSource,
    /\bsetPdfEditorStatus\(\s*['"`]/gu,
    'editor statuses must not be string literals');

  const referencedKeys = [...textEditTool.matchAll(/hardeningText\(\s*['"]([^'"]+)['"]/gu)]
    .map((match) => match[1]);
  for (const { path, source } of sources.filter(({ path }) => path.includes('/dialogs/OcrRegion'))) {
    referencedKeys.push(...[...source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/gu)]
      .map((match) => match[1]));
    assert.doesNotMatch(source, /\bsetStatus\(\s*['"`]/gu,
      `${path} status must not be a string literal`);
  }
  for (const key of referencedKeys) {
    assert.equal(typeof valueAtPath(english, key), 'string', `missing hardening key: ${key}`);
  }
});
