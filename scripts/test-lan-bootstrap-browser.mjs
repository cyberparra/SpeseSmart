// Explicit live READ-ONLY smoke test of npm run lan[:operate]. No mocked API
// or client bundles: this catches suspended Next hydration before useEffect.
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { X509Certificate, createHash } from 'node:crypto';
import { selectLAN } from './lan-gateway.mjs';
import { privateLANFile, validateLANCredentials } from './lan-credentials.mjs';

const directory = process.env.SPESESMART_LAN_DIR || join(homedir(), '.local/share/spesesmart/lan');
const interfaces = Object.fromEntries(Object.entries(networkInterfaces()).filter(([name]) => existsSync(join('/sys/class/net', name, 'device'))));
const network = selectLAN(interfaces, JSON.parse(execFileSync('ip', ['-j', '-4', 'route', 'show'], { encoding: 'utf8' })), process.env.SPESESMART_LAN_INTERFACE);
const port = Number(process.env.SPESESMART_LAN_PORT || 3443);
const origin = `https://${network.ip}:${port}`;
const credentials = validateLANCredentials(JSON.parse(await privateLANFile(join(directory, 'access.json'))));
const ca = await privateLANFile(join(directory, `tls-${network.ip}`, 'cert.pem'));
const cert = new X509Certificate(ca);
if (cert.checkIP(network.ip) !== network.ip || Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw Error('Certificato non valido per il collaudo.');
// First verify TLS normally with the explicit local trust anchor. Chrome is
// restricted to this verified certificate's public key in its disposable profile;
// never disable verification globally or change phone/system trust settings.
await new Promise((resolve, reject) => {
  const req = request(`${origin}/api/archive?view=dashboard`, { ca, headers: { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` } }, res => {
    res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(Error(`GET archive HTTPS: HTTP ${res.statusCode}.`)));
  });
  req.setTimeout(45000, () => req.destroy(Error('Timeout lettura HTTPS.')));
  req.on('error', () => reject(Error('Lettura HTTPS non riuscita. Verifica server e certificato.'))); req.end();
});
const profile = await mkdtemp('/tmp/spesesmart-lan-bootstrap-browser-');
const pin = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
const chrome = spawn(process.env.SPESESMART_CHROME || 'google-chrome', ['--headless', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${pin}`, '--no-first-run', '--disable-background-networking', 'about:blank'], { stdio: 'ignore' });
let chromeFailed = false; chrome.on('error', () => { chromeFailed = true; });
let ws;
try {
  let debugPort;
  for (let attempt = 0; attempt < 100 && !chromeFailed; attempt++) {
    try { debugPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break; } catch { /* Browser starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!debugPort) throw Error('Chrome di test non disponibile.');
  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  ws = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let id = 0, archiveRequests = 0, mutations = 0;
  const pending = new Map(), statuses = [], failures = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  ws.addEventListener('message', async event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id); pending.delete(message.id);
      if (message.error) entry.reject(Error('Comando diagnostico browser non riuscito.')); else entry.resolve(message.result);
      return;
    }
    try {
      if (message.method === 'Fetch.authRequired') await send('Fetch.continueWithAuth', { requestId: message.params.requestId, authChallengeResponse: { response: 'ProvideCredentials', username: credentials.username, password: credentials.password } });
      if (message.method === 'Fetch.requestPaused') {
        const { request: incoming, requestId } = message.params, url = new URL(incoming.url);
        if (!['GET', 'HEAD'].includes(incoming.method)) mutations++;
        const allowed = url.origin === origin && ['GET', 'HEAD'].includes(incoming.method);
        await send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' });
      }
      if (message.method === 'Network.requestWillBeSent' && new URL(message.params.request.url).pathname === '/api/archive') archiveRequests++;
      if (message.method === 'Network.responseReceived' && new URL(message.params.response.url).pathname === '/api/archive') statuses.push(message.params.response.status);
      if (message.method === 'Runtime.exceptionThrown') failures.push('Eccezione JavaScript nel browser.');
    } catch { failures.push('Richiesta diagnostica browser non completata.'); }
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: 'http*' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: origin });
  const state = await send('Runtime.evaluate', { expression: `new Promise(resolve=>{const deadline=Date.now()+55000;const check=()=>{const dashboard=!!document.querySelector('.dashboard-overview');const error=!!document.querySelector('.error[role="alert"]');if(dashboard||error||Date.now()>deadline)resolve({dashboard,error,loading:document.body.innerText.includes('Caricamento delle spese'),retry:document.querySelector('.archive-read-status button')?.innerText==='Riprova caricamento'});else setTimeout(check,100);};check();})`, awaitPromise: true, returnByValue: true });
  const result = state.result.value;
  if (!archiveRequests || statuses.at(-1) !== 200 || !result.dashboard || result.loading || mutations || failures.length) throw Error(`Bootstrap LAN non completato: richieste archive=${archiveRequests}, HTTP=${statuses.join(',')}, dashboard=${result.dashboard}, caricamento=${result.loading}.`);
  console.log(JSON.stringify({ authenticatedHTTPS: true, archiveRequests, archiveStatus: statuses.at(-1), hydratedDashboard: true, mobileWidth: 390, mutations: 0, paidOpenAICalls: 0 }));
} finally { ws?.close(); chrome.kill('SIGTERM'); }
