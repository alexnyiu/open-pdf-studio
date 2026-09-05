import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
let executablePath;
try { await access(chromium.executablePath()); }
catch { executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; }
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
 const page = await browser.newPage();
 await page.goto('http://127.0.0.1:3041', { waitUntil: 'networkidle' });
 const result = await page.evaluate(async () => {
  // Supplemental fault injection around a real loaded PDF; no save/output calls.
  const { createTab } = await import('/js/ui/chrome/tabs.js');
  const { loadPDF } = await import('/js/pdf/loader.js');
  const { getActiveDocument, state } = await import('/js/core/state.ts');
  const { performSearch, executeProgressiveSearch, executeSearch } = await import('/js/search/find-controller.js');
  const { invalidateTextCache } = await import('/js/search/text-cache.js');
  const data = new Uint8Array(await (await fetch('/tests/fixtures/text/native-paragraph-table.pdf')).arrayBuffer());
  const tab = createTab('__memory__search-terminal.pdf');
  await loadPDF(tab.doc.filePath, tab.index, data);
  const owner = getActiveDocument(), pdfPage = await owner.pdfDoc.getPage(1);
  const original = pdfPage.getTextContent, content = await original.call(pdfPage);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const timeout = (promise, label) => Promise.race([promise, wait(5000).then(() => { throw Error(label); })]);
  const gate = () => {
   invalidateTextCache(owner.id);
   let resolve, reject, enter;
   const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
   const entered = new Promise(yes => { enter = yes; });
   pdfPage.getTextContent = () => { enter(); return promise; };
   return { resolve: () => resolve(content), reject: () => reject(Error('Injected extraction failure')), entered };
  };
  const progressive = () => {
   state.search.query = 'ARCALYST';
   const events = []; let finish;
   const done = new Promise(resolve => { finish = resolve; });
   const cancel = executeProgressiveSearch((results, pages, total, terminal, outcome) => {
    events.push({ terminal, outcome, count: results.length });
    if (terminal) finish(outcome);
   });
   return { events, done, cancel };
  };
  try {
   const firstGate = gate(), first = performSearch('ARCALYST');
   await timeout(firstGate.entered, 'first legacy search did not start');
   const secondGate = gate(), second = performSearch('ARCALYST');
   await timeout(secondGate.entered, 'second legacy search did not start');
   firstGate.resolve(); await first;
   const newerLegacyRemainsBusy = state.search.isSearching;
   secondGate.resolve(); await second;
   const legacyCompletedIdle = !state.search.isSearching;
   const oldGate = gate(), old = progressive();
   await timeout(oldGate.entered, 'old progressive search did not start');
   const newGate = gate(), newer = progressive();
   await timeout(newGate.entered, 'new progressive search did not start');
   oldGate.reject();
   const superseded = await timeout(old.done, 'superseded request did not terminate');
   newGate.resolve(); const completed = await timeout(newer.done, 'new request did not complete');
   const cancelGate = gate(), cancelledRun = progressive();
   await timeout(cancelGate.entered, 'cancelled request did not start');
   const start = performance.now(); cancelledRun.cancel();
   const cancelled = await cancelledRun.done, cancelMs = performance.now() - start;
   cancelGate.resolve(); await wait(20);
   const failureGate = gate(), failedRun = progressive();
   await timeout(failureGate.entered, 'failure request did not start');
   failureGate.reject(); const failed = await timeout(failedRun.done, 'failure did not terminate');
   state.search.query = ''; let empty;
   executeProgressiveSearch((_, __, ___, done, outcome) => { if (done) empty = outcome; });
   const clearedGate = gate();
   state.search.query = 'ARCALYST';
   const clearedRun = executeSearch();
   await timeout(clearedGate.entered, 'cleared search did not start');
   state.search.query = '';
   await executeSearch();
   const clearedImmediatelyIdle = !state.search.isSearching;
   clearedGate.resolve(); await clearedRun;
   const clearedResultsStayEmpty = state.search.results.length === 0 && state.search.totalMatches === 0;
   return { label: 'supplemental injected search lifecycle regression; no saves', newerLegacyRemainsBusy,
    legacyCompletedIdle, superseded, completed, cancelled, cancelMs, failed, empty,
    clearedImmediatelyIdle, clearedResultsStayEmpty,
    cancelledTerminalCount: cancelledRun.events.filter(event => event.terminal).length };
  } finally { pdfPage.getTextContent = original; invalidateTextCache(owner.id); }
 });
 const output = path.resolve(process.env.OPEN_PDF_STUDIO_SEARCH_FAULT_REPORT || 'test-artifacts/search-terminal-states/report.json');
 await mkdir(path.dirname(output), { recursive: true });
 await writeFile(output, JSON.stringify(result, null, 2));
 assert.equal(result.newerLegacyRemainsBusy, true);
 assert.equal(result.legacyCompletedIdle, true);
 assert.equal(result.superseded.status, 'superseded');
 assert.equal(result.completed.status, 'completed');
 assert.equal(result.cancelled.status, 'cancelled');
 assert.equal(result.failed.status, 'failed');
 assert.equal(result.empty.status, 'completed');
 assert.ok(result.completed.requestId > result.superseded.requestId);
 assert.ok(result.empty.requestId > result.failed.requestId);
 assert.equal(result.cancelledTerminalCount, 1);
 assert.ok(result.cancelMs <= 250);
 assert.equal(result.clearedImmediatelyIdle, true);
 assert.equal(result.clearedResultsStayEmpty, true);
 console.log('Search terminal-state fault injection: PASS');
} finally { await browser.close(); }
