import assert from 'node:assert/strict';
import {startPackagedApp} from './lib/macos-packaged-app.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out=path.resolve(process.env.OPEN_PDF_STUDIO_COMPARISON_REPORT_DIR || path.join(root,'open-pdf-studio/test-artifacts/comparison-lifecycle'));
await mkdir(out,{recursive:true});
const app=await startPackagedApp({appBundle:process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || root+'/target/aarch64-apple-darwin/release/bundle/macos/Open PDF Studio.app',cwd:root+'/open-pdf-studio',artifactDir:out});
const report={identity:app.identity,fixtures:[],cycles:[],status:'FAIL'};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const ui=selector=>app.callTool('app_ui_state',{selector,searchTabs:false});
const click=selector=>app.callTool('app_click_element',{selector,searchTabs:false});
try{
 await app.callTool('app_set_window_size',{width:1440,height:960,keepVisible:true});
 for(const fixture of ['test-artifacts/generated-large-pdf-fixtures/lightweight-500.pdf','tests/fixtures/text/native-paragraph-table.pdf']) {
  const fixturePath=path.join(root,'open-pdf-studio',fixture);
  report.fixtures.push({path:fixturePath,sha256:createHash('sha256').update(await readFile(fixturePath)).digest('hex')});
  await app.callTool('app_open_pdf',{path:fixturePath});
 }
 for(let i=0;i<4;i++){
  await app.callTool('app_click_element',{selector:'#ribbon-compare'});
  await click('.cmp-dialog-footer .pref-btn-primary');
  await click('.compare-change-list > div:first-child button:nth-child(2)');
  if(i%2===0)await wait(3500);
  const active=await app.callTool('app_get_performance_metrics');
  const content=await ui('.compare-change-list');
  const started=performance.now();
  await click('.compare-tab .document-tab-close');
  assert.equal((await ui('.compare-view')).found,false);
  const closed=await app.callTool('app_get_performance_metrics');
  const elapsed=performance.now()-started;
  report.cycles.push({cycle:i,active:active.comparisonResources,content,closed:closed.comparisonResources,closeRoundTripMs:elapsed});
  for(const [name,count] of Object.entries(closed.comparisonResources))assert.equal(count,0,`cycle ${i} retained ${name}`);
  await wait(300);
  const settled=await app.callTool('app_get_performance_metrics');
  report.cycles.at(-1).settled=settled.comparisonResources;
  for(const [name,count] of Object.entries(settled.comparisonResources))assert.equal(count,0,`cycle ${i} late publication retained ${name}`);
  console.log(`Comparison lifecycle cycle ${i + 1}: PASS`);
 }
 await app.callTool('app_close_tab',{index:1,force:false});
 await app.callTool('app_close_tab',{index:0,force:false});
 report.final=await app.callTool('app_get_performance_metrics');
 report.status='PASS';
}catch(error){report.error=error.stack;throw error;}finally{await writeFile(out+'/report.json',JSON.stringify(report,null,2));await app.stop();}
