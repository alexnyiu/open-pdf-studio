import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(process.env.OPEN_PDF_STUDIO_LIST_FIXTURE_DIR || path.join(project, 'test-artifacts/repair-list-fixtures'));
await mkdir(directory, { recursive: true });
const manifest = { fixtures: [] };
async function fixture(name, populate) {
  const destination = path.join(directory, name);
  let bytes;
  try { bytes = await readFile(destination); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const document = await PDFDocument.create();
    document.setCreationDate(new Date('2026-01-01T00:00:00Z'));
    document.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    const font = await document.embedFont(StandardFonts.Helvetica);
    await populate(document, font);
    bytes = await document.save();
    // Existing fixtures retain their exact identity across acceptance runs.
    await writeFile(destination, bytes, { flag: 'wx' });
  }
  manifest.fixtures.push({ path: destination, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await fixture('annotations-10000.pdf', async (document, font) => {
  for (let number = 1; number <= 20; number++) {
    const page = document.addPage([612, 792]);
    page.drawText(`10,000 annotations: page ${number}`, { x: 36, y: 754, size: 12, font });
    const annotations = [];
    for (let index = 0; index < 500; index++) {
      const x = 20 + (index % 20) * 28, y = 40 + Math.floor(index / 20) * 26;
      annotations.push(document.context.register(document.context.obj({
        Type: 'Annot', Subtype: 'Square', Rect: [x, y, x + 20, y + 18],
        C: [0.2, 0.4, 0.8], Border: [0, 0, 0.5], F: 4,
        T: PDFString.of('Acceptance fixture'),
        CreationDate: PDFString.of('D:20260101000000Z'),
        M: PDFString.of('D:20260101000000Z'),
      })));
    }
    page.node.set(PDFName.of('Annots'), document.context.obj(annotations));
  }
});
for (const revised of [false, true]) {
  await fixture(`light-${revised ? 'revised' : 'original'}-500.pdf`, async (document, font) => {
    for (let number = 1; number <= 500; number++) {
      const page = document.addPage([612, 792]);
      for (let line = 0; line < 20; line++) {
        const content = revised && line % 2 ? 'Updated statement' : 'Original statement';
        page.drawText(`Page ${number}, line ${line}: ${content} for this record.`, { x: 36, y: 750 - line * 30, size: 11, font });
      }
    }
  });
}
await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(directory);
