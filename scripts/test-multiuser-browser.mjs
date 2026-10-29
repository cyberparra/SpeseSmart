// Actual compiled UI, synthetic APIs and private disposable state. No external API transport.
import '../tests/helpers/isolated-host-policy.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { withHomeWriterLock, writeHomeProof } from './home-runtime.mjs';
import { createUpdateStore } from '../src/lib/sheets-update-store.ts';
import { createSheetsRepository } from '../src/lib/sheets-repository.ts';
import { TABLE_HEADERS, extraHeaders } from '../src/lib/sheets-persistence-model.ts';
import { categoryDefinitions } from '../src/lib/categories.ts';
import { archiveForView } from '../src/lib/archive.ts';
import { romeDate } from '../src/lib/calendar.ts';
import { initializePreferences, loadCatalog, personalBudget, updatePersonalBudget } from '../src/lib/user-preferences.ts';
import { aiConfiguration, initializeAI, controlledAnalysis, getAIUsage } from '../src/lib/ai-usage.ts';
import { demoReceipt } from '../src/lib/receipts/demo.ts';
const build = resolve(process.env.SPESESMART_MULTIUSER_BUILD_DIR || '/tmp/spesesmart-multiuser-build');
await readFile(join(build, '.next/BUILD_ID'));
const directory = await mkdtemp(join(tmpdir(), 'spesesmart-multiuser-browser-'));
const env = { NODE_ENV: 'test', GOOGLE_SHEETS_SPREADSHEET_ID: 'synthetic-browser-sheet', SPESESMART_SHEETS_UPDATE_DIR: join(directory, 'journal'), SPESESMART_PREFERENCES_DIR: join(directory, 'preferences'), SPESESMART_AI_DATA_DIR: join(directory, 'ai') };
const users = { A: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'synthetic-A', role: 'admin' }, B: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', username: 'synthetic-B', role: 'user' } };
const store = createUpdateStore(env), config = aiConfiguration(env);
const data = Object.fromEntries(Object.entries(TABLE_HEADERS).map(([name, headers], id) => [name, { id, columns: 60, rows: [[...headers, ...(name === 'Categorie' ? [] : extraHeaders(1))]] }]));
data.Categorie.rows.push(...categoryDefinitions.map(c => [c.name, 'Spese', 'Sì', c.description]));
const transport = { async read() { return structuredClone(data); }, async guardDeletion() {}, async write(changes) { for (const c of changes) for (const [n, row] of c.values.entries()) { data[c.sheet].rows[c.row + n] ??= []; row.forEach((v, i) => { data[c.sheet].rows[c.row + n][c.column + i] = v; }); } } };
const repos = Object.fromEntries(Object.entries(users).map(([key, user]) => [key, createSheetsRepository(user, transport, true, store)]));
let backend, chrome, proxy, socket, active = null, csrf = '', analyses = 0, mutations = 0, passwordChanges = 0;
const passwords = { A: 'synthetic-password', B: 'synthetic-password' };
const errors = [];
async function stop(child) { if (!child || child.exitCode !== null || child.signalCode !== null) return; const exit = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10000); try { await exit; } finally { clearTimeout(timer); } }
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(r => server.close(r)); return value; }
try {
 await initializePreferences(env); await initializeAI(config);
 for (const key of ['A', 'B']) await repos[key].save({ kind: 'manual', operationId: randomUUID(), draft: { description: 'PRIVATE_' + key, date: romeDate(), notes: '', items: [{ category: 'Alimentari', amount: key === 'A' ? '10.00' : '99.00' }] } });
 const loginPage = (await readFile('scripts/lan-gateway.mjs', 'utf8')).split('const accountPage = `')[1].split('`;')[0];
 const capability = randomBytes(32).toString('hex'), internalPort = await port(), origin = 'https://192.168.250.115:3443';
 await withHomeWriterLock(async (fd, runtime) => {
  env.SPESESMART_ACCOUNT_DIR = join(directory, 'accounts'); await mkdir(env.SPESESMART_ACCOUNT_DIR, { mode: 0o700 });
  const proof = await writeHomeProof(runtime, { version: 1, pid: process.pid, capability, origin, port: String(internalPort), scope: store.scope, aiDirectory: config.directory, updateDirectory: env.SPESESMART_SHEETS_UPDATE_DIR,
    multiuser: true, accountDirectory: env.SPESESMART_ACCOUNT_DIR, preferencesDirectory: env.SPESESMART_PREFERENCES_DIR });
  // Explicit sterile environment, inherited fixture lock, no personal dotenv copied into build.
  backend = spawn(process.execPath, [join(process.cwd(), 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(internalPort)], { cwd: build, stdio: ['ignore', 'pipe', 'pipe', fd], env: { ...env, PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', SPESESMART_MULTIUSER: 'true', SPESESMART_HOME_PRODUCTION: 'true', SPESESMART_HOME_PROOF: proof, SPESESMART_LAN_OPERATIONAL: 'true', SPESESMART_LAN_ORIGIN: origin, SPESESMART_LAN_CAPABILITY: capability, SPESESMART_LAN_INTERNAL_PORT: String(internalPort), SPESESMART_SHEETS_WRITES_ENABLED: 'false' } });
  let log = ''; backend.stdout.on('data', b => log += b); backend.stderr.on('data', b => log += b);
  for (let n = 0; !log.includes('Ready in'); n++) { if (n > 200 || backend.exitCode !== null) throw Error('Backend fixture non avviato: ' + log); await new Promise(r => setTimeout(r, 100)); }
  proxy = createServer((req, res) => {
   if (req.url.startsWith('/api/')) { res.writeHead(403); res.end('Fixture API interception required'); return; }
   if (req.url === '/login' || !active) { res.setHeader('content-type', 'text/html'); res.end(loginPage); return; }
   const forwarded = request({ hostname: '127.0.0.1', port: internalPort, path: req.url, headers: { ...req.headers, host: '127.0.0.1:' + internalPort, 'x-spesesmart-lan-capability': capability } }, incoming => { res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res); });
   forwarded.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(forwarded);
  }); proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening'); const base = 'http://127.0.0.1:' + proxy.address().port;
  const profile = join(directory, 'chrome'); await mkdir(profile);
  chrome = spawn('google-chrome', ['--headless', '--no-sandbox', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let debugPort;
  for (let n = 0; n < 100; n++) { try { debugPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.ok(debugPort, 'Chrome fixture non disponibile');
  const target = await (await fetch('http://127.0.0.1:' + debugPort + '/json/new?about:blank', { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
  let next = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const fulfill = (requestId, body, responseCode = 200) => send('Fetch.fulfillRequest', { requestId, responseCode, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
  socket.addEventListener('message', async event => {
   const msg = JSON.parse(event.data);
   if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(Error(msg.error.message)); else p.resolve(msg.result); return; }
   if (msg.method === 'Page.javascriptDialogOpening') { await send('Page.handleJavaScriptDialog', { accept: true }); return; }
   if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
   if (msg.method !== 'Fetch.requestPaused') return;
   const { request: req, requestId } = msg.params, url = new URL(req.url);
   try {
    if (url.origin !== base) throw Error('Unexpected external browser request');
    if (!url.pathname.startsWith('/api/')) { await send('Fetch.continueRequest', { requestId }); return; }
    if (url.pathname === '/api/auth/login') { const body = JSON.parse(req.postData); active = Object.keys(users).find(k => users[k].username === body.username); assert.ok(active); assert.equal(body.password, passwords[active]); csrf = randomUUID(); await fulfill(requestId, { user: users[active], csrf }); return; }
    if (!active) { await fulfill(requestId, { error: 'Accesso richiesto' }, 401); return; }
    const key = active, user = users[key];
    if (url.pathname === '/api/auth/session' || url.pathname === '/api/lan/session') { await fulfill(requestId, { user, csrf }); return; }
    assert.equal(Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'x-spesesmart-csrf')?.[1], csrf);
    if (url.pathname === '/api/auth/password') {
     passwordChanges++; const body = JSON.parse(req.postData);
     assert.deepEqual(Object.keys(body).sort(), ['confirmPassword', 'currentPassword', 'newPassword']);
     assert.equal(body.newPassword, body.confirmPassword);
     if (body.currentPassword !== passwords[key]) await fulfill(requestId, { code: 'CURRENT_PASSWORD', error: 'La password attuale non è corretta.' }, 403);
     else { passwords[key] = body.newPassword; await fulfill(requestId, { changed: true }); }
    }
    else if (url.pathname === '/api/auth/logout') { active = null; await fulfill(requestId, { ok: true }); }
    else if (url.pathname === '/api/categories' && req.method === 'GET') await fulfill(requestId, await loadCatalog(env));
    else if (url.pathname === '/api/preferences') {
     if (req.method === 'GET') await fulfill(requestId, await personalBudget(user, url.searchParams.get('month'), env));
     else { try { await fulfill(requestId, await updatePersonalBudget(user, JSON.parse(req.postData), env)); } catch (e) { await fulfill(requestId, { error: e.message }, 409); } }
    } else if (url.pathname === '/api/archive') {
     if (req.method === 'GET') { const loaded = await repos[key].load(); await fulfill(requestId, { ...loaded, archive: archiveForView(loaded.archive, true), writesEnabled: true, lanOperational: true, lanReadOnly: false }); }
     else { mutations++; await fulfill(requestId, await repos[key][{ POST: 'save', PATCH: 'update', DELETE: 'delete' }[req.method]](JSON.parse(req.postData))); }
    } else if (url.pathname === '/api/receipts/analyze') {
     const analysis = structuredClone(demoReceipt); analysis.date = romeDate(); analysis.merchant = 'AI_PRIVATE_' + key;
     await fulfill(requestId, await controlledAnalysis(Buffer.from('synthetic photo'), false, async () => { analyses++; return { receipt: analysis, usage: { input: 10, cached: 0, output: 10 }, model: 'gpt-4.1-mini', completed: true }; }, config, undefined, user.id));
    } else if (url.pathname === '/api/ai/usage') await fulfill(requestId, await getAIUsage(config, undefined, user.id));
    else throw Error('Unexpected fixture API: ' + url.pathname);
   } catch (error) { errors.push(error.message); await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
  });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const wait = async expression => {
   for (let n = 0; n < 200; n++) {
    try { if (await evaluate(`Boolean(${expression})`)) return; }
    catch (error) { if (!/navigated|context|Cannot read properties of null|Cannot find/i.test(error.message)) throw error; }
    await new Promise(r => setTimeout(r, 100));
   }
   throw Error('Timeout UI: ' + expression + '\n' + await evaluate('document.body.innerText'));
  };
  const click = expression => evaluate(`(${expression}).click()`);
  const input = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const tab = label => click(`document.querySelector('.nav-item[aria-label="${label}"]')`);
  const text = () => evaluate('document.body.innerText');
  const checkCategorySelector = async () => {
   const options = await evaluate(`Array.from(document.querySelector('.expense-dialog[open] select').options).map(o=>o.value)`);
   for (const name of ['Utenze e Abbonamenti digitali', 'Manutenzioni Ristrutturazioni']) assert.ok(options.includes(name));
   assert.ok(!options.includes('Abbonamenti Digitali'));
  };
  const login = async key => {
   await wait(`document.querySelector('#login')`); assert.equal(await evaluate(`document.querySelector('#login').method`), 'post');
   if (key === 'A') { const image = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/spesesmart-password-login-390.png', Buffer.from(image.data, 'base64')); }
   await input('[name="username"]', users[key].username); await input('[name="password"]', passwords[key]);
   assert.equal(await evaluate(`document.querySelector('[name="password"]').type`), 'password');
   await click(`document.querySelector('#login .password-toggle')`);
   assert.equal(await evaluate(`document.querySelector('[name="password"]').type`), 'text');
   assert.equal(await evaluate(`document.querySelector('#login .password-toggle').getAttribute('aria-label')`), 'Nascondi password');
   await click(`document.querySelector('#login .password-toggle')`);
   assert.equal(await evaluate(`document.querySelector('[name="password"]').value`), passwords[key]);
   await evaluate(`document.querySelector('#login').requestSubmit()`); await wait(`document.querySelector('.dashboard-overview') && document.body.innerText.includes('PRIVATE_${key}')`);
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true }); await send('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: base + '/login' }); await login('A'); assert.ok(!(await text()).includes('PRIVATE_B'));
  await wait(`document.querySelector('.budget-settings .stat-value').innerText.includes('2000,00')`);
  await click(`document.querySelector('.budget-settings summary')`); await input('.budget-settings input', '123.45'); await evaluate(`document.querySelector('.budget-settings form').requestSubmit()`); await wait(`document.querySelector('.budget-settings .stat-value').innerText.includes('123,45')`);
  await tab('Aggiungi spesa'); await click(`Array.from(document.querySelectorAll('.mode-options button')).find(e=>e.innerText.includes('Inserimento manuale'))`);
  await checkCategorySelector();
  await input('.expense-dialog[open] input[maxlength="100"]', 'NEW_PRIVATE_A'); await input('.expense-dialog[open] input[type="number"]', '7.00'); await evaluate(`document.querySelector('.expense-dialog[open] form').requestSubmit()`); await wait(`!document.querySelector('.expense-dialog[open]')`); await wait(`document.body.innerText.includes('NEW_PRIVATE_A')`);
  await tab('Aggiungi spesa'); await click(`document.querySelector('.mode-options button')`); await wait(`document.querySelector('.receipt-flow input[type="file"]')`);
  const imagePath = join(directory, 'synthetic.png'); await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF2QAAAAASUVORK5CYII=','base64'));
  const dom = await send('DOM.getDocument'); const file = await send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '.receipt-flow input[type="file"]' }); await send('DOM.setFileInputFiles', { nodeId: file.nodeId, files: [imagePath] });
  await wait(`Array.from(document.querySelectorAll('.receipt-flow button')).some(e=>e.innerText==='Analizza scontrino'&&!e.disabled)`); await click(`Array.from(document.querySelectorAll('.receipt-flow button')).find(e=>e.innerText==='Analizza scontrino')`); await wait(`document.querySelector('.receipt-line')`);
  await evaluate(`document.querySelector('form.receipt-flow').requestSubmit()`); await wait(`!document.querySelector('.expense-dialog[open]')`); await wait(`document.body.innerText.includes('AI_PRIVATE_A')`);
  const shotA = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/spesesmart-multiuser-A.png', Buffer.from(shotA.data, 'base64'));
  // Second device reads the same server preferences; stale device cannot overwrite.
  assert.equal((await personalBudget(users.A, romeDate().slice(0, 7), env)).budgetCents, 12345);
  await assert.rejects(updatePersonalBudget(users.A, { month: romeDate().slice(0,7), budgetCents: 1, expectedVersion: 0 }, env), { code: 'PREFERENCE_CONFLICT' });
  await tab('Impostazioni'); await wait(`document.querySelector('.password-change-form')`);
  assert.equal(await evaluate(`document.querySelector('.password-change-form').method`), 'post');
  const changeInput = (name, value) => input('.password-change-form [name="' + name + '"]', value);
  await changeInput('currentPassword', passwords.A); await changeInput('newPassword', 'nuova123'); await changeInput('confirmPassword', 'diversa1');
  await evaluate(`document.querySelector('.password-change-form').requestSubmit()`);
  await wait(`document.querySelector('.password-change [role="alert"]').innerText.includes('La conferma non corrisponde')`); assert.equal(passwordChanges, 0);
  await changeInput('confirmPassword', 'nuova123'); await changeInput('currentPassword', 'sbagliata');
  await evaluate(`document.querySelector('.password-change-form').requestSubmit()`);
  await wait(`document.querySelector('.password-change [role="alert"]').innerText.includes('La password attuale non è corretta')`); assert.equal(passwordChanges, 1);
  for (const name of ['currentPassword', 'newPassword', 'confirmPassword']) {
   await click(`document.querySelector('#change-${name}').parentElement.querySelector('button')`);
   assert.equal(await evaluate(`document.querySelector('#change-${name}').type`), 'text');
   await click(`document.querySelector('#change-${name}').parentElement.querySelector('button')`);
   assert.equal(await evaluate(`document.querySelector('#change-${name}').type`), 'password');
  }
  await changeInput('currentPassword', passwords.A); await evaluate(`document.querySelector('.password-change-form').requestSubmit()`);
  await wait(`document.querySelector('.password-change [role="status"]').innerText.includes('Password modificata')`); assert.equal(passwordChanges, 2);
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.password-change-form input')).every(e=>e.value===''&&e.type==='password')`));
  assert.ok(!(await text()).includes('synthetic-password')); assert.ok(!(await text()).includes('nuova123'));
  for (const width of [390, 768]) {
   await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
   assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
   assert.ok(await evaluate(`Array.from(document.querySelectorAll('.password-toggle')).every(e=>{const r=e.getBoundingClientRect();return r.width>=44&&r.height>=44})`));
   const screenshot = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/spesesmart-password-change-' + width + '.png', Buffer.from(screenshot.data, 'base64'));
  }
  await wait(`Array.from(document.querySelectorAll('button')).some(e=>e.innerText==='Esci / Cambia account')`); assert.ok(await evaluate(`(()=>{const r=Array.from(document.querySelectorAll('button')).find(e=>e.innerText==='Esci / Cambia account').getBoundingClientRect();return r.width>0&&r.height>=44})()`), 'Logout non accessibile'); await click(`Array.from(document.querySelectorAll('button')).find(e=>e.innerText==='Esci / Cambia account')`); await login('B');
  assert.ok(!(await text()).includes('PRIVATE_A')); await wait(`document.querySelector('.budget-settings .stat-value').innerText.includes('2000,00')`);
  await tab('Archivio'); await wait(`document.querySelectorAll('.purchase-card').length===1`); assert.ok(!(await text()).includes('PRIVATE_A')); assert.ok(!(await text()).includes('AI_PRIVATE_A'));
  await tab('Aggiungi spesa'); assert.ok(!await evaluate(`Boolean(document.querySelector('.receipt-line'))`)); await click(`document.querySelector('.expense-dialog[open] .close-button')`);
  await tab('Aggiungi spesa'); await click(`Array.from(document.querySelectorAll('.mode-options button')).find(e=>e.innerText.includes('Inserimento manuale'))`);
  await checkCategorySelector(); await click(`Array.from(document.querySelectorAll('.expense-dialog[open] button')).find(e=>e.innerText==='Indietro')`); await click(`document.querySelector('.expense-dialog[open] .close-button')`);
  await tab('Impostazioni'); await wait(`document.querySelector('.password-change-form')`); assert.ok(!await evaluate(`Boolean(document.querySelector('input[name="name"]'))`));
  await tab('Dashboard'); assert.equal((await getAIUsage(config, undefined, users.B.id)).analyses, 0);
  for (const width of [390, 768]) { await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 }); assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Overflow'); const shot = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/spesesmart-multiuser-B-' + width + '.png', Buffer.from(shot.data, 'base64')); }
  for (const width of [320, 390, 768, 1440]) {
   await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
   await evaluate(`document.querySelector('.app-footer').scrollIntoView({block:'end'})`);
   assert.equal(await evaluate(`document.querySelector('.app-footer').innerText`), 'SpeseSmart © 2026 — Sviluppato da Adriano Parracciani (Cyberparra)');
   assert.ok(await evaluate(`(()=>{const r=document.querySelector('.app-footer').getBoundingClientRect();const nav=document.querySelector('.sidebar').getBoundingClientRect();return r.width>0&&r.top>=0&&r.bottom<=innerHeight&&(innerWidth>640||r.bottom-100<=nav.top)})()`));
   assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
   const shot = await send('Page.captureScreenshot', { format: 'png' }); await writeFile('/tmp/spesesmart-footer-' + width + '.png', Buffer.from(shot.data, 'base64'));
  }
  await evaluate('window.scrollTo(0,0)');
  // The same photo under B must run its own provider and produce only B's result.
  await tab('Aggiungi spesa'); await click(`document.querySelector('.mode-options button')`); await wait(`document.querySelector('.receipt-flow input[type="file"]')`);
  const bDom = await send('DOM.getDocument'); const bFile = await send('DOM.querySelector', { nodeId: bDom.root.nodeId, selector: '.receipt-flow input[type="file"]' }); await send('DOM.setFileInputFiles', { nodeId: bFile.nodeId, files: [imagePath] });
  await wait(`Array.from(document.querySelectorAll('.receipt-flow button')).some(e=>e.innerText==='Analizza scontrino'&&!e.disabled)`); await click(`Array.from(document.querySelectorAll('.receipt-flow button')).find(e=>e.innerText==='Analizza scontrino')`); await wait(`document.querySelector('.receipt-line')`);
  assert.ok(!(await text()).includes('AI_PRIVATE_A')); await evaluate(`document.querySelector('form.receipt-flow').requestSubmit()`); await wait(`!document.querySelector('.expense-dialog[open]')`); await wait(`document.body.innerText.includes('AI_PRIVATE_B')`);
  assert.equal((await getAIUsage(config, undefined, users.B.id)).analyses, 1);
  // Another tab ending or replacing the session immediately unmounts all personal UI.
  await evaluate(`window.dispatchEvent(new StorageEvent('storage',{key:'spesesmart:auth-event',newValue:'synthetic-new-session'}))`);
  await wait(`document.body.innerText.includes('Sessione terminata')`); assert.ok(!(await text()).includes('PRIVATE_B'));
  assert.equal(mutations, 3); assert.equal(analyses, 2); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ actualCompiledBootstrap: true, logins: ['A-admin', 'B-user'], sharedCategories: true, footerMobile: true, passwordVisibility: true, passwordChangeMessages: true, currentSessionPreserved: true, passwordChanges, manual: true, simulatedAIConfirmed: true, syncedBudget: true, staleBudgetConflict: true, logoutClearsUI: true, accountBPrivate: true, mutations, simulatedProviderCalls: analyses, realSheetsWrites: 0, paidOpenAICalls: 0 }));
  socket.close(); socket = null; proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); proxy = null; await stop(chrome); chrome = null; await stop(backend); backend = null;
 });
} finally { socket?.close(); proxy?.closeAllConnections(); proxy?.close(); await stop(chrome); await stop(backend); await rm(directory, { recursive: true, force: true }); }
