import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(projectDir, 'tests', 'fixtures', 'ocr', 'release-qualification-v1');
const qualityDir = path.join(projectDir, 'tests', 'fixtures', 'ocr', 'quality-v1');
const manifest = JSON.parse(await readFile(path.join(corpusDir, 'corpus.v1.json'), 'utf8'));
const quality = JSON.parse(await readFile(path.join(qualityDir, 'corpus.v1.json'), 'utf8'));

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const outputDir = path.resolve(option('--output-dir') || path.join(tmpdir(), 'opds-ocr-release-qualification'));
const mode = option('--mode') || 'all';
assert.ok(['all', 'long-run', 'adversarial'].includes(mode), `unsupported generation mode: ${mode}`);

function fixture(id) {
  const value = quality.fixtures.find((entry) => entry.id === id);
  assert.ok(value?.input?.file, `unknown raster fixture ${id}`);
  return value;
}

function markerBuffer(pageNumber, variant) {
  const width = 64;
  const height = 64;
  const data = Buffer.alloc(width * height * 4, 255);
  const value = pageNumber + variant * 101;
  for (let bit = 0; bit < 12; bit += 1) {
    const enabled = (value >> (bit % 8)) & 1;
    const left = (bit % 4) * 16;
    const top = Math.floor(bit / 4) * 16;
    const shade = enabled ? 232 - variant * 2 : 248 - (pageNumber % 3);
    for (let y = top; y < top + 12; y += 1) {
      for (let x = left; x < left + 12; x += 1) {
        const offset = (y * width + x) * 4;
        data[offset] = shade;
        data[offset + 1] = shade;
        data[offset + 2] = shade;
      }
    }
  }
  return { data, width, height };
}

async function markedPng(id, pageNumber, variant) {
  const source = fixture(id);
  const marker = markerBuffer(pageNumber, variant);
  return sharp(path.join(qualityDir, source.input.file), { limitInputPixels: 20_000_000 })
    .ensureAlpha()
    .composite([{
      input: marker.data,
      raw: { width: marker.width, height: marker.height, channels: 4 },
      left: source.input.widthPx - marker.width - 8,
      top: source.input.heightPx - marker.height - 8,
    }])
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

function fixedMetadata(document, title) {
  const fixed = new Date('2026-08-24T00:00:00.000Z');
  document.setTitle(title);
  document.setAuthor('Open PDF Studio test infrastructure');
  document.setCreator('Open PDF Studio deterministic fixture generator');
  document.setProducer('Open PDF Studio deterministic fixture generator');
  document.setCreationDate(fixed);
  document.setModificationDate(fixed);
}

async function longRunPdf(variant) {
  const document = await PDFDocument.create();
  fixedMetadata(document, `Open PDF Studio 100-page OCR qualification ${variant}`);
  const samples = new Map(manifest.longRun.samplePages.map((entry) => [entry.pageNumber, entry.fixtureId]));
  for (let pageNumber = 1; pageNumber <= manifest.longRun.pageCount; pageNumber += 1) {
    const id = samples.get(pageNumber) || manifest.longRun.defaultFixtureId;
    const source = fixture(id);
    // Keep the production long-run input limited to the approved OCR fixture.
    // A former synthetic page marker could itself be recognized as text and
    // correctly rejected by the writer's geometry safety checks.
    const png = await readFile(path.join(qualityDir, source.input.file));
    const image = await document.embedPng(png);
    const page = document.addPage([612, 792]);
    const maximumWidth = 540;
    const maximumHeight = 720;
    const scale = Math.min(maximumWidth / source.input.widthPx, maximumHeight / source.input.heightPx);
    const width = source.input.widthPx * scale;
    const height = source.input.heightPx * scale;
    page.drawImage(image, { x: (612 - width) / 2, y: (792 - height) / 2, width, height });
  }
  return document.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 20 });
}

function rawPdf({ mediaBox = [0, 0, 612, 792], content = Buffer.from(''), filter = null,
  declaredCount = 1, invalidContentsReference = false, malformedLength = false,
  repeatedPages = 1, repeatedKidReferences = 1 } = {}) {
  const objects = [];
  const pageObjectNumbers = Array.from({ length: repeatedPages }, (_, index) => 3 + index);
  const contentObjectNumber = 3 + repeatedPages;
  objects.push(Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));
  const kidReferences = repeatedKidReferences === 1
    ? pageObjectNumbers.map((value) => `${value} 0 R`)
    : Array.from({ length: repeatedKidReferences }, () => `${pageObjectNumbers[0]} 0 R`);
  objects.push(Buffer.from(`2 0 obj\n<< /Type /Pages /Count ${declaredCount} /Kids [${kidReferences.join(' ')}] >>\nendobj\n`));
  for (const objectNumber of pageObjectNumbers) {
    const contents = invalidContentsReference ? '999 0 R' : `${contentObjectNumber} 0 R`;
    objects.push(Buffer.from(`${objectNumber} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(' ')}] /Resources << >> /Contents ${contents} >>\nendobj\n`));
  }
  const filterEntry = filter ? ` /Filter /${filter}` : '';
  const length = malformedLength ? content.length + 4096 : content.length;
  objects.push(Buffer.concat([
    Buffer.from(`${contentObjectNumber} 0 obj\n<< /Length ${length}${filterEntry} >>\nstream\n`),
    content,
    Buffer.from('\nendstream\nendobj\n'),
  ]));
  const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = [0];
  let offset = chunks[0].length;
  objects.forEach((object) => {
    offsets.push(offset);
    chunks.push(object);
    offset += object.length;
  });
  const xrefOffset = offset;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((value) => `${String(value).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join('');
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}

async function simpleDimensionPdf(title, dimensions) {
  const document = await PDFDocument.create();
  fixedMetadata(document, title);
  document.addPage(dimensions);
  return document.save({ useObjectStreams: false, addDefaultPage: false });
}

async function largeImagePdf() {
  const document = await PDFDocument.create();
  fixedMetadata(document, 'Bounded 4096 square embedded image');
  const png = await sharp({
    create: { width: 4096, height: 4096, channels: 3, background: { r: 252, g: 252, b: 252 } },
    limitInputPixels: 20_000_000,
  }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  const image = await document.embedPng(png);
  const page = document.addPage([612, 792]);
  page.drawImage(image, { x: 36, y: 126, width: 540, height: 540 });
  return document.save({ useObjectStreams: true, addDefaultPage: false });
}

async function pathologicalCancellationPdf() {
  const document = await PDFDocument.create();
  fixedMetadata(document, 'Bounded pathological cancellation input');
  const source = fixture('dense-70-lines');
  for (let pageNumber = 1; pageNumber <= 16; pageNumber += 1) {
    const image = await document.embedPng(await markedPng(source.id, pageNumber, 3));
    const page = document.addPage([504, 792]);
    page.drawImage(image, { x: 36, y: 36, width: 432, height: 720 });
  }
  return document.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 20 });
}

async function writeLongRun() {
  const complete = path.join(outputDir, manifest.longRun.files.complete);
  const cancellation = path.join(outputDir, manifest.longRun.files.cancellation);
  await writeFile(complete, await longRunPdf('complete'));
  await writeFile(cancellation, await longRunPdf('cancellation'));
  return { complete, cancellation };
}

async function writeAdversarial() {
  const outputs = {};
  const write = async (id, bytes) => {
    const entry = manifest.adversarialCases.find((candidate) => candidate.id === id);
    assert.ok(entry?.file, `missing output file for ${id}`);
    const destination = path.join(outputDir, entry.file);
    await writeFile(destination, bytes);
    outputs[id] = destination;
  };
  await write('extreme-declared-page-dimensions', await simpleDimensionPdf(
    'Extreme declared dimensions', [200_000, 200_000],
  ));
  await write('excessive-raster-pixel-count', await simpleDimensionPdf(
    'Excessive raster pixels', [2_400, 2_400],
  ));
  await write('oversized-page-side', await simpleDimensionPdf(
    'Oversized raster side', [4_100, 100],
  ));
  await write('excessive-declared-page-count', rawPdf({
    declaredCount: 100_001,
    repeatedKidReferences: 100_001,
  }));
  const valid = rawPdf();
  const malformedXref = Buffer.from(valid);
  const marker = Buffer.from('startxref\n');
  const markerOffset = malformedXref.lastIndexOf(marker);
  malformedXref.write('9999999999', markerOffset + marker.length, 'ascii');
  await write('malformed-xref', malformedXref);
  await write('truncated-pdf', valid.subarray(0, Math.max(1, valid.length - 96)));
  await write('invalid-object-reference', rawPdf({ invalidContentsReference: true }));
  await write('malformed-stream', rawPdf({ content: Buffer.from('q 1 0 0 1 0 0 cm Q'), malformedLength: true }));
  await write('oversized-compressed-content', rawPdf({
    content: deflateSync(Buffer.from('q\nQ\n'.repeat(300_000))), filter: 'FlateDecode',
  }));
  await write('high-decompression-expansion', rawPdf({
    content: deflateSync(Buffer.alloc(8 * 1024 * 1024, 0x20)), filter: 'FlateDecode',
  }));
  await write('very-large-embedded-image', await largeImagePdf());
  await write('repeated-malformed-pages', rawPdf({
    repeatedPages: 32, declaredCount: 32, invalidContentsReference: true,
  }));
  await write('pathological-input-cancellation', await pathologicalCancellationPdf());
  return outputs;
}

await mkdir(outputDir, { recursive: true });
const result = { status: 'pass', outputDir, longRun: null, adversarial: null };
if (mode !== 'adversarial') result.longRun = await writeLongRun();
if (mode !== 'long-run') result.adversarial = await writeAdversarial();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
