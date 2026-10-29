// Strict TLS browser checks using only disposable HOME/NSS/profile and synthetic PKI.
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { syntheticPKI } from '../tests/helpers/pi-pki.mjs';
import { loadPiTLS } from './pi-tls.mjs';
import { createLANGateway } from './lan-gateway.mjs';
const root = await mkdtemp(join(tmpdir(), 'spesesmart-browser-pki-'));
let backend, gateway;
const listen = server => new Promise(ok => server.listen(0, '127.0.0.1', ok));
async function browser(binary, trusted, url) {
  const home = await mkdtemp(join(root, 'home-')); const profile = join(home, 'profile');
  await mkdir(profile, { mode: 0o700 });
  const database = join(home, '.pki/nssdb'); await mkdir(database, { recursive: true, mode: 0o700 });
  const nss = process.env.SPESESMART_TEST_CERTUTIL ?? 'certutil';
  execFileSync(nss, ['-N', '--empty-password', '-d', 'sql:'+database], { stdio: 'ignore' });
  if (trusted) execFileSync(nss, ['-A', '-d', 'sql:'+database, '-n', 'Synthetic SpeseSmart root', '-t', 'C,,', '-i', join(root, 'ca.crt')], { stdio: 'ignore' });
  // No TLS bypass flags, no real user profile or inherited credentials/configuration.
  const child = spawn(binary, ['--headless', '--no-sandbox', '--remote-debugging-port=0', '--user-data-dir='+profile, '--disable-background-networking', '--no-first-run', 'about:blank'], { env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share') }, stdio: 'ignore' });
  const exit = new Promise(ok => { child.once('exit', ok); child.once('error', ok); });
  let ws;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw Error('Browser non disponibile');
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { /* startup */ }
      await new Promise(ok => setTimeout(ok, 100));
    }
    assert.ok(port, 'Browser startup timeout');
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((ok, fail) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', fail, { once: true }); });
    let id = 0; const pending = new Map();
    const send = (method, params = {}) => new Promise((ok, fail) => { const n = ++id; const timer = setTimeout(() => { pending.delete(n); fail(Error('CDP timeout')); }, 10000); pending.set(n, { ok, fail, timer }); ws.send(JSON.stringify({ id: n, method, params })); });
    ws.addEventListener('message', event => { const message = JSON.parse(event.data); const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); if (message.error) item.fail(Error(message.error.message)); else item.ok(message.result); } });
    await send('Page.enable'); await send('Network.enable');
    await send('Network.setExtraHTTPHeaders', { headers: { Authorization: 'Basic '+Buffer.from('fixture:synthetic-password').toString('base64') } });
    const result = await send('Page.navigate', { url });
    if (!trusted) { assert.match(result.errorText ?? '', /ERR_CERT_AUTHORITY_INVALID/); }
    else {
      assert.equal(result.errorText, undefined);
      let found = false;
      for (let i = 0; i < 100; i++) { const body = await send('Runtime.evaluate', { expression: 'document.body?.textContent', returnByValue: true }); if (body.result.value?.includes('TLS sintetico verificato')) { found = true; break; } await new Promise(ok => setTimeout(ok, 50)); }
      assert.ok(found, 'Authenticated HTTPS fixture not rendered');
    }
    console.log(`${binary}: ${trusted ? 'CA sintetica attendibile, HTTPS autenticato OK' : 'CA non attendibile respinta correttamente'}`);
  } finally { ws?.close(); child.kill('SIGTERM'); await exit; }
}
try {
  const pki = await syntheticPKI(root); const bundle = await pki.bundle(join(root, 'bundle'));
  const tls = await loadPiTLS(bundle, '127.0.0.1', pki.pin);
  backend = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>TLS fixture</title><p>TLS sintetico verificato</p>'); }); await listen(backend);
  const reserve = createServer(); await listen(reserve); const port = reserve.address().port; await new Promise(ok => reserve.close(ok));
  gateway = createLANGateway({ ip: '127.0.0.1', port, upstreamPort: backend.address().port, username: 'fixture', password: 'synthetic-password', key: tls.key, cert: tls.cert });
  await new Promise(ok => gateway.listen(port, '127.0.0.1', ok));
  for (const binary of ['google-chrome', 'brave-browser']) for (const trusted of [false, true]) await browser(binary, trusted, `https://127.0.0.1:${port}/`);
  console.log('4 casi browser riusciti; nessuna modifica ai trust store reali.');
} finally {
  for (const server of [gateway, backend]) if (server?.listening) { server.closeIdleConnections(); await new Promise(ok => server.close(ok)); }
  await rm(root, { recursive: true, force: true });
}
