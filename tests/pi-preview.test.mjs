import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, request as plainRequest } from 'node:http';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createLANGateway } from '../scripts/lan-gateway.mjs';
import { syntheticPKI } from './helpers/pi-pki.mjs';
import { fixtureProxy, previewArchive } from '../scripts/pi-preview-fixture.mjs';
import { isolatedEnvironment } from '../scripts/pi-preview.mjs';
import { createBackup, parseBackup } from '../src/lib/archive.ts';
import { buildPurchases } from '../src/lib/purchases.ts';
const listen = (server) => new Promise(ok => server.listen(0, '127.0.0.1', ok));
const close = server => new Promise(ok => { server.closeIdleConnections(); server.close(ok); });

test('Pi preview: synthetic archive validates, groups receipt and never exposes write capabilities', () => {
  const fixture = previewArchive();
  const archive = parseBackup(JSON.stringify(createBackup(fixture.archive))).archive;
  const purchases = buildPurchases(archive);
  assert.equal(purchases.length, 2);
  assert.ok(purchases.every(p => p.merchant.startsWith('COLLAUDO')));
  assert.equal(purchases.reduce((n, p) => n + p.totalCents, 0), 2090);
  assert.equal(fixture.previewOnly, true); assert.equal(fixture.lanReadOnly, true); assert.equal(fixture.writesEnabled, false);
  assert.equal(JSON.stringify(fixture).includes('data:image'), false);
});

test('Pi preview: child environment excludes inherited secrets and all outbound sockets/fetch are denied', () => {
  const env = isolatedEnvironment('/isolated/home');
  for (const key of ['OPENAI_API_KEY', 'GOOGLE_SHEETS_SPREADSHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'NODE_OPTIONS', 'SPESESMART_ACCESS_PASSWORD']) assert.equal(env[key], undefined);
  assert.equal(env.SPESESMART_SHEETS_WRITES_ENABLED, 'false');
  const result = execFileSync(process.execPath, ['--import', join(process.cwd(), 'scripts/pi-preview-network.mjs'), '--input-type=module', '-e', `
    import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https';
    for (const attempt of [()=>net.connect(443,'sheets.googleapis.com'),()=>tls.connect(443,'api.openai.com'),()=>http.get('http://sheets.googleapis.com'),()=>https.get('https://api.openai.com'),()=>fetch('https://api.openai.com')]) {
      try { await attempt(); throw Error('NETWORK_ALLOWED'); } catch(e) { if(e.code!=='PREVIEW_NETWORK_DENIED') throw e; }
    } console.log('DENIED');`], { env, encoding: 'utf8' });
  assert.equal(result.trim(), 'DENIED');
});

test('Pi preview: TLS authentication, exact Host/Origin, sessions/CSRF, API isolation and drain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spesesmart-pi-preview-'));
  let backend, proxy, gateway;
  try {
    const pki = await syntheticPKI(directory);
    let nextRequests = 0;
    backend = createServer((_req, res) => { nextRequests++; res.end('synthetic page'); }); await listen(backend);
    proxy = fixtureProxy(backend.address().port); await listen(proxy);
    const cert = pki.cert;
    // Reserve a port first because the gateway validates the exact authority.
    const reserve = createServer(); await listen(reserve); const port = reserve.address().port; await close(reserve);
    gateway = createLANGateway({ ip: '127.0.0.1', port, upstreamPort: proxy.address().port, username: 'test', password: 'abcdefgh', key: pki.key, cert, operational: true, capability: 'a'.repeat(64) });
    await new Promise(ok => gateway.listen(port, '127.0.0.1', ok));
    const plainStatus = await new Promise((ok, fail) => {
      const req = plainRequest(`http://127.0.0.1:${port}/`, res => { res.resume(); ok(res.statusCode); });
      req.on('error', e => e.code === 'ECONNRESET' ? ok(400) : fail(e)); req.end();
    });
    assert.equal(plainStatus, 400, 'Plain HTTP is never served');
    const origin = `https://127.0.0.1:${port}`;
    const basic = 'Basic '+Buffer.from('test:abcdefgh').toString('base64');
    const get = (path, headers = {}, method = 'GET') => new Promise((ok, fail) => {
      const req = request(origin + path, { ca: pki.ca, checkServerIdentity: (_host, peer) => checkServerIdentity('127.0.0.1', peer), method, agent: false, headers: { authorization: basic, ...headers } }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body })); }); req.on('error', fail); req.end(method === 'POST' ? '{}' : undefined);
    });
    assert.equal((await get('/', { authorization: '' })).status, 401);
    assert.equal((await get('/', { host: 'other:39443' })).status, 421);
    assert.equal((await get('/', { origin: 'https://other' })).status, 403);
    assert.equal((await get('/')).status, 200); assert.equal(nextRequests, 1);
    const archive = await get('/api/archive?view=dashboard'); assert.equal(archive.status, 200); assert.ok(archive.body.includes('COLLAUDO'));
    assert.equal((await get('/api/archive')).status, 403);
    assert.equal((await get('/api/lan/session')).status, 403);
    const session = await get('/api/lan/session', { 'sec-fetch-site': 'same-origin' });
    assert.equal(session.status, 200);
    assert.match(session.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Strict/);
    const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: session.headers['set-cookie'][0].split(';')[0] };
    const denied = await get('/api/archive', headers, 'POST'); assert.equal(denied.status, 403); assert.match(denied.body, /CSRF/);
    headers['x-spesesmart-csrf'] = JSON.parse(session.body).csrf;
    for (const method of ['POST', 'PATCH', 'DELETE']) { const result = await get('/api/archive', headers, method); assert.equal(result.status, 403); assert.equal(JSON.parse(result.body).code, 'PREVIEW_ONLY'); }
    assert.equal((await get('/api/receipts/analyze', { ...headers, 'content-type': 'multipart/form-data; boundary=x' }, 'POST')).status, 403);
    assert.equal((await get('/api/reset', headers, 'POST')).status, 403);
    assert.equal(nextRequests, 1, 'No API reaches Next');
    gateway.beginDrain(); assert.equal(await gateway.waitForDrain(1000), true);
    assert.equal((await get('/')).status, 503);
  } finally {
    for (const server of [gateway, proxy, backend]) if (server?.listening) await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
