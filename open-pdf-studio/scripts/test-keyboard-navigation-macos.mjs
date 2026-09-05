import assert from 'node:assert/strict';
import {startPackagedApp} from './lib/macos-packaged-app.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out=path.resolve(process.env.OPEN_PDF_STUDIO_KEYBOARD_REPORT_DIR || path.join(root,'open-pdf-studio/test-artifacts/keyboard-navigation'));
await mkdir(out,{recursive:true});
const app=await startPackagedApp({appBundle:process.env.OPEN_PDF_STUDIO_PACKAGED_APP_BUNDLE || root+'/target/aarch64-apple-darwin/release/bundle/macos/Open PDF Studio.app',cwd:root+'/open-pdf-studio',artifactDir:out});
const report={identity:app.identity,checks:[],status:'FAIL'};
const ui=selector=>app.callTool('app_ui_state',{selector,searchTabs:false});
const key=async key=>{const result=await app.callTool('app_key',{key});report.checks.push({key,result});return result;};
const click=selector=>app.callTool('app_click_element',{selector,searchTabs:false});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await app.callTool('app_set_window_size',{width:1440,height:960,keepVisible:true});
 await app.callTool('app_open_pdf',{path:root+'/open-pdf-studio/test-artifacts/generated-large-pdf-fixtures/lightweight-500.pdf'});
 await app.callTool('app_open_pdf',{path:root+'/open-pdf-studio/tests/fixtures/text/native-paragraph-table.pdf'});
 await click('.document-tab[aria-selected="true"]');
 await key('Home');await wait(200);
 let tab=await ui('.document-tab[aria-selected="true"]');
 report.checks.push({label:'tab-home',tab});assert.equal(tab.focused,true);assert.match(tab.text,/lightweight/);
 await key('End');await wait(200);
 tab=await ui('.document-tab[aria-selected="true"]');
 report.checks.push({label:'tab-end',tab});assert.equal(tab.focused,true);assert.match(tab.text,/native/);
 await key('Home');await wait(250);
 await click('.thumbnail-item[data-page="1"]');
 await key('End');
 for(let i=0;i<100;i++){if((await ui('.thumbnail-item[data-page="500"]')).focused)break;await wait(100);}
 const thumb=await ui('.thumbnail-item[data-page="500"]');
 report.checks.push({label:'thumbnail-end',thumb});assert.equal(thumb.focused,true);
 await key('Home');
 for(let i=0;i<100;i++){if((await ui('.thumbnail-item[data-page="1"]')).focused)break;await wait(100);}
 const first=await ui('.thumbnail-item[data-page="1"]');
 report.checks.push({label:'thumbnail-home',thumb:first});assert.equal(first.focused,true);
 await app.callTool('app_click_element',{selector:'#facing-view'});
 await click('.thumbnail-item[data-page="1"]');
 for(const page of [2,3,4]){
  await key('ArrowDown');
  const selector=`.thumbnail-item[data-page="${page}"]`;
  for(let i=0;i<100;i++){if((await ui(selector)).focused)break;await wait(100);}
  const target=await ui(selector);
  report.checks.push({label:`facing-thumbnail-${page}`,thumb:target});
  assert.equal(target.focused,true,`facing page ${page} focus`);
  assert.equal((await ui(`${selector}[aria-pressed="true"][tabindex="0"]`)).found,true);
 }
 await click('.document-tab[aria-selected="true"]');
 await app.callTool('app_key',{key:'F10',shift:true});
 for(let i=0;i<30;i++){if((await ui('.document-tab-ctxmenu button:first-child')).focused)break;await wait(100);}
 const menuFirst=await ui('.document-tab-ctxmenu button:first-child');
 assert.equal(menuFirst.focused,true);assert.equal(menuFirst.text,'Open in new window');
 await key('End');
 const menuLast=await ui('.document-tab-ctxmenu button:last-child');
 assert.equal(menuLast.focused,true);assert.equal(menuLast.text,'Close');
 await key('Escape');
 assert.equal((await ui('.document-tab-ctxmenu')).found,false);
 assert.equal((await ui('.document-tab[aria-selected="true"]')).focused,true);
 report.checks.push({label:'keyboard-tab-context-menu',menuFirst,menuLast});
 report.status='PASS';
 console.log('Packaged tab and virtualized thumbnail keyboard navigation: PASS');
}catch(error){report.error=error.stack;report.view=await app.callTool('app_get_viewport_state');report.thumbnails=await ui('#thumbnails-container');report.focus=await ui(':focus');report.console=await app.callTool('app_get_recent_console',{tail:80});throw error;}finally{await writeFile(out+'/report.json',JSON.stringify(report,null,2));await app.stop();}
