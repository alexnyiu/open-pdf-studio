import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFName, PDFRawStream, PDFString, rgb } from 'pdf-lib';
import { getActiveDocument } from '../../core/state.js';
import { loadPackagedFaceBytes, shapeRichTextDocument } from '../../text/font-catalog.js';
import { isTextEditRecordV2, migrateTextEditRecords } from '../../text/rich-text.js';
import { assertOwnedTextEditStable, writeOwnedTextEditManifest } from '../../text/owned-edit-manifest.js';
import { hexToRgb } from './utils.js';

const OWNED_LAYER_KEY = PDFName.of('OPDSOwnedTextLayer');

function removePreviouslyOwnedLayer(pdfDocument, page, layerId) {
  const contents = page.node.lookup(PDFName.of('Contents'));
  if (!contents) return;
  const refs = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, index) => contents.get(index))
    : [page.node.get(PDFName.of('Contents'))];
  const kept = refs.filter((ref) => {
    const stream = pdfDocument.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return true;
    return stream.dict.get(OWNED_LAYER_KEY)?.decodeText?.() !== layerId;
  });
  if (kept.length === 0) page.node.delete(PDFName.of('Contents'));
  else if (kept.length === 1) page.node.set(PDFName.of('Contents'), kept[0]);
  else page.node.set(PDFName.of('Contents'), pdfDocument.context.obj(kept));
}

function lineAdvance(line) {
  return line.runs.reduce((sum, run) => sum + (run.shaped?.advance || run.geometry?.width || 0), 0);
}

function lineStartX(document, line) {
  const advance = lineAdvance(line);
  if (line.alignment === 'center') return document.region.x + (document.region.width - advance) / 2;
  if (line.alignment === 'right') return document.region.x + document.region.width - advance;
  return document.region.x;
}

async function prepareRecords(records) {
  const migration = migrateTextEditRecords(records);
  if (migration.rejected.length > 0) {
    throw new Error(`Unsafe legacy text edit is read-only: ${migration.rejected[0].error}`);
  }
  for (const record of migration.migrated) {
    if (record.original && !record.sourceProvenance) {
      throw new Error(`Native text edit ${record.id} cannot be saved because its source operators are not provenance-linked`);
    }
    if (record.original) {
      throw new Error(`Native text edit ${record.id} is read-only because exact source-operator neutralization is unavailable`);
    }
    const layout = await shapeRichTextDocument(record.richText);
    if (layout.overflow) {
      throw new Error(`Text edit ${record.id} rejected: ${layout.rejectionReasons.join('; ')}`);
    }
    record.richText.lines = layout.lines;
  }
  assertOwnedTextEditStable(migration.migrated);
  return migration.migrated;
}

// Persist V2 rich text as one replaceable application-owned content layer per page.
// Every face is embedded/subsetted; the Standard 14 fabricated-font path is not used.
export async function saveTextEditsToPages(pdfDocument, pages) {
  const documentState = getActiveDocument();
  if (!documentState?.textEdits?.length) return null;

  const records = await prepareRecords(documentState.textEdits);
  pdfDocument.registerFontkit(fontkit);

  const usedFaceIds = new Set(records.flatMap((record) => record.richText.lines
    .flatMap((line) => line.runs.map((run) => run.faceId))));
  const embeddedFonts = new Map();
  for (const faceId of usedFaceIds) {
    embeddedFonts.set(faceId, await pdfDocument.embedFont(
      await loadPackagedFaceBytes(faceId),
      { subset: true },
    ));
  }

  const recordsByPage = new Map();
  for (const record of records) {
    if (!recordsByPage.has(record.page)) recordsByPage.set(record.page, []);
    recordsByPage.get(record.page).push(record);
  }

  for (const [pageNumber, pageRecords] of recordsByPage) {
    const page = pages[pageNumber - 1];
    if (!page) throw new Error(`Text edit page ${pageNumber} is outside the PDF`);
    const layerId = `OpenPDFStudioTextEditPage-${pageNumber}`;
    removePreviouslyOwnedLayer(pdfDocument, page, layerId);

    for (const record of pageRecords) {
      const richText = record.richText;
      for (const line of richText.lines) {
        let cursorX = lineStartX(richText, line);
        for (const run of line.runs) {
          if (!run.text) continue;
          const embeddedFont = embeddedFonts.get(run.faceId);
          if (!embeddedFont) throw new Error(`Embedded face missing for ${run.faceId}`);
          const [red, green, blue] = hexToRgb(run.color);
          const color = rgb(red, green, blue);
          page.drawText(run.text, { x: cursorX, y: line.baseline, size: run.size, font: embeddedFont, color });
          const shaped = run.shaped;
          const width = shaped?.advance ?? embeddedFont.widthOfTextAtSize(run.text, run.size);
          if (run.underline || run.strikeout) {
            const metrics = shaped?.metrics;
            if (!metrics) throw new Error(`Decoration metrics missing for ${run.id}`);
            if (run.underline) {
              page.drawLine({
                start: { x: cursorX, y: line.baseline + metrics.underlinePosition },
                end: { x: cursorX + width, y: line.baseline + metrics.underlinePosition },
                thickness: metrics.underlineThickness,
                color,
              });
            }
            if (run.strikeout) {
              page.drawLine({
                start: { x: cursorX, y: line.baseline + metrics.strikeoutPosition },
                end: { x: cursorX + width, y: line.baseline + metrics.strikeoutPosition },
                thickness: metrics.strikeoutThickness,
                color,
              });
            }
          }
          cursorX += width;
        }
      }
    }
    page.getContentStream().dict.set(OWNED_LAYER_KEY, PDFString.of(layerId));
  }

  const documentId = documentState.textEditManifest?.documentId || documentState.id || `document-${Date.now().toString(36)}`;
  const manifest = await writeOwnedTextEditManifest(
    pdfDocument,
    documentId,
    records,
    documentState.textEditManifest || 0,
  );
  return manifest;
}

export function isOwnedRichTextEdit(record) {
  return isTextEditRecordV2(record);
}
