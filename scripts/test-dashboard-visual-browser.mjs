// Dedicated Chrome on CDP 9224, readonly production server on 3200.
// Every API is intercepted before navigation; fixtures never reach Google/OpenAI.
import { mkdir, writeFile } from 'node:fs/promises';
import { romeDate, shiftMonth } from '../src/lib/calendar.ts';

const base = 'http://127.0.0.1:3200';
const output = '/tmp/spesesmart-dashboard-visual';
await mkdir(output, { recursive: true });
const tabs = await (await fetch('http://127.0.0.1:9224/json/list')).json();
const target = tabs.find(tab => tab.type === 'page');
if (!target) throw Error('Apri Chrome dedicato su about:blank, CDP 9224.');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
let nextId = 0, variant = 'normal';
const pending = new Map(), errors = [], results = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
});
const today = romeDate(), month = today.slice(0, 7);
const expense = (id, amount, category, merchant, date = today) => ({ id: `visual-${id}`, date, amount, category, merchant, source: 'Manuale' });
const fixtures = {
  normal: [expense('1', 68.9, 'Shopping e Abbigliamento', 'Negozio di abbigliamento'), expense('2', 23.45, 'Alimentari', 'Supermercato'), expense('3', 32.2, 'Hobby e Intrattenimento', 'Libreria del quartiere'), expense('previous', 80, 'Alimentari', 'Supermercato', `${shiftMonth(month, -1)}-10`)],
  long: [expense('large', 123456.78, 'Shopping e Abbigliamento', 'Acquisto di abbigliamento e accessori per tutta la famiglia presso il negozio del centro'), expense('long', 234.56, 'Tempo Libero e Socialità', 'Cena e attività con gli amici nel fine settimana'), expense('refund', -80.9, 'Hobby e Intrattenimento', 'Rettifica per il reso dei prodotti acquistati in precedenza'), expense('uncertain', 45.67, 'Da classificare', 'Acquisto da verificare e classificare'), expense('previous', 98000, 'Alimentari', 'Mese precedente', `${shiftMonth(month, -1)}-10`)],
  negative: [expense('return', -240.5, 'Shopping e Abbigliamento', 'Reso di un acquisto precedente'), expense('adjustment', -19.75, 'Alimentari', 'Rettifica della spesa'), expense('previous', 100, 'Alimentari', 'Mese precedente', `${shiftMonth(month, -1)}-10`)],
  empty: [],
};
fixtures.zero = fixtures.normal;
ws.addEventListener('message', async event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  else if (message.method === 'Fetch.requestPaused') {
    const { request, requestId } = message.params;
    const url = new URL(request.url);
    if (request.method === 'GET' && url.origin === base && url.pathname === '/api/archive') {
      await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ archive: { expenses: fixtures[variant], receipts: [] }, persistedIds: [], editablePurchases: {}, writesEnabled: false })).toString('base64') });
    } else if (request.method === 'GET' && url.origin === base && !url.pathname.startsWith('/api/')) await send('Fetch.continueRequest', { requestId });
    else { errors.push(`Richiesta inattesa bloccata: ${request.method} ${url.pathname}`); await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
  }
});
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}
const wait = expression => evaluate(`new Promise((resolve,reject)=>{let count=0;const check=()=>{if(${expression})resolve(true);else if(++count>100)reject(Error('Rendering non pronto'));else setTimeout(check,100);};check();})`);
function check(value, message) { if (!value) throw Error(`${variant}: ${message}`); }
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('spesesmart:monthly-budgets:v1','{}');` });
  // Write only the dedicated browser's budget preference, using its existing format.
  for (const width of [320, 360, 390, 430, 768, 1440]) for (variant of Object.keys(fixtures)) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    await send('Page.navigate', { url: `${base}/` });
    await wait(`document.querySelector('.dashboard-overview')`);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>{window.scrollTo(0,0);requestAnimationFrame(resolve);}))`);
    if (variant === 'zero') {
      await evaluate(`document.querySelector('.budget-settings details').open=true`);
      await evaluate(`(()=>{const e=document.querySelector('.budget-settings input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'0');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await evaluate(`document.querySelector('.budget-settings form').requestSubmit()`);
      await wait(`document.querySelector('.budget-remaining').innerText.includes('Budget impostato a zero')`);
    }
    if (variant === 'long') {
      await evaluate(`document.querySelector('.dashboard-categories [aria-expanded]').click()`);
      await wait(`document.querySelectorAll('.category-row').length===12`);
    }
    const layout = await evaluate(`(()=>{
      const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const categoryRows=Array.from(document.querySelectorAll('.category-row')).map(e=>({row:rect(e),name:rect(e.querySelector('.category-name')),amount:rect(e.querySelector('.category-amount')),bar:rect(e.querySelector('.category-meter')),display:getComputedStyle(e).display}));
      const recent=Array.from(document.querySelectorAll('.recent-purchase')).map(e=>({name:rect(e.querySelector('.recent-purchase-copy')),amount:rect(e.querySelector('.recent-purchase-amount'))}));
      return {overflow:document.documentElement.scrollWidth>innerWidth,total:rect(document.querySelector('.featured .stat-value')),navigationLabels:Array.from(document.querySelectorAll('.nav-item > span')).filter(e=>getComputedStyle(e).display!=='none').map(e=>({height:rect(e).height,lineHeight:parseFloat(getComputedStyle(e).lineHeight)})),budgetValues:Array.from(document.querySelectorAll('.dashboard-budget-grid .stat-value')).map(e=>({height:rect(e).height,lineHeight:parseFloat(getComputedStyle(e).lineHeight)})),comparison:rect(document.querySelector('.comparison-values')),note:document.querySelector('.comparison-note')?rect(document.querySelector('.comparison-note')):null,categories:categoryRows,recent,bar:rect(document.querySelector('progress')),barParent:rect(document.querySelector('.budget-remaining')),negativeBars:document.querySelectorAll('.signed-bar.negative').length};
    })()`);
    check(!layout.overflow, `${width}px: overflow orizzontale`);
    check(layout.navigationLabels.every(value => value.height <= value.lineHeight + 1), `${width}px: etichetta navigazione spezzata`);
    check(layout.budgetValues.every(value => value.height <= value.lineHeight + 1), `${width}px: importo budget spezzato su più righe`);
    check(layout.total.bottom < 800, `${width}px: totale iniziale troppo in basso`);
    check(!layout.note || layout.note.y >= layout.comparison.bottom + 8, `${width}px: nota mensile accostata agli importi`);
    for (const row of layout.categories) {
      check(row.display === 'grid', 'Categoria senza layout a righe');
      check(row.name.right + 8 <= row.amount.x, `${width}px: nome/importo categoria non separati`);
      check(row.bar.y >= Math.max(row.name.bottom, row.amount.bottom) + 6, `${width}px: barra sovrapposta ai testi`);
      check(row.row.width >= 200, 'Riga categoria troppo stretta');
    }
    for (const row of layout.recent) check(row.name.right + 8 <= row.amount.x || row.amount.y >= row.name.bottom + 6, `${width}px: descrizione e importo recenti sovrapposti`);
    check(layout.bar.x >= layout.barParent.x && layout.bar.right <= layout.barParent.right, 'Barra budget fuori scheda');
    if (variant === 'negative') check(layout.negativeBars > 0, 'Rettifiche senza barre negative');
    const metrics = await send('Page.getLayoutMetrics');
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: metrics.cssContentSize.height, scale: 1 } });
    const path = `${output}/${variant}-${width}.png`;
    await writeFile(path, Buffer.from(screenshot.data, 'base64'));
    const viewport = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(`${output}/${variant}-${width}-viewport.png`, Buffer.from(viewport.data, 'base64'));
    if (variant === 'normal') {
      await evaluate(`document.querySelector('.month-comparison').scrollIntoView({block:'start'})`);
      const comparison = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(`${output}/comparison-${width}.png`, Buffer.from(comparison.data, 'base64'));
    }
    results.push({ width, variant, screenshot: path, viewport: `${output}/${variant}-${width}-viewport.png`, categories: layout.categories.length });
  }
  check(!errors.length, errors.join('; '));
  await writeFile(`${output}/report.json`, JSON.stringify({ results, errors, realSheetsWrites: 0, paidOpenAICalls: 0 }, null, 2));
  console.log(JSON.stringify({ cases: results.length, widths: [320,360,390,430,768,1440], variants: Object.keys(fixtures), output, errors, realSheetsWrites: 0, paidOpenAICalls: 0 }, null, 2));
} finally { ws.close(); }
