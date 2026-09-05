import {startPackagedApp} from './lib/macos-packaged-app.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures=path.resolve(process.env.OPEN_PDF_STUDIO_LIST_FIXTURE_DIR || path.join(root,'open-pdf-studio/test-artifacts/repair-list-fixtures'));
const out=path.resolve(process.env.OPEN_PDF_STUDIO_LIST_REPORT_DIR || path.join(root,'open-pdf-studio/test-artifacts/large-comparison-list'));
await mkdir(out,{recursive:true});
const app=await startPackagedApp({appBundle:process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || root+'/target/aarch64-apple-darwin/release/bundle/macos/Open PDF Studio.app',cwd:root+'/open-pdf-studio',artifactDir:out});
const report={identity:app.identity,samples:[],fixtures:[],status:'UNVERIFIED'};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const ui=selector=>app.callTool('app_ui_state',{selector,searchTabs:false});
const click=async selector=>{const r=await app.callTool('app_click_element',{selector,searchTabs:selector.startsWith('#ribbon')});if(!r.clicked)throw Error('Could not click '+selector);return r;};
const open=async name=>{const path=fixtures+'/'+name;report.fixtures.push({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')});console.log('Opening',name);await app.callTool('app_open_pdf',{path});};
try{
 await app.callTool('app_set_window_size',{width:1440,height:960,keepVisible:true});
 await app.callTool('app_reset_performance_metrics');
 let start;
 await open('light-original-500.pdf');await open('light-revised-500.pdf');
 await click('#ribbon-compare');await click('.cmp-dialog-footer .pref-btn-primary');
 start=performance.now();await click('.compare-change-list > div:first-child button:nth-child(2)');
 for(let i=0;i<300;i++){const list=await ui('.compare-change-list');if(/Text \(5000\)/i.test(list.text||'')){report.comparison=list;break;}await wait(200);}
 report.comparisonElapsedMs=performance.now()-start;
 report.comparison=await ui('.compare-change-list');report.metrics=await app.callTool('app_get_performance_metrics');

 report.mounted=await ui('.compare-change-list div[style*="cursor: pointer"]');
 for(let i=0;i<3;i++){
  await click('.compare-change-list > div:first-child button:nth-child(1)');
  const begin=performance.now();await click('.compare-change-list > div:first-child button:nth-child(2)');await ui('.compare-change-list');
  report.samples.push({label:'show-text-list',roundTripMs:performance.now()-begin});
 }

 report.virtualRows=await ui('.compare-text-list [data-virtual-key]');
 if(report.virtualRows.matchCount>=100)throw Error('Unbounded text list');
 await click('.compare-text-list [data-virtual-key]');
 await app.callTool('app_key',{key:'End'});
 for(let i=0;i<100;i++){if((await ui('.compare-text-list [aria-posinset="5000"] [role="button"]')).focused)break;await wait(100);}
 report.lastFocus=await ui('.compare-text-list [aria-posinset="5000"] [role="button"]');
 if(!report.lastFocus.focused)throw Error('Last text difference did not receive focus');
 await app.callTool('app_key',{key:'Enter'});
 for(let i=0;i<100;i++){if((await ui('.compare-toolbar')).text?.includes('500/500'))break;await wait(100);}
 report.selectedPages=await ui('.compare-toolbar');
 if(!report.selectedPages.text.includes('500/500'))throw Error('Text selection did not navigate to page 500');
 await app.callTool('app_key',{key:'Home'});
 for(let i=0;i<100;i++){if((await ui('.compare-text-list [aria-posinset="1"] [role="button"]')).focused)break;await wait(100);}
 report.homeFocus=await ui('.compare-text-list [aria-posinset="1"] [role="button"]');
 if(!report.homeFocus.focused)throw Error('Home did not focus first difference');
 await click('.compare-tab .document-tab-close');report.afterClose=await app.callTool('app_get_performance_metrics');
 for(const [name,count] of Object.entries(report.afterClose.comparisonResources))if(count!==0)throw Error(`Comparison retained ${name}: ${count}`);
 report.status='PASS';
}catch(error){report.error=error.stack;report.console=await app.callTool('app_get_recent_console',{tail:50});throw error;}finally{await writeFile(out+'/report.json',JSON.stringify(report,null,2));await app.stop();}
