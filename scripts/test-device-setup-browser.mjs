// Loopback synthetic page only. Never starts the real LAN bootstrap or imports a CA.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { syntheticPKI } from '../tests/helpers/pi-pki.mjs';
import { createDeviceSetup } from './device-setup.mjs';
const root = await mkdtemp(join(tmpdir(), 'spesesmart-device-browser-'));
const screenshots = '/tmp/spesesmart-device-setup-visual';
await mkdir(screenshots, { recursive: true, mode: 0o700 });
let server, browser, exit, ws;
try {
  const pki = await syntheticPKI(root);
  const reserve = createServer(); await new Promise(ok => reserve.listen(0, '127.0.0.1', ok)); const port = reserve.address().port; await new Promise(ok => reserve.close(ok));
  server = createDeviceSetup({ ip: '127.0.0.1', netmask: '255.255.255.255', port, publicCA: pki.ca, expectedCA: pki.pin, appOrigin: 'https://192.168.250.91:39443' });
  await new Promise(ok => server.listen(port, '127.0.0.1', ok)); const origin = `http://127.0.0.1:${port}`;
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 }); const profile = join(home, 'profile');
  browser = spawn('google-chrome', ['--headless', '--no-sandbox', '--remote-debugging-port=0', '--user-data-dir='+profile, '--disable-background-networking', '--no-first-run', 'about:blank'], { env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache') }, stdio: 'ignore' });
  exit = new Promise(ok => { browser.once('exit', ok); browser.once('error', ok); });
  let cdp;
  for (let i = 0; i < 100; i++) { try { cdp = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { /* startup */ } await new Promise(ok => setTimeout(ok, 100)); }
  assert.ok(cdp, 'Chrome unavailable');
  const page = await (await fetch(`http://127.0.0.1:${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((ok, fail) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', fail, { once: true }); });
  let id = 0; const pending = new Map(), errors = [], cspErrors = [];
  const send = (method, params = {}) => new Promise((ok, fail) => { const n = ++id; const timer = setTimeout(() => { pending.delete(n); fail(Error('CDP timeout')); }, 10000); pending.set(n, { ok, fail, timer }); ws.send(JSON.stringify({ id: n, method, params })); });
  ws.addEventListener('message', async event => {
    const m = JSON.parse(event.data);
    if (m.id) { const item = pending.get(m.id); if (item) { pending.delete(m.id); clearTimeout(item.timer); if (m.error) item.fail(Error(m.error.message)); else item.ok(m.result); } }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    else if (m.method === 'Log.entryAdded' && /content security policy|refused to apply/i.test(m.params.entry.text)) cspErrors.push(m.params.entry.text);
    else if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params;
      if (new URL(request.url).origin === origin && request.method === 'GET') await send('Fetch.continueRequest', { requestId });
      else await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true }); assert.equal(r.exceptionDetails, undefined); return r.result.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] });
  const results = [];
  for (const width of [360, 390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
    await send('Page.navigate', { url: origin });
    for (let i = 0; i < 100; i++) { if (await evaluate('document.querySelectorAll("ol>li").length===5')) break; await new Promise(ok => setTimeout(ok, 50)); }
    const state = await evaluate(`({title:document.querySelector('h1')?.textContent,width:innerWidth,scroll:document.documentElement.scrollWidth,steps:document.querySelectorAll('ol>li').length,download:document.querySelector('a[download]')?.getBoundingClientRect().height,background:getComputedStyle(document.body).backgroundColor,manual:document.body.innerText.includes('conferma manuale'),independent:document.body.innerText.includes('fonte separata'),privateInputs:document.querySelectorAll('input,form,script').length})`);
    assert.equal(state.title, 'Configura SpeseSmart'); assert.equal(state.steps, 5); assert.ok(state.scroll <= width); assert.ok(state.download >= 44); assert.ok(state.manual && state.independent); assert.equal(state.privateInputs, 0); assert.equal(state.background, 'rgb(244, 247, 245)');
    const image = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(screenshots, `${width}.png`), Buffer.from(image.data, 'base64')); results.push(state);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 1000, deviceScaleFactor: 1, mobile: true });
  await evaluate(`(()=>{const items=[...document.querySelectorAll('body *')].map(e=>[e,parseFloat(getComputedStyle(e).fontSize)]);for(const [e,n]of items)e.style.fontSize=(n*2)+'px';})()`);
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Overflow text 200%');
  assert.deepEqual(errors, []); assert.deepEqual(cspErrors, []);
  console.log(JSON.stringify({ viewports: results, enlargedText: 'PASS', csp: 'PASS', screenshots, realLANListenerStarted: false }));
} finally {
  ws?.close(); if (browser) { browser.kill('SIGTERM'); await exit; }
  if (server?.listening) { server.beginDrain(); await new Promise(ok => server.close(ok)); }
  await rm(root, { recursive: true, force: true });
}
