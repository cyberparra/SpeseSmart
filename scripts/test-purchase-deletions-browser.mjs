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
import {romeDate} from '../src/lib/calendar.ts';

async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'spesesmart-browser-edits-'));await chmod(directory,0o700);
 const store=createUpdateStore({NODE_ENV:'test',GOOGLE_SHEETS_SPREADSHEET_ID:'browser-fixture',SPESESMART_SHEETS_UPDATE_DIR:directory});
 const data=Object.fromEntries(Object.entries(TABLE_HEADERS).map(([name,headers],id)=>[name,{id,columns:50,rows:[[...headers,...(name==='Categorie'?[]:extraHeaders(1))]]}]));
 data.Categorie.rows.push(...categoryDefinitions.map(c=>[c.name,'Spese','Sì',c.description]));
 let writes=0;
 const apply=async changes=>{writes++;for(const c of changes)for(let n=0;n<c.values.length;n++){data[c.sheet].rows[c.row+n]??=[];c.values[n].forEach((v,i)=>data[c.sheet].rows[c.row+n][c.column+i]=v);while(data[c.sheet].rows[c.row+n].at(-1)==='')data[c.sheet].rows[c.row+n].pop();}};
 const transport={async read(){return structuredClone(data);},write:apply,async guardDeletion(){} };
 const repo=createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport,true,store);
 const manualId=randomUUID();await repo.save({kind:'manual',operationId:manualId,draft:{description:'Ferramenta fixture',date:romeDate(),notes:'Nota originaria',items:[{category:'Casa e Pulizia',amount:'10.10'},{category:'Trasporti',amount:'2.20'}]}});
 const analysis=structuredClone(demoReceipt);analysis.merchant='Market fixture';analysis.date=romeDate();let n=0;
 const receipt=prepareConfirmation(createDraft(analysis,()=>`browser-product-${++n}`),analysis,'',false,()=>`browser-receipt-${++n}`);
 await repo.save({kind:'receipt',operationId:receipt.Documenti[0].id,receipt});
 return{directory,repo,transport,apply,data,manualId:`manual-${manualId}`,receiptId:receipt.Documenti[0].id,writes:()=>writes};
}
const tabs=await(await fetch('http://127.0.0.1:9223/json/list')).json();
const target=tabs.find(t=>t.type==='page'&&t.url==='about:blank')??tabs.find(t=>t.type==='page'&&t.url==='http://127.0.0.1:3000/');if(!target)throw Error('Apri una sessione Chrome dedicata su about:blank');const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
let id=0,current,scenario='normal',patches=0,blockedMutations=0,readOnly=false;const pending=new Map();const browserErrors=[];
function send(method,params={}){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});}
async function fulfill(requestId,value,status=200){await send('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(value)).toString('base64')});}
ws.addEventListener('message',async e=>{const msg=JSON.parse(e.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);if(msg.error)p.reject(Error(msg.error.message));else p.resolve(msg.result);}else if(msg.method==='Runtime.exceptionThrown'){browserErrors.push(msg.params.exceptionDetails.exception?.description??msg.params.exceptionDetails.text);}else if(msg.method==='Fetch.requestPaused'){
 const req=msg.params.request;const requestId=msg.params.requestId;
 try{
  if(req.url.startsWith('http://127.0.0.1:3000/api/archive')&&req.method==='GET'){await fulfill(requestId,{...await current.repo.load(),writesEnabled:!readOnly});}
  else if(req.url==='http://127.0.0.1:3000/api/archive'&&req.method==='DELETE'){
   patches++;const input=JSON.parse(req.postData);
   if(scenario==='conflict'){scenario='normal';const editable=(await current.repo.load()).editablePurchases[input.documentId];const external={documentId:input.documentId,operationId:randomUUID(),expectedVersion:editable.version,draft:structuredClone(editable.draft)};external.draft.notes='Modifica concorrente fixture';await current.repo.update(external);}
   if(scenario==='partial'){scenario='normal';let phase=0;current.transport.write=async changes=>{if(++phase===2){await current.apply(changes.slice(0,1));throw Error('Interruzione fixture');}await current.apply(changes);};}
   try{await fulfill(requestId,await current.repo.delete(input));}catch(error){await fulfill(requestId,{code:error.code,error:error.message},error.code==='INVALID'?422:409);}finally{current.transport.write=current.apply;}
  }else if(req.method==='GET'&&req.url.startsWith('http://127.0.0.1:3000/')&&!req.url.includes('/api/'))await send('Fetch.continueRequest',{requestId});
  else{if(req.method!=='GET')blockedMutations++;await send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});}
 }catch(error){browserErrors.push(error.message);await send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});}
}});
async function evaluate(expression){const value=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw Error(value.exceptionDetails.exception?.description??value.exceptionDetails.text);return value.result.value;}
const wait=expression=>evaluate(`new Promise((resolve,reject)=>{let n=0;const poll=()=>{if(${expression})resolve(true);else if(++n>200)reject(Error('DOM non pronto: '+${JSON.stringify(expression)}));else setTimeout(poll,100);};poll();})`);
const click=expression=>evaluate(`${expression}.click()`);
function check(condition,message){if(!condition)throw Error(message);}
async function archiveTab(){await click(`Array.from(document.querySelectorAll('.nav-item')).find(e=>e.textContent.includes('Archivio'))`);}
async function reload(){await send('Page.navigate',{url:'http://127.0.0.1:3000/'});await wait(`document.querySelector('.dashboard-overview')`);}

const results=[];
async function deleteDialog(merchant){await evaluate(`(()=>{const card=Array.from(document.querySelectorAll('.purchase-card')).find(c=>c.querySelector('.purchase-card-title > strong').textContent===${JSON.stringify(merchant)});if(!card.open)card.querySelector('summary').click();card.querySelector('.danger-button').click();})()`);await wait("document.querySelector('.purchase-deletion')?.open");}
const deletionSubmit=()=>click("document.querySelector('.purchase-deletion .danger-button')");
const deletionClose=()=>click("document.querySelector('.purchase-deletion .secondary')");
try{
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});await send('Fetch.enable',{patterns:[{urlPattern:'http*',requestStage:'Request'}]});
 for(const [width,height] of [[1440,1000],[390,844]]){
  current=await fixture();readOnly=false;scenario='normal';
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<500});await reload();await archiveTab();await wait("document.querySelectorAll('.purchase-card').length===2");
  await deleteDialog('Ferramenta fixture');check(await evaluate("document.querySelector('.purchase-deletion').innerText.includes('Spesa manuale')"),'Riepilogo manuale mancante');
  check(await evaluate("document.querySelector('.purchase-deletion').scrollWidth<=document.querySelector('.purchase-deletion').clientWidth"),'Overflow conferma');
  const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/spesesmart-delete-'+width+'.png',Buffer.from(screenshot.data,'base64'));
  const calls=patches,writes=current.writes();await deletionClose();check(patches===calls&&current.writes()===writes,'Annulla ha scritto');check((await current.repo.load()).archive.expenses.length>2,'Annulla ha rimosso dati');
  await deleteDialog('Ferramenta fixture');scenario='conflict';await deletionSubmit();await wait("document.querySelector('.purchase-deletion .error')?.innerText.includes('cambiato')");check(await evaluate("document.querySelector('.purchase-deletion .danger-button').disabled"),'Conflitto non blocca');await deletionClose();
  await deleteDialog('Ferramenta fixture');scenario='partial';await deletionSubmit();await wait("document.querySelector('.purchase-deletion .error')?.innerText.includes('incompleta')");check((await current.repo.load()).pendingDeletions.length===1,'Pendente mancante');await deletionClose();
  await reload();await click("Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Riprendi eliminazione')");await wait("document.querySelector('.purchase-deletion')?.open");await deletionSubmit();await wait("!document.querySelector('.purchase-deletion')");
  check((await current.repo.load()).pendingDeletions.length===0,'Ripresa incompleta');await archiveTab();await wait("document.querySelectorAll('.purchase-card').length===1");
  check(await evaluate("!document.querySelector('.purchase-list').innerText.includes('Ferramenta fixture')"),'Acquisto obsoleto');
  await deleteDialog('Market fixture');await deletionSubmit();await wait("!document.querySelector('.purchase-deletion')");await wait("document.querySelector('.purchase-empty')?.innerText.includes('Il tuo archivio comincia qui')");
  await click("Array.from(document.querySelectorAll('.nav-item')).find(e=>e.textContent.includes('Dashboard'))");await wait("document.querySelector('.dashboard-overview')");
  check(await evaluate("document.querySelector('.dashboard-overview').innerText.includes('0,00')"),'Dashboard non aggiornata');check((await current.repo.load()).archive.expenses.length===0,'Archivio non vuoto');
  await reload();await archiveTab();await wait("document.querySelector('.purchase-empty')?.innerText.includes('Il tuo archivio comincia qui')");
  await rm(current.directory,{recursive:true,force:true});current=await fixture();readOnly=true;await reload();await archiveTab();await wait("document.querySelectorAll('.purchase-card').length===2");await click("document.querySelector('.purchase-card summary')");
  check(await evaluate("document.querySelector('.purchase-edit-action .danger-button').disabled"),'Readonly non rispettato');
  results.push({width,cancel:true,manualDeletion:true,receiptDeletion:true,versionConflict:true,partialFailure:true,recoveryAfterReload:true,emptyArchive:true,dashboardRefreshed:true,readonly:true});await rm(current.directory,{recursive:true,force:true});current=null;
 }
 check(!browserErrors.length,browserErrors.join(';'));check(blockedMutations===0,'Tentata mutazione estranea');console.log(JSON.stringify({results,simulatedDeletions:patches,realSheetsWrites:0,paidOpenAICalls:0,browserErrors},null,2));
}finally{ws.close();if(current)await rm(current.directory,{recursive:true,force:true});}
