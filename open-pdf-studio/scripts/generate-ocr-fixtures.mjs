import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutputDir = path.join(projectDir, 'tests', 'fixtures', 'ocr');

const FIXTURES = [
  {
    id: 'clean-latin',
    file: 'clean-latin.pdf',
    description: 'High-contrast Latin text at three sizes.',
    selectedForSpike: true,
    gray: 0.08,
    angleDegrees: 0,
    lines: [
      { text: 'OPEN PDF STUDIO', size: 30, x: 30, y: 178 },
      { text: 'Offline OCR Phase A', size: 22, x: 30, y: 116 },
      { text: 'Total 42.50 EUR', size: 20, x: 30, y: 58 },
    ],
  },
  {
    id: 'numbers-symbols',
    file: 'numbers-symbols.pdf',
    description: 'Latin identifiers, punctuation, and decimal numbers.',
    selectedForSpike: false,
    gray: 0.08,
    angleDegrees: 0,
    lines: [
      { text: 'Invoice 2026-0814', size: 26, x: 30, y: 176 },
      { text: 'Page 1 of 3', size: 22, x: 30, y: 116 },
      { text: 'Amount 1234.56', size: 20, x: 30, y: 58 },
    ],
  },
  {
    id: 'low-contrast-skew',
    file: 'low-contrast-skew.pdf',
    description: 'Light gray Latin text rotated by three degrees.',
    selectedForSpike: false,
    gray: 0.58,
    angleDegrees: 3,
    lines: [
      { text: 'Low contrast sample', size: 26, x: 30, y: 174 },
      { text: 'Skewed by 3 degrees', size: 22, x: 30, y: 112 },
      { text: 'Fallback evidence', size: 20, x: 30, y: 54 },
    ],
  },
];

function escapePdfString(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function buildContent(fixture) {
  const radians = fixture.angleDegrees * Math.PI / 180;
  const cos = Math.cos(radians).toFixed(6);
  const sin = Math.sin(radians).toFixed(6);
  const minusSin = (-Math.sin(radians)).toFixed(6);
  const commands = [
    'q',
    `${fixture.gray} ${fixture.gray} ${fixture.gray} rg`,
    'BT',
  ];
  for (const line of fixture.lines) {
    commands.push(`/F1 ${line.size} Tf`);
    commands.push(`${cos} ${sin} ${minusSin} ${cos} ${line.x} ${line.y} Tm`);
    commands.push(`(${escapePdfString(line.text)}) Tj`);
  }
  commands.push('ET', 'Q');
  return `${commands.join('\n')}\n`;
}

function buildPdf(fixture) {
  const content = buildContent(fixture);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 240] /CropBox [0 0 420 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Title (${escapePdfString(`OCR golden fixture: ${fixture.id}`)}) /Creator (Open PDF Studio Phase A fixture generator) /CreationDate (D:20260814000000Z) /ModDate (D:20260814000000Z) >>`,
  ];
  let pdf = '%PDF-1.4\n% OCR golden fixture; SPDX-License-Identifier: CC0-1.0\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  const id = createHash('sha256').update(fixture.id).digest('hex').slice(0, 32).toUpperCase();
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R /ID [<${id}><${id}>] >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

export async function createOcrFixtures(outputDir = defaultOutputDir) {
  await mkdir(outputDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    license: 'CC0-1.0',
    copyright: 'OpenAEC Foundation contributors',
    generatedBy: 'scripts/generate-ocr-fixtures.mjs',
    fixtures: [],
  };
  for (const fixture of FIXTURES) {
    const bytes = buildPdf(fixture);
    await writeFile(path.join(outputDir, fixture.file), bytes);
    manifest.fixtures.push({
      id: fixture.id,
      file: fixture.file,
      pageIndex: 0,
      selectedForSpike: fixture.selectedForSpike,
      description: fixture.description,
      expectedLines: fixture.lines.map((line) => line.text),
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  await writeFile(path.join(outputDir, 'golden.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await createOcrFixtures(process.argv[2] ? path.resolve(process.argv[2]) : defaultOutputDir);
  console.log(`Generated ${manifest.fixtures.length} OCR fixtures in ${process.argv[2] ?? defaultOutputDir}`);
}
