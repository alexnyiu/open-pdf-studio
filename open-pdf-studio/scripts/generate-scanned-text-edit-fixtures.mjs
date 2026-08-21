import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

import {
  commitScannedTextEditEvaluation,
  createScannedTextEditStateV1,
  evaluateScannedTextEdit,
} from '../js/ocr/editing/edit-state.js';
import {
  removeOwnedScannedTextRepairLayer,
  writeOwnedScannedTextRepairLayer,
} from '../js/ocr/editing/pdf-repair-layer.js';
import { makeOcrFixture } from '../js/ocr/searchable-layer.test-fixtures.mjs';

const outputDir = new URL('../tests/fixtures/ocr/editing-foundation-v1/', import.meta.url);
const widthPx = 256;
const heightPx = 160;
const fixedTime = '2026-08-20T12:00:00.000Z';
const fixedPdfDate = 'D:20260820120000Z';
const line = { id: 'line-1', text: 'SCAN TEXT', x: 72, y: 64, width: 112, height: 24, confidence: 0.97 };

function rgba(red, green, blue, alpha = 255) {
  const bytes = new Uint8ClampedArray(widthPx * heightPx * 4);
  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes[offset] = red;
    bytes[offset + 1] = green;
    bytes[offset + 2] = blue;
    bytes[offset + 3] = alpha;
  }
  return bytes;
}

function offset(x, y) {
  return (y * widthPx + x) * 4;
}

function pixel(bytes, x, y, red, green, blue, alpha = 255) {
  if (x < 0 || y < 0 || x >= widthPx || y >= heightPx) return;
  const index = offset(x, y);
  bytes[index] = Math.max(0, Math.min(255, Math.round(red)));
  bytes[index + 1] = Math.max(0, Math.min(255, Math.round(green)));
  bytes[index + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  bytes[index + 3] = alpha;
}

function rectangle(bytes, x, y, width, height, color) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) pixel(bytes, px, py, ...color);
  }
}

function addSyntheticText(bytes) {
  const glyphWidths = [8, 7, 8, 9, 4, 8, 7, 8];
  let x = line.x + 5;
  for (const [index, glyphWidth] of glyphWidths.entries()) {
    const top = line.y + 4 + (index % 2);
    rectangle(bytes, x, top, 2, 15, [28, 31, 35]);
    rectangle(bytes, x, top, glyphWidth, 2, [28, 31, 35]);
    rectangle(bytes, x, top + 7, Math.max(3, glyphWidth - 1), 2, [28, 31, 35]);
    rectangle(bytes, x, top + 13, glyphWidth, 2, [28, 31, 35]);
    x += glyphWidth + 4;
  }
  return bytes;
}

function flatFixture() {
  return addSyntheticText(rgba(232, 236, 242));
}

function paperFixture() {
  const bytes = rgba(244, 241, 232);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 1) {
      const noise = ((x * 17 + y * 29 + (x * y) % 23) % 21) - 10;
      const fiber = (x * 7 + y * 13) % 97 === 0 ? -24 : 0;
      pixel(bytes, x, y, 244 + noise + fiber, 241 + noise + fiber, 232 + noise + fiber);
    }
  }
  return addSyntheticText(bytes);
}

function ruledFixture() {
  const bytes = rgba(247, 246, 239);
  for (let y = 12; y < heightPx; y += 18) rectangle(bytes, 0, y, widthPx, 2, [121, 153, 187]);
  rectangle(bytes, 42, 0, 2, heightPx, [205, 102, 105]);
  return addSyntheticText(bytes);
}

function tableFixture() {
  const bytes = rgba(248, 248, 245);
  for (let x = 16; x < widthPx; x += 40) rectangle(bytes, x, 0, 2, heightPx, [82, 88, 94]);
  for (let y = 10; y < heightPx; y += 28) rectangle(bytes, 0, y, widthPx, 2, [82, 88, 94]);
  return addSyntheticText(bytes);
}

function photoFixture() {
  const bytes = rgba(0, 0, 0);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 1) {
      const noise = ((x * 31 + y * 47 + x * y * 3) % 37) - 18;
      if (y < 88) {
        pixel(bytes, x, y, 55 + x * 0.35 + noise, 122 + y * 0.55 + noise * 0.3, 196 + y * 0.3 + noise * 0.2);
      } else {
        pixel(bytes, x, y, 72 + noise, 116 + (heightPx - y) * 0.6 + noise, 58 + noise * 0.4);
      }
    }
  }
  rectangle(bytes, 22, 38, 26, 84, [54, 77, 37]);
  rectangle(bytes, 196, 24, 34, 102, [91, 62, 42]);
  rectangle(bytes, 176, 20, 70, 42, [42, 96, 46]);
  return addSyntheticText(bytes);
}

function gradientFixture() {
  const bytes = rgba(0, 0, 0);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 1) {
      const amount = x / (widthPx - 1);
      pixel(bytes, x, y, 194 + amount * 54, 205 + amount * 42, 224 + amount * 25);
    }
  }
  return addSyntheticText(bytes);
}

function shadowFixture() {
  const bytes = rgba(0, 0, 0);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 1) {
      const diagonal = (x + y * 1.4) / (widthPx + heightPx * 1.4);
      const shade = 252 - Math.max(0, diagonal - 0.22) * 102;
      pixel(bytes, x, y, shade, shade - 3, shade - 8);
    }
  }
  return addSyntheticText(bytes);
}

function compressionFixture() {
  const bytes = rgba(239, 238, 234);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 1) {
      const block = ((Math.floor(x / 8) * 5 + Math.floor(y / 8) * 7) % 7) - 3;
      const ringing = ((x + y * 3) % 5) - 2;
      pixel(bytes, x, y, 239 + block + ringing, 238 + block, 234 + block - ringing);
    }
  }
  return addSyntheticText(bytes);
}

function lowConfidenceFixture() {
  return addSyntheticText(rgba(235, 238, 242));
}

const specifications = [
  ['flat-color', flatFixture, 'flat', true, line],
  ['mild-paper-texture', paperFixture, 'textured', false, line],
  ['ruled-lines', ruledFixture, 'table-line-art', false, line],
  ['table', tableFixture, 'table-line-art', false, line],
  ['photo', photoFixture, 'photographic', false, line],
  ['gradient', gradientFixture, 'gradient', false, line],
  ['shadow', shadowFixture, 'gradient', false, line],
  ['compression-noise', compressionFixture, 'near-flat', true, line],
  ['low-confidence-geometry', lowConfidenceFixture, 'flat', false, { ...line, confidence: 0.35 }],
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function pngBytes(raw) {
  return sharp(raw, { raw: { width: widthPx, height: heightPx, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
}

async function sourcePdf(png) {
  const document = await PDFDocument.create();
  document.setTitle('Open PDF Studio scanned-text edit foundation fixture');
  document.setCreator('Open PDF Studio deterministic fixture generator');
  document.setProducer('Open PDF Studio');
  document.setCreationDate(new Date(fixedTime));
  document.setModificationDate(new Date(fixedTime));
  const page = document.addPage([widthPx, heightPx]);
  const image = await document.embedPng(png);
  page.drawImage(image, { x: 0, y: 0, width: widthPx, height: heightPx });
  return document.save({ useObjectStreams: true, updateFieldAppearances: false });
}

await mkdir(outputDir, { recursive: true });
const manifestEntries = [];
const rawByName = new Map();
const pngByName = new Map();
for (const [name, factory, expectedClassification, expectedEligible, ocrLine] of specifications) {
  const raw = factory();
  const png = await pngBytes(raw);
  rawByName.set(name, raw);
  pngByName.set(name, png);
  await writeFile(new URL(`${name}.png`, outputDir), png);
  manifestEntries.push({
    id: name,
    file: `${name}.png`,
    widthPx,
    heightPx,
    rgbaSha256: sha256(raw),
    pngSha256: sha256(png),
    expectedClassification,
    expectedEligible,
    ocrLine,
  });
}

const flatRaw = rawByName.get('flat-color');
const flatPng = pngByName.get('flat-color');
const fixture = makeOcrFixture({
  documentId: 'scanned-text-edit-fixture-document',
  documentGeneration: 'scanned-text-edit-fixture-generation',
  pageId: 'scanned-text-edit-fixture-page',
  pageRevision: 0,
  lines: [line],
  width: widthPx,
  height: heightPx,
});
const evaluation = await evaluateScannedTextEdit({
  ...fixture,
  raster: {
    widthPx,
    heightPx,
    rowBytes: widthPx * 4,
    data: flatRaw,
    sourceRasterId: fixture.result.sourceRaster.id,
    sourceRasterFingerprint: fixture.result.sourceRaster.fingerprint,
  },
  target: { kind: 'line', lineId: line.id },
  repairPaddingPx: 1,
  contextPaddingPx: 24,
  operationId: 'scanned-text-edit-fixture-operation',
  modifiedAt: fixedTime,
});
if (!evaluation.selection.analysis.eligibility.eligible) {
  throw new Error(`Flat fixture unexpectedly rejected: ${JSON.stringify(evaluation.selection.analysis, null, 2)}`);
}
const documentState = {
  id: fixture.result.document.id,
  undoStack: [],
  redoStack: [],
  scannedTextEdits: createScannedTextEditStateV1({
    document: fixture.result.document,
    stateId: 'scanned-text-edit-fixture-state',
    instanceId: 'scanned-text-edit-fixture-instance',
    createdAt: fixedTime,
  }),
};
commitScannedTextEditEvaluation(documentState, evaluation, { modifiedAt: fixedTime });
const baselinePdf = await sourcePdf(flatPng);
const candidatePdf = await writeOwnedScannedTextRepairLayer({
  pdfBytes: baselinePdf,
  state: documentState.scannedTextEdits,
  pageGeometries: [fixture.pageGeometry],
  modifiedAt: fixedPdfDate,
});
const revertedPdf = await removeOwnedScannedTextRepairLayer({ pdfBytes: candidatePdf });
await writeFile(new URL('flat-scanned-source.pdf', outputDir), baselinePdf);
await writeFile(new URL('flat-scanned-repaired.pdf', outputDir), candidatePdf);
await writeFile(new URL('flat-scanned-reverted.pdf', outputDir), revertedPdf);

const manifest = {
  contract: 'open-pdf-studio.scanned-text-edit-fixtures',
  schemaVersion: 1,
  generatedAt: fixedTime,
  generator: 'scripts/generate-scanned-text-edit-fixtures.mjs',
  deterministic: true,
  modelUsed: false,
  fixtures: manifestEntries,
  pdfProof: {
    source: 'flat-scanned-source.pdf',
    repaired: 'flat-scanned-repaired.pdf',
    reverted: 'flat-scanned-reverted.pdf',
    sourceSha256: sha256(baselinePdf),
    repairedSha256: sha256(candidatePdf),
    revertedSha256: sha256(revertedPdf),
    approvedRegion: evaluation.selection.repair.approvedRegion,
    changedRegion: evaluation.selection.repair.changedRegion,
    stateId: documentState.scannedTextEdits.stateId,
    stateRevision: documentState.scannedTextEdits.stateRevision,
  },
};
await writeFile(new URL('manifest.v1.json', outputDir), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Generated ${manifestEntries.length} scanned-text visual fixtures and PDF repair proof.`);
