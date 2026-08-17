import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutputDir = path.join(projectDir, 'tests', 'fixtures', 'ocr', 'quality-v1');
const regularFontPath = path.join(
  projectDir,
  'public',
  'pdfjs',
  'web',
  'standard_fonts',
  'LiberationSans-Regular.ttf',
);
const boldFontPath = path.join(
  projectDir,
  'public',
  'pdfjs',
  'web',
  'standard_fonts',
  'LiberationSans-Bold.ttf',
);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function rotatePoint([x, y], degrees, centerX, centerY) {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const translatedX = x - centerX;
  const translatedY = y - centerY;
  return [
    round(centerX + translatedX * cosine - translatedY * sine),
    round(centerY + translatedX * sine + translatedY * cosine),
  ];
}

function expectedPolygon(line, fixture) {
  const top = line.baseline - line.fontSize;
  const height = line.boxHeight ?? line.fontSize * 1.25;
  const polygon = [
    [line.x, top],
    [line.x + line.width, top],
    [line.x + line.width, top + height],
    [line.x, top + height],
  ];
  const rotation = (fixture.rotationDegrees ?? 0) + (line.rotationDegrees ?? 0);
  if (rotation === 0) return polygon.map(([x, y]) => [round(x), round(y)]);
  return polygon.map((point) => rotatePoint(
    point,
    rotation,
    line.rotationCenterX ?? fixture.rotationCenterX ?? fixture.width / 2,
    line.rotationCenterY ?? fixture.rotationCenterY ?? fixture.height / 2,
  ));
}

function textLine(id, text, x, baseline, width, fontSize, options = {}) {
  return {
    id,
    text,
    x,
    baseline,
    width,
    fontSize,
    fill: options.fill ?? '#111111',
    weight: options.weight ?? 'regular',
    layer: options.layer ?? 'image',
    rotationDegrees: options.rotationDegrees ?? 0,
    rotationCenterX: options.rotationCenterX,
    rotationCenterY: options.rotationCenterY,
    boxHeight: options.boxHeight,
  };
}

const denseLines = Array.from({ length: 70 }, (_, index) => textLine(
  `dense-line-${String(index + 1).padStart(2, '0')}`,
  `Line ${String(index + 1).padStart(2, '0')} value ${1001 + index}`,
  70,
  58 + index * 27,
  450,
  20,
));

const FIXTURES = [
  {
    id: 'clean-300dpi',
    category: 'clean-300-dpi-latin',
    classification: 'supported',
    description: 'High-contrast Latin page raster at exactly 300 DPI.',
    width: 1200,
    height: 800,
    dpi: 300,
    lines: [
      textLine('clean-1', 'OPEN PDF STUDIO', 90, 175, 540, 58, { weight: 'bold' }),
      textLine('clean-2', 'Searchable OCR benchmark', 90, 310, 650, 46),
      textLine('clean-3', 'Reference page 2026', 90, 435, 510, 42),
      textLine('clean-4', 'Total 42.50 EUR', 90, 560, 390, 42),
    ],
  },
  {
    id: 'lower-resolution',
    category: 'lower-resolution-text',
    classification: 'supported',
    description: 'Compact 96-DPI page with smaller Latin text.',
    width: 600,
    height: 400,
    dpi: 96,
    lines: [
      textLine('lowres-1', 'Lower resolution sample', 40, 92, 390, 28, { weight: 'bold' }),
      textLine('lowres-2', 'Small text remains searchable', 40, 170, 430, 24),
      textLine('lowres-3', 'Code A17-204', 40, 244, 210, 24),
      textLine('lowres-4', 'Page 2 of 8', 40, 318, 190, 24),
    ],
  },
  {
    id: 'low-contrast',
    category: 'low-contrast',
    classification: 'supported',
    description: 'Low-contrast gray Latin text on an off-white page.',
    width: 1200,
    height: 800,
    dpi: 300,
    background: '#f6f6f2',
    lines: [
      textLine('contrast-1', 'Low contrast document', 100, 190, 570, 52, { fill: '#8f8f8b' }),
      textLine('contrast-2', 'Faded archive copy', 100, 330, 460, 46, { fill: '#999995' }),
      textLine('contrast-3', 'Record number 7305', 100, 470, 470, 44, { fill: '#92928e' }),
      textLine('contrast-4', 'Retain punctuation: A-17.', 100, 610, 580, 42, { fill: '#999995' }),
    ],
  },
  {
    id: 'mild-skew',
    category: 'mild-skew',
    classification: 'supported',
    description: 'Latin text skewed three degrees clockwise without deskew preprocessing.',
    width: 1200,
    height: 800,
    dpi: 300,
    rotationDegrees: 3,
    lines: [
      textLine('skew-1', 'Mildly skewed scan', 160, 225, 550, 52),
      textLine('skew-2', 'Three degrees clockwise', 160, 365, 620, 46),
      textLine('skew-3', 'Document ID SK-300', 160, 505, 500, 44),
    ],
  },
  ...[90, 180, 270].map((degrees) => ({
    id: `rotation-${degrees}`,
    category: `page-rotation-${degrees}`,
    classification: 'unsupported',
    description: `${degrees}-degree raster orientation; the current engine has no orientation capability.`,
    width: 900,
    height: 900,
    dpi: 300,
    rotationDegrees: degrees,
    lines: [
      textLine(`rotation-${degrees}-1`, `Rotation ${degrees} degrees`, 245, 370, 410, 44),
      textLine(`rotation-${degrees}-2`, 'Orientation is not enabled', 205, 470, 490, 38),
      textLine(`rotation-${degrees}-3`, 'Explicit unsupported case', 215, 570, 470, 38),
    ],
  })),
  {
    id: 'mixed-image-native-text',
    category: 'mixed-image-native-text',
    classification: 'supported',
    description: 'Flattened raster containing image-origin and native-text-origin lines.',
    width: 1200,
    height: 900,
    dpi: 300,
    shapes: [
      '<rect x="60" y="65" width="1080" height="380" fill="#f1f1ec" stroke="#c3c3bc" stroke-width="3"/>',
      '<rect x="60" y="500" width="1080" height="300" fill="#ffffff" stroke="#6f6f6f" stroke-width="3"/>',
    ],
    lines: [
      textLine('mixed-1', 'SCANNED RECEIPT IMAGE', 105, 175, 660, 48, { layer: 'image', weight: 'bold' }),
      textLine('mixed-2', 'Item total 87.40 EUR', 105, 310, 500, 42, { layer: 'image' }),
      textLine('mixed-3', 'Native reference A-204', 105, 615, 560, 44, { layer: 'native-text' }),
      textLine('mixed-4', 'Archive note: verified', 105, 735, 500, 42, { layer: 'native-text' }),
    ],
  },
  {
    id: 'multiple-columns',
    category: 'multiple-columns',
    classification: 'supported',
    description: 'Two-column page with explicit column-major reading order.',
    width: 1300,
    height: 900,
    dpi: 300,
    shapes: ['<line x1="640" y1="95" x2="640" y2="800" stroke="#d0d0d0" stroke-width="2"/>'],
    lines: [
      textLine('columns-left-1', 'Left column heading', 70, 180, 470, 40, { weight: 'bold' }),
      textLine('columns-left-2', 'First left paragraph', 70, 305, 430, 36),
      textLine('columns-left-3', 'Second left paragraph', 70, 430, 455, 36),
      textLine('columns-right-1', 'Right column heading', 700, 180, 480, 40, { weight: 'bold' }),
      textLine('columns-right-2', 'First right paragraph', 700, 305, 445, 36),
      textLine('columns-right-3', 'Second right paragraph', 700, 430, 470, 36),
    ],
  },
  {
    id: 'forms-numeric',
    category: 'forms-and-numeric-content',
    classification: 'supported',
    description: 'Static form layout with identifiers, dates, decimals, and percentages.',
    width: 1200,
    height: 950,
    dpi: 300,
    shapes: [
      '<rect x="65" y="70" width="1070" height="780" fill="none" stroke="#222" stroke-width="3"/>',
      '<line x1="65" y1="230" x2="1135" y2="230" stroke="#777" stroke-width="2"/>',
      '<line x1="65" y1="390" x2="1135" y2="390" stroke="#777" stroke-width="2"/>',
      '<line x1="65" y1="550" x2="1135" y2="550" stroke="#777" stroke-width="2"/>',
      '<line x1="65" y1="710" x2="1135" y2="710" stroke="#777" stroke-width="2"/>',
    ],
    lines: [
      textLine('form-1', 'INVOICE FORM 2026-0816', 100, 175, 650, 44, { weight: 'bold' }),
      textLine('form-2', 'Account: A17-204-88', 100, 335, 530, 40),
      textLine('form-3', 'Date: 2026-08-16', 100, 495, 430, 40),
      textLine('form-4', 'Subtotal: 1,234.56 EUR', 100, 655, 560, 40),
      textLine('form-5', 'Tax: 20.00%  Total: 1,481.47', 100, 815, 760, 40),
    ],
  },
  {
    id: 'punctuation-unicode',
    category: 'punctuation-and-supported-unicode',
    classification: 'supported',
    description: 'Latin-script Unicode, diacritics, currency, typographic punctuation, and symbols.',
    width: 1300,
    height: 850,
    dpi: 300,
    lines: [
      textLine('unicode-1', 'Café naïve façade', 90, 190, 500, 48),
      textLine('unicode-2', 'Résumé: élève, déjà vu.', 90, 330, 620, 44),
      textLine('unicode-3', '€ 1,234.56 — discount 20%', 90, 470, 720, 44),
      textLine('unicode-4', '“Quoted text” • No. 42', 90, 610, 620, 44),
    ],
  },
  {
    id: 'dense-70-lines',
    category: 'dense-more-than-64-lines',
    classification: 'supported',
    description: 'Dense page with seventy independently labeled lines.',
    width: 1200,
    height: 2000,
    dpi: 300,
    lines: denseLines,
  },
  {
    id: 'blank-page',
    category: 'blank-page',
    classification: 'supported',
    description: 'Completely blank white page.',
    width: 1200,
    height: 800,
    dpi: 300,
    lines: [],
  },
  {
    id: 'no-text-image',
    category: 'no-text-image',
    classification: 'supported',
    description: 'Geometric illustration with no text content.',
    width: 1200,
    height: 800,
    dpi: 300,
    shapes: [
      '<rect x="100" y="100" width="330" height="220" rx="0" fill="#8fb9d8"/>',
      '<circle cx="760" cy="250" r="145" fill="#d9a26f"/>',
      '<path d="M 150 650 L 450 410 L 650 650 Z" fill="#79996c"/>',
      '<path d="M 720 650 C 820 420 980 420 1080 650" fill="none" stroke="#666" stroke-width="24"/>',
    ],
    lines: [],
  },
  {
    id: 'unsupported-table',
    category: 'table-layout',
    classification: 'unsupported',
    description: 'Table structure is outside the first-release reading-order scope.',
    width: 1200,
    height: 850,
    dpi: 300,
    shapes: [
      '<rect x="80" y="90" width="1040" height="600" fill="none" stroke="#222" stroke-width="3"/>',
      '<line x1="440" y1="90" x2="440" y2="690" stroke="#222" stroke-width="3"/>',
      '<line x1="780" y1="90" x2="780" y2="690" stroke="#222" stroke-width="3"/>',
      '<line x1="80" y1="250" x2="1120" y2="250" stroke="#222" stroke-width="3"/>',
      '<line x1="80" y1="420" x2="1120" y2="420" stroke="#222" stroke-width="3"/>',
      '<line x1="80" y1="590" x2="1120" y2="590" stroke="#222" stroke-width="3"/>',
    ],
    lines: [
      textLine('table-1', 'Item', 125, 190, 190, 38, { weight: 'bold' }),
      textLine('table-2', 'Count', 500, 190, 180, 38, { weight: 'bold' }),
      textLine('table-3', 'Value', 850, 190, 170, 38, { weight: 'bold' }),
      textLine('table-4', 'Alpha', 125, 355, 180, 36),
      textLine('table-5', '12', 500, 355, 80, 36),
      textLine('table-6', '48.20', 850, 355, 130, 36),
    ],
  },
  {
    id: 'unsupported-cyrillic',
    category: 'unsupported-script',
    classification: 'unsupported',
    description: 'Cyrillic is not listed by the bundled model pack.',
    width: 1200,
    height: 700,
    dpi: 300,
    lines: [
      textLine('cyrillic-1', 'Тестовая страница', 120, 220, 560, 50),
      textLine('cyrillic-2', 'Неподдерживаемый текст', 120, 380, 680, 46),
      textLine('cyrillic-3', 'Документ 2026', 120, 540, 400, 44),
    ],
  },
  {
    id: 'malformed-rgba',
    category: 'malformed-input',
    classification: 'rejected',
    description: 'RGBA buffer is one byte shorter than its declared dimensions.',
    rejection: { kind: 'malformed-rgba', width: 128, height: 64, expectedError: 'RGBA bytes; expected' },
  },
  {
    id: 'resource-heavy',
    category: 'resource-limit-enforcement',
    classification: 'rejected',
    description: 'Declared 10000 by 10000 source raster exceeds the bounded job without allocation.',
    rejection: {
      kind: 'resource-heavy-job',
      width: 10_000,
      height: 10_000,
      maximumPixels: 16_000_000,
      maximumSide: 8192,
      expectedError: 'exceed',
    },
  },
];

function textSvg(line) {
  const transforms = [];
  if (line.rotationDegrees) {
    transforms.push(`rotate(${line.rotationDegrees} ${line.rotationCenterX} ${line.rotationCenterY})`);
  }
  const transform = transforms.length ? ` transform="${transforms.join(' ')}"` : '';
  return `<text x="${line.x}" y="${line.baseline}" textLength="${line.width}" lengthAdjust="spacingAndGlyphs" font-family="BenchmarkSans" font-size="${line.fontSize}" font-weight="${line.weight === 'bold' ? 700 : 400}" fill="${line.fill}"${transform}>${xml(line.text)}</text>`;
}

async function renderFixture(fixture, regularFont, boldFont) {
  const rootTransform = fixture.rotationDegrees
    ? ` transform="rotate(${fixture.rotationDegrees} ${fixture.rotationCenterX ?? fixture.width / 2} ${fixture.rotationCenterY ?? fixture.height / 2})"`
    : '';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${fixture.width}" height="${fixture.height}" viewBox="0 0 ${fixture.width} ${fixture.height}">
  <style>
    @font-face { font-family: BenchmarkSans; src: url(data:font/ttf;base64,${regularFont}); font-weight: 400; }
    @font-face { font-family: BenchmarkSans; src: url(data:font/ttf;base64,${boldFont}); font-weight: 700; }
  </style>
  <rect width="100%" height="100%" fill="${fixture.background ?? '#ffffff'}"/>
  <g${rootTransform}>
    ${(fixture.shapes ?? []).join('\n    ')}
    ${(fixture.lines ?? []).map(textSvg).join('\n    ')}
  </g>
</svg>`;
  return sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 })
    .withMetadata({ density: fixture.dpi })
    .toBuffer();
}

export async function createOcrQualityFixtures(outputDir = defaultOutputDir) {
  await mkdir(outputDir, { recursive: true });
  const [regularFont, boldFont] = await Promise.all([
    readFile(regularFontPath, 'base64'),
    readFile(boldFontPath, 'base64'),
  ]);
  const corpus = {
    contract: 'open-pdf-studio.ocr.quality-corpus',
    schemaVersion: 1,
    corpusId: 'macos-searchable-ocr-v1',
    platformScope: ['macos'],
    generatedBy: 'scripts/generate-ocr-quality-fixtures.mjs',
    normalization: 'unicode-nfkc-casefold-collapse-whitespace-v1',
    geometrySpace: {
      id: 'source-raster-pixels',
      unit: 'pixel',
      origin: 'top-left-pixel-edge',
      xAxis: 'right',
      yAxis: 'down',
    },
    license: {
      fixtureContent: 'CC0-1.0',
      fixtureLicenseFile: '../LICENSE-CC0-1.0.txt',
      renderingFont: 'Liberation Sans',
      renderingFontLicense: 'SIL-OFL-1.1',
      renderingFontLicenseFile: '../../../../public/pdfjs/web/standard_fonts/LICENSE_LIBERATION',
    },
    excludedPassingScope: [
      'handwriting',
      'table-structure-recovery',
      'curved-text',
      'severe-perspective-warping',
      'scripts-not-listed-by-the-model-pack',
    ],
    fixtures: [],
  };

  for (const fixture of FIXTURES) {
    if (fixture.classification === 'rejected') {
      corpus.fixtures.push({
        id: fixture.id,
        category: fixture.category,
        classification: fixture.classification,
        description: fixture.description,
        input: { kind: fixture.rejection.kind, ...fixture.rejection },
        expected: {
          disposition: 'rejected',
          text: '',
          readingOrder: [],
          lines: [],
          geometry: 'not-applicable-before-allocation-or-inference',
        },
      });
      continue;
    }
    const bytes = await renderFixture(fixture, regularFont, boldFont);
    const file = `${fixture.id}.png`;
    await writeFile(path.join(outputDir, file), bytes);
    const lines = fixture.lines.map((line) => ({
      id: line.id,
      text: line.text,
      sourceLayer: line.layer,
      polygon: {
        coordinateSpace: 'source-raster-pixels',
        points: expectedPolygon(line, fixture),
      },
    }));
    corpus.fixtures.push({
      id: fixture.id,
      category: fixture.category,
      classification: fixture.classification,
      description: fixture.description,
      input: {
        kind: 'rgba-page-raster',
        file,
        widthPx: fixture.width,
        heightPx: fixture.height,
        dpi: fixture.dpi,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      },
      expected: {
        disposition: fixture.classification === 'unsupported' ? 'unsupported' : 'completed',
        text: lines.map((line) => line.text).join('\n'),
        readingOrder: lines.map((line) => line.id),
        lines,
      },
    });
  }

  await writeFile(path.join(outputDir, 'corpus.v1.json'), `${JSON.stringify(corpus, null, 2)}\n`);
  return corpus;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultOutputDir;
  const corpus = await createOcrQualityFixtures(outputDir);
  process.stdout.write(`Generated ${corpus.fixtures.length} OCR quality fixtures in ${outputDir}\n`);
}
