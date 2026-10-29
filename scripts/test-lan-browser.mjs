// Dedicated CDP 9224; local dev server 127.0.0.1:3000. All APIs are fixture-only.
import { writeFile } from 'node:fs/promises';
import { romeDate } from '../src/lib/calendar.ts';
const base='http://127.0.0.1:3000';
const target=await(await fetch('http://127.0.0.1:9224/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
let id=0;const pending=new Map(),blocked=[];
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject,method});ws.send(JSON.stringify({id:n,method,params}));});
ws.addEventListener('message',async event=>{
 const message=JSON.parse(event.data);
 if(message.id){const entry=pending.get(message.id);pending.delete(message.id);if(message.error&&entry.method.startsWith('Fetch.')&&/Invalid InterceptionId/i.test(message.error.message))entry.resolve({});else if(message.error)entry.reject(Error(message.error.message));else entry.resolve(message.result);}
 else if(message.method==='Fetch.requestPaused'){
  const {request,requestId}=message.params,url=new URL(request.url);
  if(request.method==='GET'&&url.origin===base&&url.pathname==='/api/archive')await send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({archive:{expenses:[{id:'lan-fixture-only',merchant:'Acquisto fixture',date:romeDate(),category:'Alimentari',amount:7,source:'Manuale'}],receipts:[]},persistedIds:[],editablePurchases:{},writesEnabled:false,lanReadOnly:true})).toString('base64')});
  else if(request.method==='GET'&&url.origin===base&&url.pathname==='/api/ai/usage')await send('Fetch.fulfillRequest',{requestId,responseCode:503,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({error:'Consumi fixture non disponibili'})).toString('base64')});
  else if(request.method==='GET'&&url.origin===base&&!url.pathname.startsWith('/api/'))await send('Fetch.continueRequest',{requestId});
  else {blocked.push(`${request.method} ${url.pathname}`);await send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});}
 }
});
async function evaluate(expression){const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description);return result.result.value;}
const wait=condition=>evaluate(`new Promise((resolve,reject)=>{let n=0;const check=()=>{if(${condition})resolve(true);else if(++n>200)reject(Error('UI LAN non pronta'));else setTimeout(check,100);};check();})`);
function check(value,message){if(!value)throw Error(message);}
try{
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Network.setCacheDisabled',{cacheDisabled:true});await send('Fetch.enable',{patterns:[{urlPattern:'http*',requestStage:'Request'}]});
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await send('Page.navigate',{url:base+'/'});await wait(`document.querySelector('.notice')?.innerText.includes('Accesso LAN in sola lettura')`);
 check(await evaluate(`document.querySelector('.featured .stat-value').innerText.includes('7,00')`),'Dashboard non consultabile');
 check(await evaluate(`document.querySelector('[aria-label="Aggiungi spesa"]').disabled`),'Aggiunta disponibile');
 check(await evaluate(`!document.querySelector('.budget-settings details')`),'Modifica budget disponibile');
 await evaluate(`document.querySelector('[aria-label="Aggiungi spesa"]').click()`);check(!await evaluate(`document.querySelector('.expense-dialog').open`),'Dialogo acquisizione aperto');
 await evaluate(`document.querySelector('[aria-label="Archivio"]').click()`);await wait(`document.querySelector('.purchase-card')`);await evaluate(`document.querySelector('.purchase-card summary').click()`);
 check(await evaluate(`Array.from(document.querySelectorAll('.purchase-edit-action button')).every(button=>button.disabled)`),'Mutazioni Archivio disponibili');
 await evaluate(`document.querySelector('[aria-label="Impostazioni"]').click()`);await wait(`document.querySelector('.settings-administration')?.innerText.includes('Accesso dalla rete domestica')`);
 check(!await evaluate(`Boolean(document.querySelector('.archive-tools'))`),'Import/reset disponibili');
 const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile('/tmp/spesesmart-lan-readonly-mobile.png',Buffer.from(screenshot.data,'base64'));
 check(!blocked.length,blocked.join('; '));console.log(JSON.stringify({dashboard:true,archiveDetails:true,addDisabled:true,editDeleteDisabled:true,importResetAbsent:true,budgetReadOnly:true,realSheetsWrites:0,paidOpenAICalls:0}));
}finally{await fetch(`http://127.0.0.1:9224/json/close/${target.id}`);ws.close();}
