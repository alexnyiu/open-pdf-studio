import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const inputPath = argument('--input');
const maximumPages = Number(argument('--maximum-pages'));
const maximumInputBytes = Number(argument('--maximum-input-bytes'));
if (!inputPath || !Number.isSafeInteger(maximumPages) || maximumPages < 1
    || !Number.isSafeInteger(maximumInputBytes) || maximumInputBytes < 1) {
  throw new Error('usage: --input PATH --maximum-pages N --maximum-input-bytes N');
}

const started = Date.now();
const initialRssBytes = process.memoryUsage().rss;
let report;
try {
  const information = await stat(inputPath);
  if (information.size > maximumInputBytes) {
    report = { outcome: 'rejected', reason: 'input-byte-limit', inputBytes: information.size };
  } else {
    const bytes = await readFile(inputPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const task = pdfjsLib.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      stopAtErrors: true,
      verbosity: 0,
    });
    const document = await task.promise;
    try {
      if (document.numPages > maximumPages) {
        report = {
          outcome: 'rejected',
          reason: 'page-count-limit',
          pageCount: document.numPages,
          inputBytes: information.size,
          sha256,
        };
      } else {
        let operators = 0;
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          const page = await document.getPage(pageNumber);
          const list = await page.getOperatorList();
          operators += list.fnArray.length;
          if (operators > 1_000_000) throw new Error('operator budget exceeded');
        }
        report = {
          outcome: 'bounded-completion',
          pageCount: document.numPages,
          operators,
          inputBytes: information.size,
          sha256,
        };
      }
    } finally {
      await document.destroy();
    }
  }
} catch (error) {
  report = {
    outcome: 'failed-safely',
    error: { name: error.name, message: error.message },
  };
}

report.elapsedMs = Date.now() - started;
report.initialRssBytes = initialRssBytes;
report.finalRssBytes = process.memoryUsage().rss;
process.stdout.write(`${JSON.stringify(report)}\n`);
