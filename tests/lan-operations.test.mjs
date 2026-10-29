import './helpers/isolated-host-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createLANGateway } from '../scripts/lan-gateway.mjs';
import { lanGatewayRequest, lanRuntimeValid } from '../src/lib/lan-mode.ts';
import { isSameOriginRequest } from '../src/lib/request-origin.ts';
import { googleSheetsWritesEnabled } from '../src/lib/google-sheets.ts';
import { aiAccess } from '../src/lib/ai-access.ts';
import { GET, POST, PATCH, DELETE } from '../src/app/api/archive/route.ts';
import { createSheetsRepository } from '../src/lib/sheets-repository.ts';
import { createUpdateStore } from '../src/lib/sheets-update-store.ts';
import { TABLE_HEADERS, extraHeaders } from '../src/lib/sheets-persistence-model.ts';
import { categoryDefinitions } from '../src/lib/categories.ts';
import { aiConfiguration, initializeAI, controlledAnalysis, getAIUsage } from '../src/lib/ai-usage.ts';
import { demoReceipt } from '../src/lib/receipts/demo.ts';
import { operationalHeaders } from '../src/lib/operational-headers.ts';
import { homeRuntimeDirectory, writeHomeProof } from '../scripts/home-runtime.mjs';

const origin = 'https://192.168.250.115:3443', capability = 'a'.repeat(64);
const productionFixture = process.env.SPESESMART_TEST_HOME_PRODUCTION === 'true'; // Test harness only; never read by application code.
const envKeys = ['NODE_ENV', 'VERCEL', 'SPESESMART_LAN_READ_ONLY', 'SPESESMART_LAN_OPERATIONAL', 'SPESESMART_LAN_CAPABILITY', 'SPESESMART_LAN_ORIGIN', 'SPESESMART_LAN_INTERNAL_PORT', 'SPESESMART_SHEETS_WRITES_ENABLED', 'SPESESMART_HOME_PRODUCTION', 'SPESESMART_HOME_PROOF', 'SPESESMART_AI_DATA_DIR', 'SPESESMART_SHEETS_UPDATE_DIR', 'GOOGLE_SHEETS_SPREADSHEET_ID'];
test('LAN client: sessione acquisita prima dell’invio, nessun retry su errore e nessun Content-Type JSON per multipart', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async (url, options) => { calls++; assert.equal(url, '/api/lan/session'); assert.equal(options.cache, 'no-store'); return Response.json({ csrf: 'fixture' }); };
    assert.deepEqual(await operationalHeaders(), { 'Content-Type': 'application/json' }); assert.equal(calls, 0);
    assert.deepEqual(await operationalHeaders(false, true), { 'X-SpeseSmart-CSRF': 'fixture' }); assert.equal(calls, 1);
    globalThis.fetch = async () => { calls++; throw new TypeError('fixture connection interrupted'); };
    await assert.rejects(operationalHeaders(true, true)); assert.equal(calls, 2);
    globalThis.fetch = async () => { calls++; return Response.json({ error: 'expired' }, { status: 401 }); };
    await assert.rejects(operationalHeaders(true, true), /bozza/); assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});
async function fixture(work) {
  const previous = envKeys.map(key => process.env[key]);
  const dir = await mkdtemp(join(tmpdir(), 'spesesmart-lan-operations-')); await chmod(dir, 0o700);
  let gateway, upstream, time = Date.now(), dispatch = async () => ({ ok: true }), forwarded = 0;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=fixture', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    const cert = await readFile(join(dir, 'cert.pem')), key = await readFile(join(dir, 'key.pem'));
    upstream = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const web = new Request(`http://127.0.0.1:${upstream.address().port}${req.url}`, { method: req.method, headers: req.headers });
        assert.equal(req.headers.authorization, undefined); // Public password never enters Next in operational mode.
        assert.equal(req.headers.cookie, undefined);
        if (!lanGatewayRequest(web) || (req.method !== 'GET' && !isSameOriginRequest(web))) { res.writeHead(403); return res.end('{}'); }
        forwarded++;
        const result = await dispatch(web, body);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
      } catch (error) { res.writeHead(error.code === 'AI_LIMIT' ? 429 : 503); res.end(JSON.stringify({ code: error.code ?? 'FIXTURE_INTERRUPTION' })); }
    });
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    Object.assign(process.env, { NODE_ENV: productionFixture ? 'production' : 'development', SPESESMART_LAN_READ_ONLY: 'false', SPESESMART_LAN_OPERATIONAL: 'true', SPESESMART_HOME_PRODUCTION: String(productionFixture), SPESESMART_LAN_CAPABILITY: capability, SPESESMART_LAN_ORIGIN: origin, SPESESMART_LAN_INTERNAL_PORT: String(upstream.address().port), SPESESMART_SHEETS_WRITES_ENABLED: 'true' }); delete process.env.VERCEL;
    if (productionFixture) {
      const aiDirectory = join(dir, 'home-ai'); await initializeAI(aiConfiguration({ SPESESMART_AI_DATA_DIR: aiDirectory }));
      const store = createUpdateStore({ NODE_ENV: 'test', SPESESMART_SHEETS_UPDATE_DIR: dir, GOOGLE_SHEETS_SPREADSHEET_ID: 'fixture' });
      await store.lock(async () => {}); // Explicit initialization of new fixture only.
      Object.assign(process.env, { SPESESMART_AI_DATA_DIR: aiDirectory, SPESESMART_SHEETS_UPDATE_DIR: dir, GOOGLE_SHEETS_SPREADSHEET_ID: 'fixture' });
      process.env.SPESESMART_HOME_PROOF = await writeHomeProof(homeRuntimeDirectory(), { version: 1, pid: process.pid, capability, origin, port: String(upstream.address().port), scope: store.scope, aiDirectory, updateDirectory: dir });
    }
    const authorization = 'Basic ' + Buffer.from('fixture:abcdefgh').toString('base64');
    gateway = createLANGateway({ ip: '192.168.250.115', port: 3443, upstreamPort: upstream.address().port, username: 'fixture', password: 'abcdefgh', key, cert, operational: true, capability, now: () => time });
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
    const call = (path = '/', { method = 'GET', headers = {}, body, onForwarded } = {}) => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: gateway.address().port, ca: cert, path, method, headers: { host: '192.168.250.115:3443', authorization, 'sec-fetch-site': 'same-origin', ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }), ...headers } }, res => {
        let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
      }); req.on('error', reject); req.end(body);
      if (onForwarded) onForwarded(req);
    });
    const session = await call('/api/lan/session'); assert.equal(session.status, 200);
    const signed = { cookie: session.headers['set-cookie'][0].split(';')[0], 'x-spesesmart-csrf': session.body.csrf, origin, 'content-type': 'application/json' };
    await work({ call, signed, session, dir, gateway, port: upstream.address().port, forwardCount: () => forwarded, advance: ms => { time += ms; }, dispatch: handler => { dispatch = handler; } });
  } finally {
    gateway?.closeAllConnections(); upstream?.closeAllConnections();
    await Promise.all([gateway && new Promise(resolve => gateway.close(resolve)), upstream && new Promise(resolve => upstream.close(resolve))]);
    envKeys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    await rm(dir, { recursive: true, force: true });
  }
}

test('LAN operativa: TLS autenticato, sessione privata a scadenza, Origin e CSRF obbligatori', async () => fixture(async ({ call, signed, session, forwardCount, advance }) => {
  assert.match(session.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Strict; Max-Age=1800/);
  assert.equal(session.headers['cache-control'], 'no-store');
  for (const path of ['/', '/api/archive?view=dashboard', '/api/lan/session']) assert.equal((await call(path, { headers: { authorization: '' } })).status, 401);
  const before = forwardCount();
  for (const change of [{ cookie: '' }, { 'x-spesesmart-csrf': '' }, { 'x-spesesmart-csrf': 'wrong' }, { origin: '' }, { origin: 'https://evil.invalid' }, { origin: origin.replace('https:', 'http:') }, { host: '192.168.250.116:3443' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    const result = await call('/api/archive', { method: 'POST', headers: { ...signed, ...change }, body: '{}' });
    assert.ok([403, 421].includes(result.status));
  }
  assert.equal(forwardCount(), before);
  assert.equal((await call('/api/lan/session', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await call('/api/archive', { method, headers: signed, body: '{}' })).status, 200);
  advance(30 * 60000 + 1);
  assert.equal((await call('/api/archive', { method: 'POST', headers: signed, body: '{}' })).status, 403);
  const fresh = await call('/api/lan/session', { headers: { cookie: signed.cookie } });
  assert.equal(fresh.status, 200); assert.notEqual(fresh.body.csrf, session.body.csrf);
}));

test('LAN operativa: brute force limitato, amministrazione e metodi alternativi non inoltrati', async () => fixture(async ({ call, signed, forwardCount, advance }) => {
  const before = forwardCount();
  for (const path of ['/api/archive', '/api/archive?view=backup', '/api/reset', '/api/import', '/api/backup', '/.env.local', '/__nextjs_original-stack-frames', '/_next/static/chunk.js.map']) assert.equal((await call(path, { headers: signed })).status, 403);
  for (const method of ['PUT', 'OPTIONS', 'POST']) assert.equal((await call('/', { method, headers: signed, body: '{}' })).status, 403);
  assert.equal((await call('/api/archive?view=dashboard', { method: 'DELETE', headers: signed, body: '{}' })).status, 403);
  assert.equal((await call('/api/archive', { method: 'POST', headers: { ...signed, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal(forwardCount(), before);
  for (let i = 0; i < 10; i++) assert.equal((await call('/', { headers: { authorization: 'Basic wrong' } })).status, 401);
  assert.equal((await call('/')).status, 429); advance(60001); assert.equal((await call('/')).status, 200);
}));

test('LAN operativa: backend senza capability bloccato, nessuna eccezione production/Vercel o fiducia in forwarded header', async () => fixture(async ({ port }) => {
  assert.equal(lanRuntimeValid(), true); assert.equal(googleSheetsWritesEnabled(), true);
  const valid = new Request(`http://localhost:${port}/api/archive`, { headers: { host: `127.0.0.1:${port}`, origin, 'sec-fetch-site': 'same-origin', 'x-spesesmart-lan-capability': capability } });
  assert.equal(lanGatewayRequest(valid), true); assert.equal(isSameOriginRequest(valid), true); assert.equal(aiAccess(valid, true), null);
  for (const headers of [{}, { 'x-forwarded-host': '192.168.250.115:3443', 'x-forwarded-proto': 'https' }, { 'x-spesesmart-lan-capability': 'b'.repeat(64) }]) {
    const req = new Request(`http://localhost:${port}/api/archive`, { headers: { host: `127.0.0.1:${port}`, origin, ...headers } });
    assert.equal(lanGatewayRequest(req), false); assert.equal(aiAccess(req, true).status, 403);
    for (const route of [GET, POST, PATCH, DELETE]) assert.equal((await route(req)).status, 403);
  }
  assert.equal((await GET(valid)).status, 403); // Full snapshot denied even behind the gateway.
  assert.equal(lanGatewayRequest(new Request('http://localhost:1234/api/archive', { headers: valid.headers })), false);
  for (const env of [{ NODE_ENV: 'production', SPESESMART_HOME_PRODUCTION: 'false' }, { VERCEL: '1' }, { SPESESMART_LAN_CAPABILITY: '' }, { SPESESMART_LAN_ORIGIN: 'http://192.168.250.115:3443' }, { SPESESMART_LAN_READ_ONLY: 'true' }]) {
    assert.equal(googleSheetsWritesEnabled({ ...process.env, ...env }), false);
  }
}));

test('LAN operativa: limiti di frequenza e dimensione prima del backend, senza retry', async () => fixture(async ({ call, signed, forwardCount, advance }) => {
  const ai = { method: 'POST', headers: { ...signed, 'content-type': 'multipart/form-data; boundary=fixture' }, body: 'fixture' };
  for (let i = 0; i < 6; i++) assert.equal((await call('/api/receipts/analyze', ai)).status, 200);
  const before = forwardCount(); assert.equal((await call('/api/receipts/analyze', ai)).status, 429); assert.equal(forwardCount(), before);
  advance(60001);
  assert.equal((await call('/api/receipts/analyze', ai)).status, 200);
  assert.equal((await call('/api/archive', { method: 'POST', headers: signed, body: 'x'.repeat(20 * 1024 * 1024 + 1) })).status, 413);
  assert.equal(forwardCount(), before + 1);
}));

function fakeSheets() {
  const data = Object.fromEntries(Object.entries(TABLE_HEADERS).map(([name, headers], id) => [name, { id, columns: 50, rows: [[...headers, ...(name === 'Categorie' ? [] : extraHeaders(1))]] }]));
  data.Categorie.rows.push(...categoryDefinitions.map(c => [c.name, 'Spese', 'Sì', c.description]));
  return { data, writes: 0, failAt: -1, async read() { return structuredClone(data); }, async guardDeletion() {}, async write(changes) {
    this.writes++; if (this.writes === this.failAt) throw Error('fixture interruption');
    for (const c of changes) for (let n = 0; n < c.values.length; n++) {
      data[c.sheet].rows[c.row + n] ??= [];
      c.values[n].forEach((value, i) => { data[c.sheet].rows[c.row + n][c.column + i] = value; });
      while (data[c.sheet].rows[c.row + n].at(-1) === '') data[c.sheet].rows[c.row + n].pop();
    }
  } };
}

test('LAN operativa + Sheets simulato: inserimento, modifica, duplicati, eliminazione parziale e recupero con stesso UUID dopo riavvio', async () => fixture(async ({ call, signed, dir, dispatch }) => {
  const transport = fakeSheets(), env = { NODE_ENV: 'test', SPESESMART_SHEETS_UPDATE_DIR: dir, GOOGLE_SHEETS_SPREADSHEET_ID: 'fixture' };
  const originalCategories = structuredClone(transport.data.Categorie);
  let repo = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, createUpdateStore(env));
  dispatch(async (web, body) => repo[({ POST: 'save', PATCH: 'update', DELETE: 'delete' })[web.method]](JSON.parse(body)));
  const send = (method, value) => call('/api/archive', { method, headers: signed, body: JSON.stringify(value) });
  const input = { kind: 'manual', operationId: randomUUID(), draft: { description: 'Fixture LAN', date: '2026-10-14', notes: '', items: [{ amount: '7.00', category: 'Alimentari' }] } };
  assert.equal((await send('POST', input)).status, 200); const writes = transport.writes;
  assert.equal((await send('POST', input)).status, 200); assert.equal(transport.writes, writes);
  const documentId = `manual-${input.operationId}`, editable = (await repo.load()).editablePurchases[documentId];
  const draft = structuredClone(editable.draft); draft.notes = 'Correzione LAN';
  const edit = { documentId, operationId: randomUUID(), expectedVersion: editable.version, draft };
  assert.equal((await send('PATCH', edit)).status, 200); assert.equal((await send('PATCH', edit)).body.duplicate, true);
  const deletion = { documentId, operationId: randomUUID(), expectedVersion: (await repo.load()).editablePurchases[documentId].version, confirmed: true };
  transport.failAt = transport.writes + 2;
  assert.equal((await send('DELETE', deletion)).status, 503);
  const pending = (await repo.load()).pendingDeletions;
  assert.equal(pending.length, 1); assert.equal(pending[0].request.operationId, deletion.operationId);
  repo = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, createUpdateStore(env)); // Fresh repository/store, same durable fixture journal.
  assert.equal((await send('DELETE', deletion)).body.deleted, true);
  assert.equal((await repo.load()).archive.expenses.length, 0); assert.equal((await repo.load()).pendingDeletions.length, 0);
  const completed = transport.writes; assert.equal((await send('DELETE', deletion)).body.duplicate, true); assert.equal(transport.writes, completed);
  assert.deepEqual(transport.data.Categorie, originalCategories);
}));

test('LAN operativa: invii simultanei e disconnessione non ripetono la richiesta inoltrata', async () => fixture(async ({ call, signed, dispatch, forwardCount }) => {
  let release, started; const running = new Promise(resolve => { started = resolve; });
  dispatch(async () => { started(); await new Promise(resolve => { release = resolve; }); return { verified: true }; });
  const first = call('/api/archive', { method: 'POST', headers: signed, body: '{}' }); await running;
  const before = forwardCount(); assert.equal((await call('/api/archive', { method: 'POST', headers: signed, body: '{}' })).status, 409);
  release(); assert.equal((await first).status, 200); assert.equal(forwardCount(), before);
  let dropped, done; const completed = new Promise(resolve => { done = resolve; });
  dispatch(async () => { await dropped; done(); return { verified: true }; });
  let finish; dropped = new Promise(resolve => { finish = resolve; });
  let socket;
  const disconnected = call('/api/archive', { method: 'POST', headers: signed, body: '{}', onForwarded: req => { socket = req; } }).catch(() => null);
  while (forwardCount() === before) await new Promise(resolve => setTimeout(resolve, 5));
  socket.destroy(); await disconnected; finish(); await completed;
  assert.equal(forwardCount(), before + 1); // Server completes once, no proxy retry.
}));

test('LAN: arresto rifiuta nuovi invii e attende la scrittura già inoltrata', async () => fixture(async ({ call, signed, dispatch, gateway, forwardCount }) => {
  let complete, entered; const started = new Promise(resolve => { entered = resolve; });
  dispatch(async () => { entered(); await new Promise(resolve => { complete = resolve; }); return { verified: true }; });
  const first = call('/api/archive', { method: 'POST', headers: signed, body: '{}' });
  await started;
  gateway.beginDrain();
  assert.equal(await gateway.waitForDrain(10), false);
  const before = forwardCount();
  assert.equal((await call('/api/archive', { method: 'POST', headers: signed, body: '{}' })).status, 503);
  assert.equal(forwardCount(), before);
  complete(); assert.equal((await first).status, 200);
  assert.equal(await gateway.waitForDrain(1000), true);
}));

test('LAN operativa + OpenAI simulato: cache dopo interruzione, consumo sconosciuto e limiti persistenti', async () => fixture(async ({ call, signed, dir, dispatch }) => {
  const config = aiConfiguration({ SPESESMART_AI_DATA_DIR: dir, SPESESMART_AI_MAX_ANALYSES: '1' }); await initializeAI(config);
  let calls = 0;
  dispatch(async (_web, image) => controlledAnalysis(image, false, async () => { calls++; return { receipt: structuredClone(demoReceipt), usage: { input: 100, cached: 0, output: 100 }, model: 'gpt-4.1-mini', completed: true }; }, config));
  const send = image => call('/api/receipts/analyze', { method: 'POST', headers: { ...signed, 'content-type': 'multipart/form-data; boundary=fixture' }, body: image });
  assert.equal((await send('same-image-fixture')).status, 200);
  assert.equal((await send('same-image-fixture')).body.reusedFromCache, true);
  assert.equal((await send('different-image')).status, 429); assert.equal(calls, 1);
  assert.equal((await getAIUsage(config)).analyses, 1);
  const otherDir = join(dir, 'unknown'), unknown = aiConfiguration({ SPESESMART_AI_DATA_DIR: otherDir }); await initializeAI(unknown);
  dispatch(async (_web, image) => controlledAnalysis(image, false, async () => { calls++; throw Error('Simulated lost provider response'); }, unknown));
  await send('unknown-image'); const before = calls;
  assert.equal((await send('unknown-image')).body.code, 'AI_UNKNOWN'); assert.equal(calls, before);
  assert.equal((await getAIUsage(unknown)).unknown, 1);
}));
