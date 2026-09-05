import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
let executablePath;
try { await access(chromium.executablePath()); }
catch { executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; }
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
 const page=await browser.newPage(); await page.goto('http://127.0.0.1:3041',{waitUntil:'networkidle'});
 // Supplemental browser regression: use the real document loader and output services.
 const result=await page.evaluate(async()=>{
  const {createTab,closeTab}=await import('/js/ui/chrome/tabs.js');
  const {loadPDF}=await import('/js/pdf/loader.js');
  const {getActiveDocument}=await import('/js/core/state.ts');
  const {captureOutputSource,createOutputJob}=await import('/js/pdf/output-job.js');
  const {renderPageOffscreen}=await import('/js/pdf/exporter.js');
  const {reloadFromBytes,insertBlankPages}=await import('/js/pdf/page-manager.js');
  const {undo}=await import('/js/core/undo-manager.js');
  const {getCachedPdfBytes}=await import('/js/pdf/loader.js');
  const {printCancellation}=await import('/js/solid/stores/printProgressStore.js');
  const {richTextFromPlainText,createTextEditRecordV2}=await import('/js/text/rich-text.js');
  const {noteDocumentMutation}=await import('/js/core/document-revision-state.runtime.js');
  async function open(name){const data=new Uint8Array(await (await fetch('/tests/fixtures/text/'+name+'.pdf')).arrayBuffer());const item=createTab('__memory__'+name+'.pdf');await loadPDF(item.doc.filePath,item.index,data);return item;}
  const a=await open('native-paragraph-table');
  const originalProxy=a.doc.pdfDoc, originalPath=a.doc.filePath;
  const originalBytes=getCachedPdfBytes(originalPath), originalAnnotations=a.doc.annotations;
  let rejectedReplacement=false;
  try { await reloadFromBytes(new Uint8Array([1,2,3]), [], {}, 1); } catch { rejectedReplacement=true; }
  const failedReplacementPreserved=rejectedReplacement && a.doc.pdfDoc===originalProxy
    && a.doc.filePath===originalPath && getCachedPdfBytes(originalPath)===originalBytes
    && a.doc.annotations===originalAnnotations;
  await insertBlankPages('after', 1, 1, 612, 792);
  const command=a.doc.undoStack.at(-1), validOldBytes=command.oldBytes;
  const undoBefore=a.doc.undoStack.length, redoBefore=a.doc.redoStack.length;
  const insertedProxy=a.doc.pdfDoc, revisionBefore=a.doc.revisionState.contentRevision;
  // Fault injection only: simulate an unreadable retained history payload.
  command.oldBytes=new Uint8Array([1,2,3]);
  let rejectedUndo=false;
  try { await undo(); } catch { rejectedUndo=true; }
  const failedUndoPreserved=rejectedUndo && a.doc.pdfDoc===insertedProxy
    && a.doc.undoStack.length===undoBefore && a.doc.redoStack.length===redoBefore
    && a.doc.undoStack.at(-1)===command && a.doc.revisionState.contentRevision===revisionBefore;
  command.oldBytes=validOldBytes;
  await undo();
  const recoveredUndo=a.doc.pdfDoc.numPages===originalProxy.numPages;
  const source=captureOutputSource(); const job=await createOutputJob('Output regression',source);
  const signature=async()=>{const canvas=await renderPageOffscreen(1,1,job.snapshot,job.signal);const value=canvas.toDataURL();canvas.width=canvas.height=0;return value;};
  const before=await signature();
  const b=await open('native-side-by-side-color'); b.doc.scale=1.37;
  a.doc.pageRotations[1]=90;
  await closeTab(0,true);
  const scaleBefore=getActiveDocument().scale;
  const after=await signature(); const scale=getActiveDocument().scale;
  const terminal=await job.finish('completed','Complete');
  const cancelJob=await createOutputJob('Cancellation regression');
  const t=performance.now(); printCancellation()();
  let cancelled=false;try{cancelJob.check();}catch{cancelled=true;}
  const cancelMs=performance.now()-t;await cancelJob.finish('cancelled','Cancelled');
  // Supplemental service test: a committed owned record whose save has not
  // run yet. Change and close its owner while the detached writer prepares it.
  const rich=richTextFromPlainText('Submitted-owned-text', {faceId:'liberation-sans-regular',size:12},
    {x:36,y:670,width:300,height:40,baseline:690});
  b.doc.textEdits=[createTextEditRecordV2({id:'output-owned-regression',page:1,richText:rich})];
  noteDocumentMutation(b.doc,{pages:[1],reason:'output-owned-regression'});
  const persistedBefore=b.doc.revisionState.persistedRevision;
  const textSource=captureOutputSource(b.doc);
  const textJobPromise=createOutputJob('Unsaved owned text',textSource);
  b.doc.textEdits=[];
  noteDocumentMutation(b.doc,{pages:[1],reason:'later-output-revision'});
  await closeTab(0,true);
  const textJob=await textJobPromise;
  const text=(await(await textJob.snapshot.pdfDoc.getPage(1)).getTextContent()).items.map(item=>item.str).join(' ');
  const ownedRevisionText=text.includes('Submitted-owned-text');
  const ownedDidNotSave=b.doc.revisionState.persistedRevision===persistedBefore;
  await textJob.finish('completed','Owned output prepared');
  return {ownedRevisionText,ownedDidNotSave,failedUndoPreserved,recoveredUndo,failedReplacementPreserved,identical:before===after,scale,scaleBefore,terminal,cancelled,cancelMs,ownerClosed:getActiveDocument()==null};
 });
 const output = path.resolve(process.env.OPEN_PDF_STUDIO_OUTPUT_OWNERSHIP_REPORT || 'test-artifacts/output-ownership/report.json');
 await mkdir(path.dirname(output), { recursive: true });
 await writeFile(output,JSON.stringify(result,null,2));
 assert.equal(result.ownedRevisionText,true);assert.equal(result.ownedDidNotSave,true);assert.equal(result.failedReplacementPreserved,true);assert.equal(result.failedUndoPreserved,true);assert.equal(result.recoveredUndo,true);assert.equal(result.identical,true); assert.equal(result.scale,result.scaleBefore); assert.equal(result.ownerClosed,true);assert.equal(result.cancelled,true);assert.ok(result.cancelMs<250);
 console.log(result);
}finally{await browser.close();}
