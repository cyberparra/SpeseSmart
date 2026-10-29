import { piConfig } from './pi-config.mjs';
// Explicit Raspberry-only end-to-end check. Never uses PC credentials or real APIs.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { privateLANFile } from './lan-credentials.mjs';
import { isolatedEnvironment } from './pi-preview.mjs';

const installation = piConfig();
assert.equal(execFileSync('findmnt', ['-n', '--mountpoint', installation.mount, '-o', 'UUID'], { encoding: 'utf8' }).trim(), installation.ssdUUID);
const directory = installation.mount + '/https-preview';
assert.ok(process.env.SPESESMART_PI_TLS_DIR, 'TLS CA/leaf separati richiesti');
const ca = await readFile(process.env.SPESESMART_PI_TLS_DIR + '/ca.crt');
const credentials = JSON.parse(await privateLANFile(directory + '/access.json'));
const base = `https://${installation.ip}:39443`;
const auth = 'Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64');
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/pi-preview.mjs', 'start'], { cwd: installation.app, env: { SPESESMART_PI_CONFIG: process.env.SPESESMART_PI_CONFIG, ...isolatedEnvironment(directory + '/home'), SPESESMART_PI_PREVIEW_DIR: directory, SPESESMART_PI_TLS_DIR: process.env.SPESESMART_PI_TLS_DIR, SPESESMART_PI_TLS_CA_SHA256: process.env.SPESESMART_PI_TLS_CA_SHA256 }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
const exit = new Promise(ok => child.once('exit', code => ok(code)));
const call = (path, headers = {}, method = 'GET') => new Promise((ok, fail) => {
  const req = httpsRequest(base + path, { ca, agent: false, method, timeout: 5000, headers: { authorization: auth, ...(!['GET', 'HEAD'].includes(method) ? { 'content-length': '2' } : {}), ...headers } }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body })); }); req.on('error', fail); req.on('timeout', () => req.destroy(Error('timeout'))); req.end(['GET', 'HEAD'].includes(method) ? undefined : '{}');
});
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw Error('Launcher terminato prima della disponibilità: ' + output);
    try { ready = (await call('/')).status === 200; } catch { /* bounded startup */ }
    if (ready) break;
    await new Promise(ok => setTimeout(ok, 200));
  }
  assert.ok(ready, 'Production bootstrap timeout');
  assert.equal((await call('/', { authorization: '' })).status, 401);
  assert.equal((await call('/', { origin: 'https://foreign.invalid' })).status, 403);
  const archive = await call('/api/archive?view=dashboard');
  assert.equal(archive.status, 200); const data = JSON.parse(archive.body);
  assert.equal(data.archive.receipts.length, 1); assert.ok(data.archive.expenses.every(e => e.merchant.startsWith('COLLAUDO'))); assert.equal(data.writesEnabled, false); assert.equal(data.lanReadOnly, true);
  const session = await call('/api/lan/session', { 'sec-fetch-site': 'same-origin' }); assert.equal(session.status, 200);
  const headers = { origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: session.headers['set-cookie'][0].split(';')[0] };
  assert.match((await call('/api/archive', headers, 'POST')).body, /CSRF/);
  headers['x-spesesmart-csrf'] = JSON.parse(session.body).csrf;
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal(JSON.parse((await call('/api/archive', headers, method)).body).code, 'PREVIEW_ONLY');
  assert.equal((await call('/api/receipts/analyze', { ...headers, 'content-type': 'multipart/form-data; boundary=x' }, 'POST')).status, 403);
  assert.equal((await call('/api/archive')).status, 403); assert.equal((await call('/api/reset', headers, 'POST')).status, 403);
  const backend = await new Promise((ok, fail) => { const req = httpRequest('http://127.0.0.1:39445/api/archive?view=dashboard', res => { res.resume(); ok(res.statusCode); }); req.on('error', fail); req.end(); });
  assert.equal(backend, 503, 'Direct API must fail before repository access');
  for (const port of [39444, 39445]) await new Promise((ok, fail) => { const socket = connect({ host: installation.ip, port, timeout: 2000 }); socket.on('connect', () => { socket.destroy(); fail(Error('Backend exposed on LAN')); }); socket.on('error', error => error.code === 'ECONNREFUSED' ? ok() : fail(error)); socket.on('timeout', () => { socket.destroy(); fail(Error('LAN probe timeout')); }); });
  assert.deepEqual(await readdir(directory + '/home'), [], 'No journal/ledger/cache created');
  console.log('Production HTTPS: PASS; auth/Origin/CSRF: PASS; synthetic archive: PASS; all mutations/admin/AI: BLOCKED; direct API: 503; loopback isolation: PASS; no registry created: PASS.');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  let timeout;
  try { const code = await Promise.race([exit, new Promise((_, fail) => { timeout = setTimeout(() => fail(Error('Arresto non concluso: verificare manualmente, nessun SIGKILL inviato.')), 60000); })]); assert.equal(code, 0); }
  finally { clearTimeout(timeout); }
}
for (const port of [39443, 39444, 39445]) await new Promise((ok, fail) => { const socket = connect({ host: port === 39443 ? installation.ip : '127.0.0.1', port }); socket.on('connect', () => { socket.destroy(); fail(Error('Listener still active')); }); socket.on('error', e => e.code === 'ECONNREFUSED' ? ok() : fail(e)); });
console.log('SIGTERM and all three listeners closed: PASS.');
