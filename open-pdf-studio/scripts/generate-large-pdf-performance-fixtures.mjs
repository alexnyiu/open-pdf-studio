import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import sharp from 'sharp';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const outputDir = path.resolve(option('--output-dir') || path.join(tmpdir(), 'opds-large-pdf-fixtures'));
const fixedDate = new Date('2026-08-27T00:00:00.000Z');

function setMetadata(document, title) {
  document.setTitle(title);
  document.setAuthor('Open PDF Studio test infrastructure');
  document.setCreator('Open PDF Studio deterministic performance fixture generator');
  document.setProducer('Open PDF Studio deterministic performance fixture generator');
  document.setCreationDate(fixedDate);
  document.setModificationDate(fixedDate);
}

async function lightweight500() {
  const document = await PDFDocument.create();
  setMetadata(document, 'Open PDF Studio 500-page lightweight performance fixture');
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= 500; pageNumber += 1) {
    const page = document.addPage([612, 792]);
    page.drawText(`Lightweight page ${pageNumber} of 500`, { x: 54, y: 720, size: 12, font });
    page.drawLine({ start: { x: 54, y: 710 }, end: { x: 558, y: 710 }, thickness: 0.5 });
  }
  return document.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
}

async function imageHeavy100() {
  const width = 1_000;
  const height = 1_400;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 13 + y * 3) % 256;
      pixels[offset + 1] = (x * 5 + y * 11) % 256;
      pixels[offset + 2] = (x ^ y) % 256;
    }
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 6, adaptiveFiltering: false })
    .toBuffer();
  const document = await PDFDocument.create();
  setMetadata(document, 'Open PDF Studio 100-page image-heavy performance fixture');
  const image = await document.embedPng(png);
  for (let pageNumber = 1; pageNumber <= 100; pageNumber += 1) {
    const page = document.addPage([612, 792]);
    page.drawImage(image, { x: 36, y: 36, width: 540, height: 720 });
  }
  return document.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 25 });
}

async function variableSizes() {
  const document = await PDFDocument.create();
  setMetadata(document, 'Open PDF Studio variable-page-size performance fixture');
  const font = await document.embedFont(StandardFonts.Helvetica);
  const sizes = [[612, 792], [792, 612], [420, 595], [842, 1191], [500, 500]];
  for (let pageNumber = 1; pageNumber <= 80; pageNumber += 1) {
    const size = sizes[(pageNumber - 1) % sizes.length];
    const page = document.addPage(size);
    page.drawText(`Variable page ${pageNumber}: ${size[0]} x ${size[1]}`, {
      x: 24, y: size[1] - 36, size: 10, font,
    });
  }
  return document.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 25 });
}

async function rotatedPages() {
  const document = await PDFDocument.create();
  setMetadata(document, 'Open PDF Studio rotated-page performance fixture');
  const font = await document.embedFont(StandardFonts.Helvetica);
  const rotations = [0, 90, 180, 270];
  for (let pageNumber = 1; pageNumber <= 40; pageNumber += 1) {
    const rotation = rotations[(pageNumber - 1) % rotations.length];
    const page = document.addPage([612, 792]);
    page.setRotation(degrees(rotation));
    page.drawRectangle({ x: 36, y: 36, width: 540, height: 720, borderWidth: 1, borderColor: rgb(0, 0, 0) });
    page.drawText(`Rotated page ${pageNumber}: ${rotation} degrees`, { x: 54, y: 720, size: 12, font });
  }
  return document.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 25 });
}

async function smallTextSharpness() {
  const document = await PDFDocument.create();
  setMetadata(document, 'Open PDF Studio deterministic small-text sharpness fixture');
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  for (const rotation of [0, 90, 180, 270]) {
    const page = document.addPage([612, 792]);
    page.setRotation(degrees(rotation));
    page.drawRectangle({
      x: 36, y: 36, width: 540, height: 720,
      borderWidth: 0.5, borderColor: rgb(0, 0, 0),
    });
    let y = 730;
    for (const size of [6, 8, 10]) {
      page.drawText(`${size} point Helvetica — Sphinx of black quartz, judge my vow 0123456789`, {
        x: 48, y, size, font: regular, color: rgb(0.05, 0.05, 0.05),
      });
      y -= size + 12;
      page.drawText(`${size} point bold — ASML EUV lithography and semiconductor systems`, {
        x: 48, y, size, font: bold, color: rgb(0.05, 0.05, 0.05),
      });
      y -= size + 22;
    }
    for (let line = 0; line < 12; line += 1) {
      page.drawLine({
        start: { x: 48, y: 430 - line * 16 },
        end: { x: 564, y: 430 - line * 16 },
        thickness: line % 3 === 0 ? 0.25 : 0.5,
        color: rgb(0.15, 0.15, 0.15),
      });
    }
  }
  return document.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 25 });
}

await mkdir(outputDir, { recursive: true });
const fixtures = [
  ['lightweight-500.pdf', 500, await lightweight500()],
  ['image-heavy-100.pdf', 100, await imageHeavy100()],
  ['variable-page-sizes-80.pdf', 80, await variableSizes()],
  ['rotated-pages-40.pdf', 40, await rotatedPages()],
  ['small-text-sharpness-4.pdf', 4, await smallTextSharpness()],
];
const manifest = { schemaVersion: 2, generatedAt: fixedDate.toISOString(), fixtures: [] };
for (const [file, pageCount, bytes] of fixtures) {
  await writeFile(path.join(outputDir, file), bytes);
  manifest.fixtures.push({
    file,
    pageCount,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(outputDir);
