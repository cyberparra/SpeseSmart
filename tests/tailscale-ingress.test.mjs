import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { spawnSync } from 'node:child_process';
import { syntheticPKI } from './helpers/pi-pki.mjs';
import { createLANGateway } from '../scripts/lan-gateway.mjs';
import { createTailscaleAdapter, configuredTailscaleHostname, validateTailscaleHostname, TAILSCALE_INGRESS_HEADER } from '../scripts/tailscale-ingress.mjs';
import { lanGatewayRequest } from '../src/lib/lan-mode.ts';
import { isSameOriginRequest } from '../src/lib/request-origin.ts';

const hostname = 'spesesmart-pi.tailfixture.ts.net', remoteOrigin = `https://${hostname}`;
const lanAuthority = '192.168.250.91:3443', lanOrigin = `https://${lanAuthority}`;
const authorization = 'Basic ' + Buffer.from('fixture:solo-password-sintetica').toString('base64');
const backendCapability = 'a'.repeat(64), ingressCapability = 'b'.repeat(64);
let directory, pki, otherPKI, frontCert, wrongIPCert, expiredCert;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spesesmart-tailscale-fixture-'));
  pki = await syntheticPKI(directory);
  frontCert = await pki.issue({ ip: `127.0.0.1,DNS:${hostname}` });
  wrongIPCert = await pki.issue({ ip: '127.0.0.2' });
  expiredCert = await pki.issue({ dates: ['20200101000000Z', '20200102000000Z'] });
  const other = join(directory, 'untrusted'); await mkdir(other, { mode: 0o700 });
  otherPKI = await syntheticPKI(other);
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

async function fixture(work, { gatewayTLS = pki, remoteEnabled = true } = {}) {
  const names = ['NODE_ENV', 'VERCEL', 'SPESESMART_HOME_PRODUCTION', 'SPESESMART_LAN_OPERATIONAL', 'SPESESMART_LAN_READ_ONLY',
    'SPESESMART_LAN_CAPABILITY', 'SPESESMART_LAN_INTERNAL_PORT', 'SPESESMART_LAN_ORIGIN'];
  const previous = names.map(name => process.env[name]);
  let backend, gateway, adapter, front, backendCalls = 0, gatewayCalls = 0, lastHeaders, dispatch = async () => ({ fixture: true });
  try {
    backend = httpServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const web = new Request(`http://127.0.0.1:${backend.address().port}${req.url}`, { method: req.method, headers: req.headers });
      if (!lanGatewayRequest(web) || (!['GET', 'HEAD'].includes(req.method) && !isSameOriginRequest(web))) { res.writeHead(403); res.end('{}'); return; }
      lastHeaders = req.headers; backendCalls++;
      const result = await dispatch(web, Buffer.concat(chunks));
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
    });
    backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
    Object.assign(process.env, { NODE_ENV: 'development', SPESESMART_HOME_PRODUCTION: 'false', SPESESMART_LAN_OPERATIONAL: 'true',
      SPESESMART_LAN_READ_ONLY: 'false', SPESESMART_LAN_CAPABILITY: backendCapability,
      SPESESMART_LAN_INTERNAL_PORT: String(backend.address().port), SPESESMART_LAN_ORIGIN: lanOrigin });
    delete process.env.VERCEL;
    const remote = remoteEnabled ? { hostname, capability: ingressCapability } : undefined;
    gateway = createLANGateway({ ip: '192.168.250.91', port: 3443, upstreamPort: backend.address().port,
      username: 'fixture', password: 'solo-password-sintetica', key: gatewayTLS.key, cert: gatewayTLS.cert,
      operational: true, capability: backendCapability, tailscale: remote });
    gateway.on('request', () => { gatewayCalls++; });
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    adapter = createTailscaleAdapter({ hostname, capability: ingressCapability, ip: '127.0.0.1', port: gateway.address().port,
      ca: pki.ca, expectedCA: pki.pin });
    adapter.listen(0, '127.0.0.1'); await once(adapter, 'listening');
    // Synthetic equivalent of Serve's verified implementation: preserve Host and
    // Origin; add forwarding/identity headers that our adapter must not trust.
    front = httpsServer({ key: pki.key, cert: frontCert }, (req, res) => {
      const out = httpRequest({ hostname: '127.0.0.1', port: adapter.address().port, path: req.url, method: req.method,
        headers: { ...req.headers, 'x-forwarded-for': '203.0.113.10', 'x-forwarded-proto': 'https',
          'tailscale-user-login': 'fixture@example.invalid' } }, incoming => {
        res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
      });
      out.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('{}'); });
      req.pipe(out);
    });
    front.listen(0, '127.0.0.1'); await once(front, 'listening');
    const call = (target = 'remote', path = '/', { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
      const remote = target === 'remote', directAdapter = target === 'adapter', directBackend = target === 'backend';
      const destination = remote ? front : directAdapter ? adapter : directBackend ? backend : gateway;
      const request = directAdapter || directBackend ? httpRequest : httpsRequest;
      const req = request({ hostname: '127.0.0.1', port: destination.address().port, path, method, rejectUnauthorized: true,
        ...(directAdapter || directBackend ? {} : { ca: pki.ca, servername: remote ? hostname : '',
          checkServerIdentity: (name, certificate) => checkServerIdentity(remote ? hostname : '127.0.0.1', certificate) }),
        headers: { host: remote || directAdapter ? hostname : directBackend ? `127.0.0.1:${backend.address().port}` : lanAuthority,
          authorization, 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }), ...headers } }, res => {
        let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject); req.end(body);
    });
    const signed = async target => {
      const session = await call(target, '/api/lan/session'); assert.equal(session.status, 200);
      return { cookie: session.headers['set-cookie'][0].split(';')[0], 'x-spesesmart-csrf': session.body.csrf,
        origin: target === 'remote' ? remoteOrigin : lanOrigin, 'content-type': 'application/json' };
    };
    await work({ call, signed, gateway, adapter, front, backend, counts: () => ({ backend: backendCalls, gateway: gatewayCalls }),
      headers: () => lastHeaders, dispatch: value => { dispatch = value; } });
  } finally {
    const servers = [front, adapter, gateway, backend].filter(Boolean);
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
}

test('Tailscale: profilo opt-in solo Pi, singolo FQDN esatto e nessun default derivato da header', () => {
  assert.equal(configuredTailscaleHostname({}, false), undefined);
  assert.equal(configuredTailscaleHostname({ SPESESMART_PI_TAILSCALE_HOSTNAME: hostname }, true), hostname);
  assert.throws(() => configuredTailscaleHostname({ SPESESMART_PI_TAILSCALE_HOSTNAME: hostname }, false));
  assert.throws(() => configuredTailscaleHostname({ SPESESMART_PI_TAILSCALE_HOSTNAME: hostname, VERCEL: '1' }, true));
  for (const value of ['', '*.ts.net', '.ts.net', 'unknown.example.org', hostname+'.evil.invalid', 'https://'+hostname,
    hostname+':443', hostname+'.', hostname.toUpperCase(), 'user@'+hostname, ['one', 'two']]) assert.throws(() => validateTailscaleHostname(value));
});

test('Tailscale: launcher production reale in VM, default LAN, stop coordinato e avvio fallito senza processi orfani', () => {
  const result=spawnSync(process.execPath,['--experimental-vm-modules','tests/helpers/tailscale-launcher-fixture.mjs'],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/Launcher production:/);
});

test('Tailscale: HTTPS sintetico completo, LAN invariata, autenticazione e sessioni Secure per ogni origine', async () => fixture(async ({ call, signed, counts, headers, adapter, front, gateway, backend }) => {
  for (const server of [adapter, front, gateway, backend]) assert.equal(server.address().address, '127.0.0.1');
  for (const target of ['lan', 'remote']) {
    for (const path of ['/', '/api/archive?view=dashboard', '/api/ai/usage']) {
      assert.equal((await call(target, path, { headers: { authorization: '' } })).status, 401);
      assert.equal((await call(target, path)).status, 200);
    }
    const session = await call(target, '/api/lan/session');
    assert.match(session.headers['set-cookie'][0], /^__Host-spesesmart-lan=.*; Path=\/; Secure; HttpOnly; SameSite=Strict;/);
    assert.doesNotMatch(session.headers['set-cookie'][0], /Domain=/i);
  }
  const remote = await signed('remote'), lan = await signed('lan');
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    assert.equal((await call('remote', '/api/archive', { method, headers: remote, body: '{}' })).status, 200);
    assert.equal(headers().origin, lanOrigin);
    assert.equal(headers()['x-spesesmart-lan-capability'], backendCapability);
    for (const name of ['authorization','cookie','x-spesesmart-csrf',TAILSCALE_INGRESS_HEADER,'x-forwarded-host','x-forwarded-for','x-forwarded-proto','tailscale-user-login']) assert.equal(headers()[name], undefined);
  }
  const before = counts().backend;
  assert.equal((await call('lan', '/api/archive', { method: 'POST', headers: { ...remote, origin: lanOrigin }, body: '{}' })).status, 403);
  assert.equal((await call('remote', '/api/archive', { method: 'POST', headers: { ...lan, origin: remoteOrigin }, body: '{}' })).status, 403);
  assert.equal(counts().backend, before);
  assert.equal((await call('lan', '/api/archive', { method: 'POST', headers: lan, body: '{}' })).status, 200);
}));

test('Tailscale: host/origin contraffatti, forwarding e capability del client non aggirano i gate', async () => fixture(async ({ call, signed, counts }) => {
  const session = await signed('remote'), before = counts().backend;
  for (const host of ['evil.invalid','unknown.tailfixture.ts.net',hostname+':443',lanAuthority,'127.0.0.1:3444']) {
    assert.equal((await call('remote', '/', { headers: { host, 'x-forwarded-host': hostname, 'x-forwarded-proto': 'https' } })).status, 421);
  }
  for (const origin of ['https://evil.invalid', lanOrigin, 'http://'+hostname, remoteOrigin+':3443', 'null']) {
    assert.equal((await call('remote', '/api/archive', { method: 'POST', headers: { ...session, origin,
      'x-forwarded-origin': remoteOrigin, [TAILSCALE_INGRESS_HEADER]: ingressCapability }, body: '{}' })).status, 403);
  }
  for (const change of [{ authorization: '' }, { cookie: '' }, { 'x-spesesmart-csrf': '' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    assert.ok([401,403].includes((await call('remote', '/api/archive', { method: 'POST', headers: { ...session, ...change }, body: '{}' })).status));
  }
  for (const capability of ['', randomBytes(32).toString('hex'), backendCapability]) {
    assert.equal((await call('lan', '/', { headers: { host: hostname, [TAILSCALE_INGRESS_HEADER]: capability } })).status, 421);
  }
  assert.equal((await call('backend', '/', { headers: { 'x-forwarded-host': hostname, 'x-forwarded-proto': 'https', [TAILSCALE_INGRESS_HEADER]: ingressCapability } })).status, 403);
  assert.equal(counts().backend, before);
  assert.equal((await call('remote', '/', { headers: { 'x-forwarded-host': 'evil.invalid', [TAILSCALE_INGRESS_HEADER]: 'forged' } })).status, 200);
  assert.equal((await call('adapter', '/', { headers: { origin: [remoteOrigin, 'https://evil.invalid'] } })).status, 400);
}));

test('Tailscale: navigazione iniziale consentita, API cross-site, admin, HMR e metodi estranei negati', async () => fixture(async ({ call, counts }) => {
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  assert.equal((await call('remote', '/', { headers: navigation })).status, 200);
  const before = counts().backend;
  for (const path of ['/api/archive?view=dashboard','/api/lan/session','/_next/static/chunk.js']) assert.equal((await call('remote', path, { headers: navigation })).status, 403);
  assert.equal((await call('remote', '/', { headers: { ...navigation, 'sec-fetch-dest': 'iframe' } })).status, 403);
  for (const path of ['/api/archive','/api/archive?view=backup','/api/reset','/.env','/_next/webpack-hmr','/_next/static/chunk.js.map']) assert.equal((await call('remote', path)).status, 403);
  for (const method of ['PUT','OPTIONS','TRACE']) assert.equal((await call('remote', '/', { method })).status, 403);
  assert.equal(counts().backend, before);
}));

test('Tailscale: un solo invio finanziario condiviso con LAN, drain coordinato e nessun retry', async () => fixture(async ({ call, signed, counts, dispatch, gateway, adapter }) => {
  const remote = await signed('remote'), lan = await signed('lan');
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  dispatch(async () => { entered(); await new Promise(resolve => { release = resolve; }); return { fixture: true }; });
  const first = call('remote','/api/archive',{ method:'POST',headers:remote,body:'{}' }); await started;
  const before = counts().backend;
  assert.equal((await call('lan','/api/archive',{ method:'POST',headers:lan,body:'{}' })).status,409);
  adapter.beginDrain(); gateway.beginDrain();
  assert.equal(await adapter.waitForDrain(10),false); assert.equal(await gateway.waitForDrain(10),false);
  assert.equal((await call('remote','/api/archive',{ method:'POST',headers:remote,body:'{}' })).status,503);
  release(); assert.equal((await first).status,200);
  assert.equal(await adapter.waitForDrain(1000),true); assert.equal(await gateway.waitForDrain(1000),true);
  assert.equal(counts().backend,before);
}));

test('Tailscale: gateway senza configurazione remota continua a rifiutare quel canale', async () => fixture(async ({ call }) => {
  assert.equal((await call('lan','/')).status,200);
  assert.equal((await call('remote','/')).status,421);
}, { remoteEnabled:false }));

test('Tailscale: CA diversa, CA aggiunta, SAN errato e certificato scaduto bloccano prima degli header HTTP', async () => {
  const options={hostname,capability:ingressCapability,ip:'127.0.0.1',port:3443,ca:pki.ca,expectedCA:pki.pin};
  assert.throws(()=>createTailscaleAdapter({...options,ca:otherPKI.ca}));
  assert.throws(()=>createTailscaleAdapter({...options,ca:pki.ca+otherPKI.ca}));
  assert.throws(()=>createTailscaleAdapter({...options,ip:'203.0.113.10'}));
  for(const gatewayTLS of [otherPKI,{...pki,cert:wrongIPCert},{...pki,cert:expiredCert}]) {
    await fixture(async ({call,counts})=>{
      assert.equal((await call('remote','/')).status,502);
      assert.deepEqual(counts(),{backend:0,gateway:0});
    },{gatewayTLS});
  }
});
