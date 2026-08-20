import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName, PDFNumber, rgb } from 'pdf-lib';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(projectDir, 'tests', 'fixtures', 'ocr', 'workflow-v1');
const qualityDir = path.join(projectDir, 'tests', 'fixtures', 'ocr', 'quality-v1');
const manifest = JSON.parse(await readFile(path.join(workflowDir, 'corpus.v1.json'), 'utf8'));
const quality = JSON.parse(await readFile(path.join(qualityDir, 'corpus.v1.json'), 'utf8'));
const fontBytes = await readFile(path.join(
  projectDir,
  'public',
  'pdfjs',
  'web',
  'standard_fonts',
  'LiberationSans-Regular.ttf',
));

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const outputDir = path.resolve(option('--output-dir') || process.env.OPS_OCR_WORKFLOW_FIXTURE_DIR
  || path.join(tmpdir(), 'open-pdf-studio-ocr-workflow-fixtures'));

function qualityFixture(id) {
  const fixture = quality.fixtures.find((entry) => entry.id === id);
  assert.ok(fixture, `Unknown OCR quality fixture: ${id}`);
  return fixture;
}

async function embedFixture(document, id) {
  const fixture = qualityFixture(id);
  return {
    fixture,
    image: await document.embedPng(await readFile(path.join(qualityDir, fixture.input.file))),
  };
}

async function addImagePage(document, id, options = {}) {
  const { fixture, image } = await embedFixture(document, id);
  const width = options.width ?? 540;
  const height = options.height ?? width * fixture.input.heightPx / fixture.input.widthPx;
  const originX = options.originX ?? 36;
  const originY = options.originY ?? 36;
  const page = document.addPage([
    originX + width + (options.trailingX ?? 36),
    originY + height + (options.trailingY ?? 36),
  ]);
  page.setCropBox(originX, originY, width, height);
  if (options.userUnit) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(options.userUnit));
  page.drawImage(image, { x: originX, y: originY, width, height });
  return page;
}

async function imageOnlyPdf() {
  const document = await PDFDocument.create();
  await addImagePage(document, 'clean-300dpi', {
    originX: 20,
    originY: 20,
    width: 360,
    height: 240,
    trailingX: 20,
    trailingY: 20,
    userUnit: 1.25,
  });
  return document.save({ useObjectStreams: true });
}

async function representativePdf() {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const font = await document.embedFont(fontBytes, { subset: false });

  await addImagePage(document, 'clean-300dpi', {
    originX: 20,
    originY: 20,
    width: 360,
    height: 240,
    trailingX: 20,
    trailingY: 20,
    userUnit: 1.25,
  });
  await addImagePage(document, 'mild-skew');
  await addImagePage(document, 'multiple-columns');
  await addImagePage(document, 'punctuation-unicode');
  await addImagePage(document, 'dense-70-lines', { width: 432, height: 720 });

  const nativePage = document.addPage([612, 792]);
  nativePage.drawText('NATIVE TEXT PAGE SHOULD SKIP', {
    x: 72,
    y: 640,
    size: 24,
    font,
    color: rgb(0, 0, 0),
  });
  nativePage.drawText('Meaningful PDF text is preserved.', {
    x: 72,
    y: 590,
    size: 16,
    font,
    color: rgb(0, 0, 0),
  });

  const { image: mixedImage } = await embedFixture(document, 'clean-300dpi');
  const mixedPage = document.addPage([612, 792]);
  mixedPage.drawImage(mixedImage, { x: 36, y: 360, width: 540, height: 360 });
  mixedPage.drawText('MIXED NATIVE POLICY TEXT', {
    x: 72,
    y: 245,
    size: 24,
    font,
    color: rgb(0, 0, 0),
  });
  mixedPage.drawText('The default policy skips this entire page.', {
    x: 72,
    y: 200,
    size: 16,
    font,
    color: rgb(0, 0, 0),
  });

  await addImagePage(document, 'unsupported-table');
  return document.save({ useObjectStreams: true });
}

async function cancellationPdf() {
  const document = await PDFDocument.create();
  const { fixture, image } = await embedFixture(document, manifest.outputs.cancellation.fixtureId);
  const width = 432;
  const height = width * fixture.input.heightPx / fixture.input.widthPx;
  for (let index = 0; index < manifest.outputs.cancellation.pageCount; index += 1) {
    const page = document.addPage([width + 72, height + 72]);
    page.setCropBox(36, 36, width, height);
    page.drawImage(image, { x: 36, y: 36, width, height });
  }
  return document.save({ useObjectStreams: true });
}

await mkdir(outputDir, { recursive: true });
const paths = {
  imageOnly: path.join(outputDir, manifest.outputs.imageOnly.file),
  representative: path.join(outputDir, manifest.outputs.representative.file),
  cancellation: path.join(outputDir, manifest.outputs.cancellation.file),
};
await Promise.all([
  writeFile(paths.imageOnly, await imageOnlyPdf()),
  writeFile(paths.representative, await representativePdf()),
  writeFile(paths.cancellation, await cancellationPdf()),
]);

process.stdout.write(`${JSON.stringify({ status: 'pass', outputDir, paths }, null, 2)}\n`);
