import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { X509Certificate } from 'node:crypto';
import { syntheticPKI } from './helpers/pi-pki.mjs';
import { createDeviceSetup, verifyPublicCA, readPublicCA, sameSubnet } from '../scripts/device-setup.mjs';

test('Configurazione dispositivi: distribuzione minima della sola CA pubblica', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'spesesmart-device-setup-'));
  let server; let time = 1000;
  try {
    const pki = await syntheticPKI(directory);
    server = createDeviceSetup({ ip: '127.0.0.1', netmask: '255.255.255.255', port: 39440, publicCA: pki.ca, expectedCA: pki.pin, appOrigin: 'https://192.168.250.91:39443', now: () => time });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    const call = (path = '/', { method = 'GET', headers = {}, body, localAddress } = {}) => new Promise((ok, fail) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, localAddress, agent: false, headers: { host: '127.0.0.1:39440', ...headers } }, res => { let content = ''; res.on('data', c => content += c); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: content })); }); req.on('error', fail); req.end(body);
    });
    await t.test('CA verificata prima del servizio, certificato errato/leaf/private key rifiutati', () => {
      assert.equal(verifyPublicCA(pki.ca, pki.pin).fingerprint, pki.pin);
      assert.throws(() => verifyPublicCA(pki.ca, 'AA:BB'));
      assert.throws(() => verifyPublicCA(pki.cert, new X509Certificate(pki.cert).fingerprint256));
      for (const bad of [pki.ca+'\n-----BEGIN PRIVATE KEY-----\nsecret', pki.ca+pki.ca, 'invalid', 'x'.repeat(20000)]) assert.throws(() => verifyPublicCA(bad, pki.pin));
      assert.throws(() => createDeviceSetup({ ip: '127.0.0.1', netmask: '255.255.255.0', port: 39440, publicCA: pki.ca, expectedCA: 'wrong', appOrigin: 'https://192.168.250.91:39443' }));
    });
    await t.test('lettura limitata, file regolare, impronta, permessi e symlink verificati', async () => {
      const path = join(directory, 'public.crt'); await writeFile(path, pki.ca, { mode: 0o600 });
      assert.equal((await readPublicCA(path, pki.pin)).fingerprint, pki.pin);
      await assert.rejects(readPublicCA(path)); // Production pin never accepts the fixture root.
      await chmod(path, 0o666); await assert.rejects(readPublicCA(path, pki.pin)); await chmod(path, 0o600);
      await symlink(path, join(directory, 'link.crt')); await assert.rejects(readPublicCA(join(directory, 'link.crt'), pki.pin));
      await writeFile(path, 'x'.repeat(20000)); await assert.rejects(readPublicCA(path, pki.pin));
    });
    await t.test('pagina italiana, nessun asset esterno, verifica indipendente e conferma Android', async () => {
      time += 61000; const r = await call(); assert.equal(r.status, 200); assert.match(r.headers['content-type'], /text\/html; charset=utf-8/);
      for (const text of ['Configura SpeseSmart', pki.pin, 'fonte separata', 'conferma manuale', 'Chrome', 'Brave', 'Vivaldi']) assert.ok(r.body.includes(text));
      assert.ok(!r.body.includes('<script')); assert.ok(!r.body.includes('PRIVATE KEY')); assert.ok(!r.body.includes('/api/'));
      assert.match(r.headers['content-security-policy'], /default-src 'none'/); assert.match(r.headers['content-security-policy'], /style-src 'sha256-/);
      assert.equal(r.headers['access-control-allow-origin'], undefined); assert.equal(r.headers['set-cookie'], undefined); assert.equal(r.headers['cache-control'], 'no-store');
    });
    await t.test('download corretto, Content-Type/Disposition, nessun altro contenuto', async () => {
      const r = await call('/spesesmart-ca.crt'); assert.equal(r.status, 200); assert.equal(new X509Certificate(r.body).fingerprint256, pki.pin);
      assert.equal(r.headers['content-type'], 'application/x-x509-ca-cert'); assert.match(r.headers['content-disposition'], /^attachment; filename=".*\.crt"$/); assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body));
    });
    await t.test('HEAD non invia corpo e conserva dimensione', async () => { const r = await call('/spesesmart-ca.crt', { method: 'HEAD' }); assert.equal(r.status, 200); assert.equal(r.body, ''); assert.ok(Number(r.headers['content-length']) > 0); });
    await t.test('path traversal, API, query e file privati non esposti', async () => {
      time += 61000;
      for (const path of ['/../server.key', '/%2e%2e/server.key', '//server.key', '/spesesmart-ca.crt?path=server.key', '/server.key', '/root-ca.key.enc', '/api/archive', '/api/receipts/analyze', '/journal', '/usage.json', '/config', '/favicon.ico']) assert.equal((await call(path)).status, 404, path);
    });
    await t.test('metodi, body, credenziali, Host e Origin estranei rifiutati', async () => {
      time += 61000;
      for (const method of ['POST', 'PATCH', 'DELETE', 'OPTIONS', 'PUT']) { const r = await call('/', { method }); assert.equal(r.status, 405); assert.equal(r.headers.allow, 'GET, HEAD'); }
      assert.equal((await call('/', { headers: { 'content-length': '2' }, body: '{}' })).status, 413);
      assert.equal((await call('/', { headers: { authorization: 'Basic test' } })).status, 400);
      assert.equal((await call('/', { headers: { cookie: 'test=1' } })).status, 400);
      assert.equal((await call('/', { headers: { host: 'evil.example:39440' } })).status, 421);
      assert.equal((await call('/', { headers: { origin: 'https://external.example' } })).status, 403);
    });
    await t.test('client fuori sottorete rifiutato; forwarded non aggira il controllo', async () => {
      assert.equal(sameSubnet('192.168.250.50', '192.168.250.91', '255.255.255.0'), true);
      for (const client of ['8.8.8.8', '192.168.249.1', 'bad']) assert.equal(sameSubnet(client, '192.168.250.91', '255.255.255.0'), false);
      assert.equal(sameSubnet('192.168.250.50', '192.168.250.91', '255.0.255.0'), false);
      assert.equal((await call('/', { localAddress: '127.0.0.2', headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 403);
    });
    await t.test('richieste concorrenti servite senza proxy o dati privati', async () => {
      time += 61000; const replies = await Promise.all(Array.from({ length: 12 }, () => call('/spesesmart-ca.crt')));
      assert.ok(replies.every(r => r.status === 200 && new X509Certificate(r.body).fingerprint256 === pki.pin));
    });
    await t.test('rate limit limitato e ripresa dopo finestra', async () => {
      time += 61000;
      for (let i = 0; i < 30; i++) assert.equal((await call()).status, 200);
      const blocked = await call(); assert.equal(blocked.status, 429); assert.equal(blocked.headers['retry-after'], '60');
      time += 61000; assert.equal((await call()).status, 200);
    });
    await t.test('arresto ordinato rifiuta nuovi accessi e chiude listener', async () => {
      server.beginDrain(); assert.equal((await call()).status, 503); await new Promise(ok => server.close(ok)); assert.equal(server.listening, false);
    });
  } finally { if (server?.listening) { server.closeIdleConnections(); await new Promise(ok => server.close(ok)); } await rm(directory, { recursive: true, force: true }); }
});
