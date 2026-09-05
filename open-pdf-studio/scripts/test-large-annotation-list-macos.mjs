import {startPackagedApp} from './lib/macos-packaged-app.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures=path.resolve(process.env.OPEN_PDF_STUDIO_LIST_FIXTURE_DIR || path.join(root,'open-pdf-studio/test-artifacts/repair-list-fixtures'));
const out=path.resolve(process.env.OPEN_PDF_STUDIO_LIST_REPORT_DIR || path.join(root,'open-pdf-studio/test-artifacts/large-annotation-list'));
await mkdir(out,{recursive:true});
const app=await startPackagedApp({appBundle:process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || root+'/target/aarch64-apple-darwin/release/bundle/macos/Open PDF Studio.app',cwd:root+'/open-pdf-studio',artifactDir:out});
const report={identity:app.identity,samples:[],fixtures:[],status:'UNVERIFIED'};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const ui=selector=>app.callTool('app_ui_state',{selector,searchTabs:false});
const click=async selector=>{const r=await app.callTool('app_click_element',{selector,searchTabs:false});if(!r.clicked)throw Error('Could not click '+selector);return r;};
const open=async name=>{const path=fixtures+'/'+name;report.fixtures.push({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')});console.log('Opening',name);await app.callTool('app_open_pdf',{path});};
try{
 await app.callTool('app_set_window_size',{width:1440,height:960,keepVisible:true});
 await app.callTool('app_reset_performance_metrics');
 let start=performance.now();await open('annotations-10000.pdf');
 report.samples.push({label:'open-annotation-document',roundTripMs:performance.now()-start});
 await click('.left-panel-tab[data-panel="annotations"]');
 for(let i=0;i<200;i++){const count=await ui('.annotations-list-count');if(count.text?.includes('10000'))break;await wait(100);}
 console.log('Annotation count wait ended');report.annotationCount=await ui('.annotations-list-count');
 report.rows=await ui('.annotation-list-item');
 report.annotationMetrics=await app.callTool('app_get_performance_metrics');
 for(let i=0;i<5;i++){
  start=performance.now();await click('.annotations-toolbar-btn[title="Collapse All"]');await ui('.annotations-list-page-header');report.samples.push({label:'collapse',roundTripMs:performance.now()-start});
  start=performance.now();await click('.annotations-toolbar-btn[title="Expand All"]');await ui('.annotation-list-item');report.samples.push({label:'expand',roundTripMs:performance.now()-start});
 }
 report.expandedRows=await ui('.annotation-list-item');

 if(report.expandedRows.matchCount>=100)throw Error('Unbounded mounted rows');
 await click('[data-virtual-key^="annotation:"]');
 await app.callTool('app_key',{key:'End'});
 for(let i=0;i<100;i++){if((await ui('[aria-posinset="10020"] [role="button"]')).focused)break;await wait(100);}
 report.lastFocus=await ui('[aria-posinset="10020"] [role="button"]');
 if(!report.lastFocus.focused)throw Error('Last annotation did not receive focus');
 await app.callTool('app_key',{key:'Enter'});
 for(let i=0;i<100;i++){const view=await app.callTool('app_get_viewport_state');if(view.doc.currentPage===20)break;await wait(100);}
 await wait(500);
 report.selectedView=await app.callTool('app_get_viewport_state');
 report.selectedRow=await ui('.annotation-list-item.selected');
 if(report.selectedView.doc.currentPage!==20)throw Error('Selecting the final annotation did not stay on page 20');
 await app.callTool('app_key',{key:'Home'});
 for(let i=0;i<100;i++){if((await ui('[aria-posinset="1"] [role="button"]')).focused)break;await wait(100);}
 report.homeFocus=await ui('[aria-posinset="1"] [role="button"]');
 if(!report.homeFocus.focused)throw Error('Home did not restore the first group focus');
 const capture=await app.callTool('app_screenshot_view');
 if(capture.png_base64)await writeFile(out+'/final.png',Buffer.from(capture.png_base64,'base64'));
 report.metrics=await app.callTool('app_get_performance_metrics');
 report.status='PASS';
}catch(error){report.error=error.stack;report.console=await app.callTool('app_get_recent_console',{tail:50});throw error;}finally{await writeFile(out+'/report.json',JSON.stringify(report,null,2));await app.stop();}
