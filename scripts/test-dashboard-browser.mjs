import {romeDate} from '../src/lib/calendar.ts';
import {archiveForView,createBackup} from '../src/lib/archive.ts';
// Use a dedicated Chrome/CDP session. Every application API is intercepted; no real Google/OpenAI calls.
import {mkdtemp,chmod,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSheetsRepository} from '../src/lib/sheets-repository.ts';
import {createUpdateStore} from '../src/lib/sheets-update-store.ts';
import {TABLE_HEADERS,extraHeaders} from '../src/lib/sheets-persistence-model.ts';
import {categoryDefinitions} from '../src/lib/categories.ts';
import {createDraft,prepareConfirmation} from '../src/lib/receipts/model.ts';
import {demoReceipt} from '../src/lib/receipts/demo.ts';

async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'spesesmart-browser-edits-'));await chmod(directory,0o700);
 const store=createUpdateStore({NODE_ENV:'test',GOOGLE_SHEETS_SPREADSHEET_ID:'browser-fixture',SPESESMART_SHEETS_UPDATE_DIR:directory});
 const data=Object.fromEntries(Object.entries(TABLE_HEADERS).map(([name,headers],id)=>[name,{id,columns:50,rows:[[...headers,...(name==='Categorie'?[]:extraHeaders(1))]]}]));
 data.Categorie.rows.push(...categoryDefinitions.map(c=>[c.name,'Spese','Sì',c.description]));
 let writes=0;
 const apply=async changes=>{writes++;for(const c of changes)for(let n=0;n<c.values.length;n++){data[c.sheet].rows[c.row+n]??=[];c.values[n].forEach((v,i)=>data[c.sheet].rows[c.row+n][c.column+i]=v);while(data[c.sheet].rows[c.row+n].at(-1)==='')data[c.sheet].rows[c.row+n].pop();}};
 const transport={async read(){return structuredClone(data);},write:apply,async guardDeletion(){} };
 const repo=createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport,true,store);
 const today=romeDate(); const manualId=randomUUID();await repo.save({kind:'manual',operationId:manualId,draft:{description:'Ferramenta fixture',date:today,notes:'Nota originaria',items:[{category:'Casa e Pulizia',amount:'10.10'},{category:'Trasporti',amount:'2.20'}]}});
 const analysis=structuredClone(demoReceipt);analysis.merchant='Market fixture';analysis.date=today;let n=0;
 const receipt=prepareConfirmation(createDraft(analysis,()=>`browser-product-${++n}`),analysis,'',false,()=>`browser-receipt-${++n}`);
 await repo.save({kind:'receipt',operationId:receipt.Documenti[0].id,receipt});
 return{directory,repo,transport,apply,data,manualId:`manual-${manualId}`,receiptId:receipt.Documenti[0].id,writes:()=>writes};
}
const lanOperations=process.argv.includes('--lan-operations');
const base=process.env.SPESESMART_BROWSER_URL||(lanOperations?'http://127.0.0.1:3000':'http://127.0.0.1:3200');
const cdpBase='http://127.0.0.1:'+(process.env.SPESESMART_BROWSER_CDP||'9224');
const target=await(await fetch(cdpBase+'/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
let id=0,current,mode='normal',apiGets=0,mutations=0,analyses=0,fullGets=0,sessions=0;const pending=new Map(),errors=[];
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject,method});ws.send(JSON.stringify({id:n,method,params}));});
const fulfill=(requestId,value,status=200)=>send('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(value)).toString('base64')});
ws.addEventListener('message',async e=>{const msg=JSON.parse(e.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);if(msg.error&&p.method.startsWith('Fetch.')&&/Invalid InterceptionId/i.test(msg.error.message))p.resolve({});else if(msg.error)p.reject(Error(msg.error.message));else p.resolve(msg.result);}else if(msg.method==='Runtime.exceptionThrown'){errors.push(msg.params.exceptionDetails.text);}else if(msg.method==='Fetch.requestPaused'){
 const req=msg.params.request,requestId=msg.params.requestId,url=new URL(req.url);
 try{
  if(url.origin===base&&url.pathname==='/api/archive'&&req.method==='GET'){
    apiGets++;if(!url.searchParams.has('view'))fullGets++;
    const loaded=mode==='empty'?{archive:{expenses:[],receipts:[]},persistedIds:[],editablePurchases:{}}:await current.repo.load();
    await fulfill(requestId,mode==='error'?{error:'Errore simulato'}:{...loaded,archive:archiveForView(loaded.archive,url.searchParams.has('view')),writesEnabled:true,lanOperational:lanOperations,lanReadOnly:false},mode==='error'?503:200);
  }else if(lanOperations&&url.origin===base&&url.pathname==='/api/lan/session'&&req.method==='GET'){
    sessions++;await fulfill(requestId,{csrf:'fixture-csrf'});
  }else if(url.origin===base&&url.pathname==='/api/archive'&&['POST','PATCH','DELETE'].includes(req.method)){
    if(lanOperations&&!Object.entries(req.headers).some(([name,value])=>name.toLowerCase()==='x-spesesmart-csrf'&&value==='fixture-csrf'))throw Error('Token CSRF assente');
    mutations++;try{const input=JSON.parse(req.postData);await fulfill(requestId,await current.repo[({POST:'save',PATCH:'update',DELETE:'delete'})[req.method]](input));}catch(error){await fulfill(requestId,{error:error.message,code:error.code},409);}
  }else if(url.origin===base&&url.pathname==='/api/receipts/analyze'&&req.method==='POST'){
    if(lanOperations&&!Object.entries(req.headers).some(([name,value])=>name.toLowerCase()==='x-spesesmart-csrf'&&value==='fixture-csrf'))throw Error('Token CSRF analisi assente');
    analyses++;const analysis=structuredClone(demoReceipt);analysis.date=romeDate();analysis.merchant='Molti prodotti fixture';analysis.totalCents=2000;analysis.items=Array.from({length:20},(_,i)=>({...analysis.items[0],description:'Prodotto '+(i+1),originalText:'Testo '+(i+1),quantity:1,amountCents:100,kind:'product',category:'Alimentari',uncertain:false}));
    await new Promise(r=>setTimeout(r,100));await fulfill(requestId,{receipt:analysis,reusedFromCache:true});
  }else if(url.origin===base&&url.pathname==='/api/ai/usage')await fulfill(requestId,{error:'Consumi fixture'},503);
  else if(req.method==='GET'&&url.origin===base&&!url.pathname.startsWith('/api/'))await send('Fetch.continueRequest',{requestId});
  else await send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});
 }catch(error){errors.push(error.message);await send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});}
}});
async function evaluate(expression){const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;}
const wait=expression=>evaluate(`new Promise((resolve,reject)=>{let n=0;const poll=()=>{if(${expression})resolve(true);else if(++n>150)reject(Error(${JSON.stringify(expression)}));else setTimeout(poll,100);};poll();})`);
const click=expression=>evaluate(`${expression}.click()`);
function check(value,message){if(!value)throw Error(message);}
const tab=name=>click(`document.querySelector('.nav-item[aria-label="${name}"]')`);
async function reload(){await send('Page.navigate',{url:base+'/'});await wait(`document.querySelector('.dashboard-overview')||document.querySelector('.dashboard-unavailable')?.innerText.includes('non disponibile')`);}
async function input(selector,value){await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`);}
const results=[];
try{
 current=await fixture();await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});await send('Fetch.enable',{patterns:[{urlPattern:'http*',requestStage:'Request'}]});
 if(process.argv.includes('--home-production-fixture'))await send('Network.setExtraHTTPHeaders',{headers:{Authorization:'Basic '+Buffer.from('fixture:abcdefgh').toString('base64')}});
 await writeFile('/tmp/spesesmart-mobile-upload.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF2QAAAAASUVORK5CYII=','base64'));
 for(const [width,height]of[[360,800],[390,844],[768,1024],[1440,1000]]){
  mode='normal';await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});await reload();
  const initial=await evaluate(`({top:document.querySelector('.featured .stat-value').getBoundingClientRect().top,bodyWidth:document.documentElement.scrollWidth,width:innerWidth,month:document.querySelector('input[type="month"]').value,total:document.querySelector('.featured .stat-value').innerText,nav:Array.from(document.querySelectorAll('.nav-item')).map(e=>({label:e.getAttribute('aria-label'),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))})`);
  check(initial.top<height-68,'Riepilogo sotto la prima schermata');check(initial.bodyWidth<=width,'Overflow dashboard');check(initial.nav.every(item=>item.label&&item.width>=44&&item.height>=44),'Navigazione non accessibile');check(initial.month===romeDate().slice(0,7),'Mese iniziale errato');check(!await evaluate(`Boolean(document.querySelector('.archive-tools'))`),'Backup nella dashboard');
  const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/spesesmart-mobile-'+width+'.png',Buffer.from(screenshot.data,'base64'));
  await click(`document.querySelector('.category-row')`);await wait(`document.querySelector('.purchase-card')`);check(await evaluate(`document.querySelector('input[type="date"]').value.startsWith('${romeDate().slice(0,7)}')`),'Contesto mensile perso');await tab('Dashboard');
  await click(`document.querySelector('[aria-label="Mese successivo"]')`);await wait(`document.querySelector('.dashboard-empty')`);check(await evaluate(`document.querySelector('.featured .stat-value').innerText.includes('0,00')`),'Mese vuoto errato');await click(`document.querySelector('[aria-label="Mese precedente"]')`);
  mode='error';await click(`document.querySelector('.archive-read-status button')`);await wait(`document.querySelector('.archive-read-status').innerText.includes('non aggiornati')`);check(await evaluate(`document.querySelector('.featured .stat-value').innerText===${JSON.stringify(initial.total)}`),'Dati precedenti persi');mode='normal';await click(`document.querySelector('.archive-read-status button')`);await wait(`!document.querySelector('.error[role="alert"]')`);
  await tab('Aggiungi spesa');await click(`Array.from(document.querySelectorAll('.mode-options button')).find(e=>e.innerText.includes('Inserimento manuale'))`);
  check(await evaluate(`document.querySelector('.expense-dialog[open] input[type="date"]').value==='${romeDate()}'`),'Data manuale non corrente');
  await input('.expense-dialog[open] input[maxlength="100"]','Bozza sul telefono');await input('.expense-dialog[open] input[type="number"]','12.34');await click(`document.querySelector('.expense-dialog[open] .close-button')`);await tab('Aggiungi spesa');
  check(await evaluate(`document.querySelector('.expense-dialog[open] input[maxlength="100"]').value==='Bozza sul telefono'`),'Bozza persa alla riapertura');
  const controls=await evaluate(`Array.from(document.querySelectorAll('.expense-dialog[open] input')).map(e=>({font:parseFloat(getComputedStyle(e).fontSize),mode:e.inputMode}))`);check(controls.every(c=>c.font>=16),'Campi troppo piccoli');await click(`document.querySelector('.expense-dialog[open] .close-button')`);
  await tab('Archivio');await wait(`document.querySelector('.purchase-card')`);await click(`document.querySelector('.purchase-card summary')`);await click(`document.querySelector('.purchase-edit-action button')`);await wait(`document.querySelector('.purchase-editor')?.open`);
  const close=await evaluate(`(()=>{const r=document.querySelector('.purchase-editor [aria-label="Chiudi modifica"]').getBoundingClientRect();return {width:r.width,height:r.height};})()`);check(close.width>=44&&close.height>=44,'Chiusura troppo piccola');await click(`document.querySelector('.purchase-editor [aria-label="Chiudi modifica"]')`);
  await tab('Aggiungi spesa');await click(`document.querySelector('.expense-dialog[open] .secondary')`);await evaluate(`window.confirm=()=>true`);await click(`document.querySelector('.mode-options button')`);await wait(`document.querySelector('.receipt-flow input[type="file"]')`);
  const doc=await send('DOM.getDocument');const fileInput=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.receipt-flow input[type="file"]'});await send('DOM.setFileInputFiles',{nodeId:fileInput.nodeId,files:['/tmp/spesesmart-mobile-upload.png']});await wait(`Array.from(document.querySelectorAll('.receipt-flow button')).some(e=>e.innerText==='Analizza scontrino'&&!e.disabled)`);
  await click(`Array.from(document.querySelectorAll('.receipt-flow button')).find(e=>e.innerText==='Analizza scontrino')`);await wait(`document.querySelectorAll('.receipt-line').length===20`);
  check(await evaluate(`document.querySelector('.expense-dialog[open]').scrollWidth<=document.querySelector('.expense-dialog[open]').clientWidth`),'Overflow revisione');
  await input('.receipt-line input[maxlength="300"]','Prodotto corretto');await click(`document.querySelector('.expense-dialog[open] .close-button')`);await tab('Aggiungi spesa');check(await evaluate(`document.querySelector('.receipt-line input[maxlength="300"]').value==='Prodotto corretto'`),'Revisione persa');await click(`document.querySelector('.expense-dialog[open] .close-button')`);
  await tab('Dashboard');results.push({width,...initial,manualDraft:true,receipt20Products:true,staleState:true,dateCorrect:true,categoryMonthContext:true});
  // A fresh page intentionally discards only fixture drafts between viewport cases.
 }
 await tab('Dashboard');
 await click(`document.querySelector('.budget-settings summary')`);await input('.budget-settings input','0');await evaluate(`document.querySelector('.budget-settings form').requestSubmit()`);await wait(`document.querySelector('.dashboard-overview').innerText.includes('Budget impostato a zero')`);
 await click(`document.querySelector('.budget-settings summary')`);await input('.budget-settings input','1');await evaluate(`document.querySelector('.budget-settings form').requestSubmit()`);await wait(`document.querySelector('.over-budget')`);
 await click(`document.querySelector('.budget-settings summary')`);await input('.budget-settings input','2000');await evaluate(`document.querySelector('.budget-settings form').requestSubmit()`);
 if(lanOperations){
  await tab('Impostazioni');await wait(`document.querySelector('.settings-administration')?.innerText.includes('Backup, importazione e reset')`);
  check(!await evaluate(`Boolean(document.querySelector('.archive-tools'))`),'Strumenti amministrativi disponibili nella LAN operativa');
  check(!await evaluate(`Array.from(document.querySelectorAll('button')).some(e=>e.innerText==='Carica backup e strumenti')`),'Backup completo disponibile');
  await tab('Dashboard');
 }else{
 const beforeLocalReset=await evaluate(`document.querySelector('.featured .stat-value').innerText`);
 await tab('Impostazioni');await wait(`Array.from(document.querySelectorAll('button')).some(e=>e.innerText==='Carica backup e strumenti')`);await click(`Array.from(document.querySelectorAll('button')).find(e=>e.innerText==='Carica backup e strumenti')`);await wait(`document.querySelector('.archive-tools')`);
 await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:'/tmp/spesesmart-mobile-downloads'});
 await click(`Array.from(document.querySelectorAll('.archive-tools button')).find(e=>e.innerText==='Esporta backup JSON')`);await wait(`document.querySelector('.archive-check input')`);await click(`document.querySelector('.archive-check input')`);
 await input('.archive-scope select','all');await click(`Array.from(document.querySelectorAll('.archive-tools button')).find(e=>e.innerText==='Prepara reset')`);await wait(`document.querySelector('.archive-confirmation-input')`);
 const phrase=await evaluate(`document.querySelector('.archive-confirm [id$="-instructions"] strong').innerText`);await input('.archive-confirmation-input',phrase);await click(`document.querySelector('.archive-confirm button[type="submit"]')`);await wait(`document.querySelector('.settings-administration').innerText.includes('Vista locale modificata')`);
 await tab('Dashboard');check(await evaluate(`document.querySelector('.featured .stat-value').innerText===${JSON.stringify(beforeLocalReset)}`),'Reset locale ha modificato dashboard');await tab('Archivio');await wait(`document.querySelectorAll('.purchase-card').length===2`);await tab('Dashboard');
 await tab('Impostazioni');
 const localFile='/tmp/spesesmart-local-import-fixture.json';
 await writeFile(localFile,JSON.stringify(createBackup({expenses:[{id:'local-only-fixture',date:romeDate(),merchant:'Solo backup locale',category:'Alimentari',amount:17,source:'Manuale',notes:''}],receipts:[]})));
 const localDoc=await send('DOM.getDocument');const localInput=await send('DOM.querySelector',{nodeId:localDoc.root.nodeId,selector:'.archive-tools input[type="file"]'});await send('DOM.setFileInputFiles',{nodeId:localInput.nodeId,files:[localFile]});
 await wait(`Array.from(document.querySelectorAll('.archive-confirm h3')).some(e=>e.innerText==='Ripristina backup')`);
 await click(`document.querySelector('.archive-confirm button.primary')`);
 await tab('Dashboard');check(await evaluate(`document.querySelector('.featured .stat-value').innerText===${JSON.stringify(beforeLocalReset)}`),'Importazione locale ha modificato dashboard');
 }
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await evaluate(`(()=>{const list=Array.from(document.querySelectorAll('body *')).filter(e=>!(e instanceof SVGElement)).map(e=>[e,parseFloat(getComputedStyle(e).fontSize)]);for(const [e,size]of list)e.style.fontSize=(size*2)+'px';})()`);
 check(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Overflow testo 200%');const enlarged=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/spesesmart-mobile-text200.png',Buffer.from(enlarged.data,'base64'));
 mode='error';await reload();check(!await evaluate(`Boolean(document.querySelector('.featured .stat-value'))`),'Errore iniziale mostra importi');mode='normal';await click(`document.querySelector('.archive-read-status button')`);await wait(`document.querySelector('.dashboard-overview')`);
 mode='empty';await reload();check(await evaluate(`document.querySelector('.featured .stat-value').innerText.includes('0,00')`),'Archivio vuoto non a zero');
 mode='normal';await reload();await tab('Archivio');await wait(`document.querySelectorAll('.purchase-card').length===2`);
 await evaluate(`(()=>{const card=Array.from(document.querySelectorAll('.purchase-card')).find(e=>e.innerText.includes('Ferramenta fixture'));card.querySelector('summary').click();card.querySelector('.purchase-edit-action button').click();})()`);await wait(`document.querySelector('.purchase-editor')?.open`);
 await input('.purchase-editor .receipt-line input[inputmode="decimal"]','11.10');
 await evaluate(`(()=>{const form=document.querySelector('.purchase-editor form');form.requestSubmit();form.requestSubmit();})()`);await wait(`!document.querySelector('.purchase-editor')`);check(mutations===1,'Doppio invio modifica');
 await tab('Dashboard');check(await evaluate(`document.querySelector('.featured .stat-value').innerText.includes('27,20')`),'Dashboard dopo modifica');
 await tab('Archivio');await wait(`document.querySelector('.purchase-card')`);
 await evaluate(`(()=>{const card=Array.from(document.querySelectorAll('.purchase-card')).find(e=>e.innerText.includes('Ferramenta fixture'));if(!card.open)card.querySelector('summary').click();card.querySelector('.danger-button').click();})()`);await wait(`document.querySelector('.purchase-deletion')?.open`);
 await evaluate(`(()=>{const button=document.querySelector('.purchase-deletion .danger-button');button.click();button.click();})()`);await wait(`!document.querySelector('.purchase-deletion')`);check(mutations===2,'Doppio invio eliminazione');check(await evaluate(`document.querySelectorAll('.purchase-card').length===1`),'Archivio dopo eliminazione');
 await tab('Dashboard');check(await evaluate(`document.querySelector('.featured .stat-value').innerText.includes('13,90')&&document.querySelector('.featured').innerText.includes('1 acquisti')`),'Dashboard dopo eliminazione');
 if(lanOperations){
  await tab('Aggiungi spesa');await click(`Array.from(document.querySelectorAll('.mode-options button')).find(e=>e.innerText.includes('Inserimento manuale'))`);
  await input('.expense-dialog[open] input[maxlength="100"]','Inserimento LAN fixture');await input('.expense-dialog[open] input[type="number"]','7.00');
  await evaluate(`(()=>{const form=document.querySelector('.expense-dialog[open] form');form.requestSubmit();form.requestSubmit();})()`);await wait(`!document.querySelector('.expense-dialog[open]')`);
  check(mutations===3,'Invio manuale duplicato');await wait(`document.querySelector('.featured .stat-value').innerText.includes('20,90')`);
  await tab('Aggiungi spesa');await click(`document.querySelector('.mode-options button')`);await wait(`document.querySelector('.receipt-flow input[type="file"][capture="environment"]')`);
  const receiptDoc=await send('DOM.getDocument');const receiptInput=await send('DOM.querySelector',{nodeId:receiptDoc.root.nodeId,selector:'.receipt-flow input[type="file"]'});await send('DOM.setFileInputFiles',{nodeId:receiptInput.nodeId,files:['/tmp/spesesmart-mobile-upload.png']});
  await wait(`Array.from(document.querySelectorAll('.receipt-flow button')).some(e=>e.innerText==='Analizza scontrino'&&!e.disabled)`);
  await click(`Array.from(document.querySelectorAll('.receipt-flow button')).find(e=>e.innerText==='Analizza scontrino')`);await wait(`document.querySelectorAll('.receipt-line').length===20`);
  const receiptScreenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/spesesmart-lan-operations-receipt.png',Buffer.from(receiptScreenshot.data,'base64'));
  await evaluate(`(()=>{const form=document.querySelector('form.receipt-flow');form.requestSubmit();form.requestSubmit();})()`);await wait(`!document.querySelector('.expense-dialog[open]')`);
  check(mutations===4,'Conferma scontrino duplicata');await wait(`document.querySelector('.featured .stat-value').innerText.includes('40,90')`);
  check(fullGets===0,'Snapshot completo caricato dalla LAN');check(sessions===analyses+mutations,'Sessione non acquisita prima delle operazioni');
 }
 check(!errors.length,errors.join(';'));console.log(JSON.stringify({results,initialError:true,empty:true,localImport:!lanOperations,adminBlocked:lanOperations,confirmedManual:lanOperations,confirmedEdit:true,confirmedDeletion:true,duplicateSubmissionBlocked:true,apiGets,fullGets,sessions,simulatedMutations:mutations,simulatedAnalyses:analyses,realSheetsWrites:0,paidOpenAICalls:0},null,2));
}finally{await fetch(`${cdpBase}/json/close/${target.id}`);ws.close();if(current)await rm(current.directory,{recursive:true,force:true});}
