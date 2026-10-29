import './helpers/isolated-host-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { sheets_v4 } from '@googleapis/sheets';
import * as routes from '../src/app/api/archive/route.ts';
import * as preferencesRoutes from '../src/app/api/preferences/route.ts';
import * as categoryRoutes from '../src/app/api/categories/route.ts';
import * as usageRoutes from '../src/app/api/ai/usage/route.ts';
import * as analysisRoutes from '../src/app/api/receipts/analyze/route.ts';
import { initializePreferences } from '../src/lib/user-preferences.ts';
import { initializeAI, aiConfiguration } from '../src/lib/ai-usage.ts';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSheetsRepository } from '../src/lib/sheets-repository.ts';
import { createUpdateStore } from '../src/lib/sheets-update-store.ts';
import { TABLE_HEADERS, extraHeaders, rowOwner, canonical, readSnapshot } from '../src/lib/sheets-persistence-model.ts';
import { categoryDefinitions } from '../src/lib/categories.ts';
import { dashboardSummary } from '../src/lib/dashboard.ts';
import { buildPurchases, filterPurchases, emptyPurchaseFilters } from '../src/lib/purchases.ts';
import { prepareConfirmation, createDraft } from '../src/lib/receipts/model.ts';
import { demoReceipt } from '../src/lib/receipts/demo.ts';
import { initializeAccounts, administerAccount, readAccounts } from '../scripts/accounts.mjs';
import { createLANGateway } from '../scripts/lan-gateway.mjs';

const A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'admin' };
const B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'user' };
const manual = (description, amount = '10.00') => ({ kind: 'manual', operationId: randomUUID(), draft: { description, date: '2026-10-12', notes: description, items: [{ category: 'Alimentari', amount }] } });
const denied = { code: 'NOT_FOUND', message: 'Acquisto o tentativo non disponibile.' };

async function fixture(work) {
  globalThis.spesesmartSheetsUncertain = false;
  const directory = await mkdtemp(join(tmpdir(), 'spesesmart-financial-users-'));
  const env = { NODE_ENV: 'test', SPESESMART_SHEETS_UPDATE_DIR: directory, GOOGLE_SHEETS_SPREADSHEET_ID: 'synthetic-shared-sheet' };
  const data = Object.fromEntries(Object.entries(TABLE_HEADERS).map(([name, headers], id) => [name, { id, columns: 60, rowCapacity: 1000, rows: [[...headers, ...(name === 'Categorie' ? [] : extraHeaders(1))]] }]));
  data.Categorie.rows.push(...categoryDefinitions.map(c => [c.name, 'Spese', 'Sì', c.description]));
  let writes = 0;
  const transport = { async read() { return structuredClone(data); }, async guardDeletion() {}, async write(changes) {
    writes++;
    for (const change of changes) {
      assert.notEqual(change.sheet, 'Categorie');
      for (const [offset, row] of change.values.entries()) {
        data[change.sheet].rows[change.row + offset] ??= [];
        row.forEach((cell, column) => { data[change.sheet].rows[change.row + offset][change.column + column] = cell; });
      }
    }
  } };
  const store = createUpdateStore(env), a = createSheetsRepository(A, transport, true, store), b = createSheetsRepository(B, transport, true, store);
  const inputA = manual('PRIVATE_A'), inputB = manual('PRIVATE_B', '99.00');
  await a.save(inputA); await b.save(inputB);
  const idA = 'manual-' + inputA.operationId, idB = 'manual-' + inputB.operationId;
  const edit = async (repo, id) => { const purchase = (await repo.load()).editablePurchases[id]; return { documentId: id, operationId: randomUUID(), expectedVersion: purchase.version, draft: structuredClone(purchase.draft) }; };
  const deletion = async (repo, id) => ({ documentId: id, operationId: randomUUID(), expectedVersion: (await repo.load()).editablePurchases[id].version, confirmed: true });
  try { await work({ a, b, data, store, env, transport, idA, idB, inputA, inputB, edit, deletion, writes: () => writes }); }
  finally { globalThis.spesesmartSheetsUncertain = false; await rm(directory, { recursive: true, force: true }); }
}

test('isolamento: contesto obbligatorio, schema e letture/ricerca/dashboard personali anche per admin', async () => fixture(async ({ a, b, data }) => {
  assert.throws(() => createSheetsRepository(undefined, {}), { code: 'AUTH_REQUIRED' });
  assert.throws(() => createSheetsRepository({ id: 'client' }, {}), { code: 'AUTH_REQUIRED' });
  assert.equal(TABLE_HEADERS.Movimenti.at(-1), 'UtenteID');
  assert.equal(TABLE_HEADERS.Prodotti.at(-1), 'UtenteID');
  assert.equal(TABLE_HEADERS.Documenti.at(-1), 'UtenteID');
  assert.equal(TABLE_HEADERS.Categorie.length, 4);
  for (const [repo, own, other, total] of [[a, 'PRIVATE_A', 'PRIVATE_B', 1000], [b, 'PRIVATE_B', 'PRIVATE_A', 9900]]) {
    const loaded = await repo.load(), text = JSON.stringify(loaded);
    assert.ok(text.includes(own)); assert.ok(!text.includes(other));
    assert.equal(loaded.archive.googleSheetsSnapshot, undefined);
    assert.equal(loaded.persistedIds.length, 1); assert.equal(loaded.persistedDocumentIds.length, 1);
    assert.equal(filterPurchases(buildPurchases(loaded.archive), { ...emptyPurchaseFilters, query: other }).length, 0);
    assert.equal(dashboardSummary(loaded.archive, '2026-10', null, '2026-10-20').totalCents, total);
  }
  const before = JSON.stringify(data.Categorie);
  await a.save(manual('A_SECOND'));
  assert.equal(JSON.stringify(data.Categorie), before);
}));

test('isolamento: proprietari client rifiutati anche annidati, ID/UUID altrui indistinguibili da assenti', async () => fixture(async ({ a, b, idA, idB, inputA, inputB, edit, deletion, writes }) => {
  const ownEdit = await edit(a, idA), foreignEdit = await edit(b, idB), ownDelete = await deletion(a, idA), foreignDelete = await deletion(b, idB);
  const before = writes();
  for (const key of ['UtenteID', 'userId', 'ownerId', 'owner']) {
    await assert.rejects(a.save({ ...manual('forged'), [key]: B.id }), { code: 'INVALID' });
    await assert.rejects(a.update({ ...ownEdit, draft: { ...ownEdit.draft, [key]: B.id } }), { code: 'INVALID' });
    await assert.rejects(a.delete({ ...ownDelete, [key]: B.id }), { code: 'INVALID' });
  }
  await assert.rejects(a.update(foreignEdit), denied);
  await assert.rejects(a.update({ ...foreignEdit, documentId: 'missing' }), denied);
  await assert.rejects(a.delete(foreignDelete), denied);
  await assert.rejects(a.delete({ ...foreignDelete, documentId: 'missing' }), denied);
  await assert.rejects(a.save(inputB), denied);
  await assert.rejects(b.save(inputA), denied);
  await assert.rejects(a.update({ ...ownEdit, operationId: inputB.operationId }), denied);
  assert.equal(writes(), before);
}));

test('isolamento: modifica/eliminazione con coordinate globali preservano B e restituiscono soltanto A', async () => fixture(async ({ a, b, data, idA, idB, edit, deletion }) => {
  const foreignRows = () => Object.fromEntries(['Movimenti', 'Prodotti', 'Documenti'].map(name => [name, data[name].rows.filter(row => rowOwner(name, row) === B.id)]));
  const before = canonical(foreignRows());
  const request = await edit(a, idA); request.draft.merchant = 'PRIVATE_A_EDIT';
  const updated = await a.update(request);
  assert.ok(!JSON.stringify(updated).includes('PRIVATE_B')); assert.equal(canonical(foreignRows()), before);
  assert.equal((await b.load()).persistedDocumentIds[0], idB);
  const removed = await a.delete(await deletion(a, idA));
  assert.equal(removed.archive.expenses.length, 0); assert.ok(!JSON.stringify(removed).includes('PRIVATE_B'));
  assert.equal(canonical(foreignRows()), before);
  assert.equal((await b.load()).archive.expenses.length, 1);
}));

test('isolamento: journal condiviso, pendenti privati, ripresa dopo riavvio e UUID non riutilizzabili da B', async () => fixture(async ({ a, b, idA, idB, edit, deletion, transport, data, env, store, writes }) => {
  const request = await edit(a, idA); request.draft.merchant = 'PRIVATE_A_RECOVERY';
  const write = transport.write; let calls = 0;
  transport.write = async (...args) => { if (++calls === 1) return write(...args); throw Error('synthetic interruption'); };
  await assert.rejects(a.update(request), { code: 'UPDATE_PENDING' });
  const journal = (await store.list())[0];
  assert.equal(journal.version, 2); assert.equal(journal.userId, A.id);
  assert.equal(rowOwner('Documenti', data.Documenti.rows[journal.marker.row]), A.id);
  const loadedB = await b.load();
  assert.equal(loadedB.pendingEdits.length, 0); assert.equal(loadedB.pendingDeletions.length, 0);
  assert.ok(!JSON.stringify(loadedB).includes('PRIVATE_A')); assert.ok(!JSON.stringify(loadedB).includes(request.operationId));
  const before = writes();
  await assert.rejects(b.update(request), denied);
  await assert.rejects(b.delete({ ...(await deletion(b, idB)), operationId: request.operationId }), denied);
  await assert.rejects(b.save({ ...manual('UUID_REUSE'), operationId: request.operationId }));
  assert.equal(writes(), before);
  transport.write = write;
  const restarted = createSheetsRepository(A, transport, true, createUpdateStore(env));
  assert.equal((await restarted.update(request)).updated, true);
  await assert.rejects(b.update(request), denied);
  assert.equal((await store.list())[0].state, 'complete');
}));

test('isolamento: deduplicazione per proprietario, prodotti e collegamenti incrociati rifiutati', async () => fixture(async ({ a, b, data, idB }) => {
  const receipt = () => {
    const analysis = structuredClone(demoReceipt); analysis.merchant = 'SYNTHETIC_RECEIPT';
    return prepareConfirmation(createDraft(analysis, randomUUID), analysis, '', false, randomUUID, 'c'.repeat(64));
  };
  const rA = receipt(), rB = receipt();
  await a.save({ kind: 'receipt', operationId: rA.Documenti[0].id, receipt: rA });
  await b.save({ kind: 'receipt', operationId: rB.Documenti[0].id, receipt: rB });
  const loadedA = await a.load();
  assert.equal(loadedA.archive.receipts.length, 1);
  assert.deepEqual(loadedA.archive.receipts[0].Prodotti.map(p => p.id), rA.Prodotti.map(p => p.id));
  assert.ok(!JSON.stringify(loadedA).includes(rB.Documenti[0].id));
  const ownerColumn = TABLE_HEADERS.Prodotti.length - 1;
  const product = data.Prodotti.rows.find(row => rowOwner('Prodotti', row) === A.id);
  product[ownerColumn] = B.id;
  await assert.rejects(a.load(), denied); await assert.rejects(b.load(), denied);
  product[ownerColumn] = A.id;
  product[1] = idB;
  await assert.rejects(a.load(), denied); await assert.rejects(b.load(), denied);
}));

test('isolamento: eliminazione pendente, revoca della proprietà nel journal e lock condiviso', async () => fixture(async ({ a, b, idA, idB, transport, env, store, deletion, edit, writes }) => {
  const request = await deletion(a, idA), write = transport.write;
  let calls = 0;
  transport.write = async (...args) => { if (++calls === 1) return write(...args); throw Error('synthetic deletion interruption'); };
  await assert.rejects(a.delete(request), { code: 'UPDATE_PENDING' });
  const journal = (await store.list())[0];
  assert.equal(journal.userId, A.id);
  await assert.rejects(store.put({ ...journal, userId: B.id }), { code: 'UPDATE_STORAGE' });
  assert.equal((await b.load()).pendingDeletions.length, 0);
  assert.ok(!JSON.stringify(await b.load()).includes('PRIVATE_A'));
  const before = writes();
  await assert.rejects(b.delete(request), denied);
  await assert.rejects(b.update({ ...(await edit(b, idB)), operationId: request.operationId }), denied);
  await assert.rejects(b.save(manual('BLOCKED_BY_GLOBAL_PENDING')), { code: 'UPDATE_PENDING', message: 'Operazioni temporaneamente non disponibili.' });
  assert.equal(writes(), before);
  transport.write = write;
  assert.equal((await createSheetsRepository(A, transport, true, createUpdateStore(env)).delete(request)).deleted, true);
  await assert.rejects(b.delete(request), denied);
  assert.equal((await b.load()).archive.expenses.length, 1);
}));

test('isolamento: righe senza proprietario escluse e corruzione privata di B non analizzata da A', async () => fixture(async ({ a, b, data }) => {
  const row = data.Documenti.rows.find(r => rowOwner('Documenti', r) === B.id);
  row[TABLE_HEADERS.Documenti.length + 2] = 'PRIVATE_B_CORRUPT_JSON';
  assert.equal((await a.load()).archive.expenses.length, 1);
  await assert.rejects(b.load());
  data.Movimenti.rows.push(['unowned', '', '2026-10-12', 'Uscita', 'UNOWNED_PRIVATE', '', 'Alimentari', -5, 'Manuale', 'Confermato']);
  assert.ok(!JSON.stringify(await a.load()).includes('UNOWNED_PRIVATE'));
  assert.equal(readSnapshot(data, A.id).archive.expenses.length, 1);
}));

test('API HTTPS: CRUD autenticato, risposte A/B e attacchi diretti senza trasporto reale', async () => {
  await fixture(async ({ transport, idA, idB, a, b, edit, deletion, writes, env }) => {
    env.SPESESMART_PREFERENCES_DIR = join(env.SPESESMART_SHEETS_UPDATE_DIR, 'preferences');
    await initializePreferences(env);
    const aiDir = join(env.SPESESMART_SHEETS_UPDATE_DIR, 'ai'); await initializeAI(aiConfiguration({ SPESESMART_AI_DATA_DIR: aiDir }));
    let paidCalls = 0;
    test.mock.method(globalThis, 'fetch', async input => {
      const url = String(input instanceof Request ? input.url : input);
      assert.equal(url, 'https://api.openai.com/v1/responses', 'Unexpected external transport in fixture'); paidCalls++;
      return Response.json({ id: 'resp_synthetic', object: 'response', created_at: 0, status: 'completed', model: 'gpt-4.1-mini',
        output: [{ type: 'message', id: 'msg_synthetic', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(demoReceipt), annotations: [] }] }],
        error: null, incomplete_details: null, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
    });
    const registryDir = join(env.SPESESMART_SHEETS_UPDATE_DIR, 'accounts');
    await initializeAccounts(registryDir);
    const password = 'synthetic API password';
    await administerAccount(registryDir, 'create', 'a', { password, role: 'admin' });
    await administerAccount(registryDir, 'create', 'b', { password });
    const registry = await readAccounts(registryDir); registry.accounts[0].id = A.id; registry.accounts[1].id = B.id;
    await writeFile(join(registryDir, 'accounts.json'), JSON.stringify(registry), { mode: 0o600 });
    // The real API, transport and durable store run against synthetic SDK and
    // filesystem boundaries. This mapping exists only in the test process.
    const logical = '/synthetic-financial-api', actual = env.SPESESMART_SHEETS_UPDATE_DIR;
    const translate = value => typeof value === 'string' && value.startsWith(logical) ? actual + value.slice(logical.length) : value;
    for (const name of ['lstat', 'mkdir', 'open', 'readFile', 'readdir', 'rename', 'realpath']) {
      const original = fsPromises[name];
      test.mock.method(fsPromises, name, async (...args) => {
        const result = await original(...args.map(translate));
        return name === 'realpath' && typeof args[0] === 'string' && args[0].startsWith(logical) ? logical + result.slice(actual.length) : result;
      });
    }
    const spawn = childProcess.spawn;
    test.mock.method(childProcess, 'spawn', (command, args, ...rest) => spawn(command, args.map(translate), ...rest));
    syncBuiltinESMExports();
    const snapshot = await transport.read();
    const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID;
    test.mock.method(sheets_v4.Resource$Spreadsheets.prototype, 'get', async () => ({ data: { spreadsheetId, sheets: Object.entries(snapshot).map(([title, table]) => ({ properties: { sheetId: table.id, title, gridProperties: { columnCount: table.columns, rowCount: table.rowCapacity } } })) } }));
    test.mock.method(sheets_v4.Resource$Spreadsheets$Values.prototype, 'batchGet', async () => ({ data: { valueRanges: Object.values(await transport.read()).map(table => ({ values: table.rows })) } }));
    test.mock.method(sheets_v4.Resource$Spreadsheets.prototype, 'batchUpdate', async ({ requestBody }) => {
      const current = await transport.read();
      const changes = requestBody.requests.filter(request => request.updateCells).map(({ updateCells: update }) => ({
        sheet: Object.entries(current).find(([, table]) => table.id === update.start.sheetId)[0], row: update.start.rowIndex, column: update.start.columnIndex,
        values: update.rows.map(row => row.values.map(({ userEnteredValue: value }) => value.numberValue ?? value.boolValue ?? value.stringValue))
      }));
      await transport.write(changes); return { data: {} };
    });
    const vars = { NODE_ENV: 'development', SPESESMART_MULTIUSER: 'true', SPESESMART_ACCOUNT_DIR: registryDir, SPESESMART_LAN_OPERATIONAL: 'true', SPESESMART_HOME_PRODUCTION: 'false', SPESESMART_LAN_READ_ONLY: 'false', SPESESMART_LAN_ORIGIN: 'https://192.168.250.115:3443', SPESESMART_LAN_CAPABILITY: 'd'.repeat(64), SPESESMART_SHEETS_WRITES_ENABLED: 'true', SPESESMART_SHEETS_UPDATE_DIR: logical, GOOGLE_SHEETS_SPREADSHEET_ID: spreadsheetId, GOOGLE_SERVICE_ACCOUNT_JSON: '', GOOGLE_APPLICATION_CREDENTIALS: '/synthetic-no-credentials', SPESESMART_PREFERENCES_DIR: env.SPESESMART_PREFERENCES_DIR, SPESESMART_AI_DATA_DIR: aiDir, OPENAI_API_KEY: 'synthetic-not-a-real-key' };
    const names = [...Object.keys(vars), 'SPESESMART_LAN_INTERNAL_PORT', 'VERCEL'];
    const previous = names.map(key => process.env[key]);
    let backend, gateway;
    try {
      Object.assign(process.env, vars); delete process.env.VERCEL;
      backend = createServer(async (req, res) => {
        try {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          const dispatch = ({ '/api/archive': routes, '/api/preferences': preferencesRoutes, '/api/categories': categoryRoutes, '/api/ai/usage': usageRoutes, '/api/receipts/analyze': analysisRoutes })[new URL(req.url, 'http://fixture').pathname];
          const result = await dispatch[req.method](new Request(`http://127.0.0.1:${backend.address().port}${req.url}`, { method: req.method, headers: req.headers, ...(req.method === 'GET' ? {} : { body }) }));
          res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text());
        } catch { res.writeHead(500); res.end('{}'); }
      });
      backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
      process.env.SPESESMART_LAN_INTERNAL_PORT = String(backend.address().port);
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1', '-subj', '/CN=fixture', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(registryDir, 'key.pem'), '-out', join(registryDir, 'cert.pem')], { stdio: 'ignore' });
      const key = await readFile(join(registryDir, 'key.pem')), cert = await readFile(join(registryDir, 'cert.pem'));
      gateway = createLANGateway({ ip: '192.168.250.115', port: 3443, upstreamPort: backend.address().port, operational: true, capability: vars.SPESESMART_LAN_CAPABILITY, key, cert, accountsDirectory: registryDir });
      gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
      const call = async (path, method = 'GET', headers = {}, input) => {
        let body = input === undefined ? undefined : JSON.stringify(input), contentType = 'application/json';
        if (input instanceof FormData) { const encoded = new Request('http://fixture', { method: 'POST', body: input }); body = Buffer.from(await encoded.arrayBuffer()); contentType = encoded.headers.get('content-type'); }
        return new Promise((resolve, reject) => {
        const req = httpsRequest({ hostname: '127.0.0.1', port: gateway.address().port, ca: cert, path, method,
          headers: { host: '192.168.250.115:3443', origin: vars.SPESESMART_LAN_ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': contentType, ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }), ...headers } }, res => {
          let text = ''; res.on('data', part => text += part); res.on('end', () => {
            try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }); }
            catch { reject(Error(`Risposta fixture non JSON: ${method} ${path}, status ${res.statusCode}`)); }
          });
        }); req.on('error', reject); req.end(body);
      }); };
      const login = async username => { const result = await call('/api/auth/login', 'POST', {}, { username, password }); assert.equal(result.status, 200); return { cookie: result.headers['set-cookie'][0].split(';')[0], 'x-spesesmart-csrf': result.body.csrf }; };
      const signedA = await login('a'), signedB = await login('b');
      for (const [signed, own, other] of [[signedA, idA, idB], [signedB, idB, idA]]) {
        const loaded = await call('/api/archive?view=dashboard', 'GET', { ...signed, 'x-spesesmart-user-id': signed === signedA ? B.id : A.id });
        assert.equal(loaded.status, 200); assert.ok(JSON.stringify(loaded.body).includes(own)); assert.ok(!JSON.stringify(loaded.body).includes(other));
        assert.equal(loaded.body.archive.googleSheetsSnapshot, undefined);
      }
      const before = writes();
      const foreign = await edit(b, idB);
      for (const id of [idB, 'missing']) {
        const patched = await call('/api/archive', 'PATCH', signedA, { ...foreign, documentId: id });
        const removed = await call('/api/archive', 'DELETE', signedA, { ...(await deletion(b, idB)), documentId: id });
        assert.equal(patched.status, 404); assert.equal(removed.status, 404); assert.deepEqual(patched.body, removed.body);
      }
      assert.equal((await call('/api/archive', 'POST', signedA, { ...manual('forged'), UtenteID: B.id })).status, 422);
      assert.equal((await call('/api/archive', 'POST', { ...signedA, 'x-spesesmart-csrf': 'wrong' }, manual('blocked'))).status, 403);
      assert.equal(writes(), before);
      const added = await call('/api/archive', 'POST', signedA, manual('PRIVATE_A_API'));
      assert.equal(added.status, 200); assert.ok(!JSON.stringify(added.body).includes('PRIVATE_B'));
      const request = await edit(a, idA); request.draft.notes = 'PRIVATE_A_API_EDIT';
      const updated = await call('/api/archive', 'PATCH', signedA, request);
      assert.equal(updated.status, 200); assert.ok(!JSON.stringify(updated.body).includes('PRIVATE_B'));
      const removed = await call('/api/archive', 'DELETE', signedA, await deletion(a, idA));
      assert.equal(removed.status, 200); assert.ok(!JSON.stringify(removed.body).includes('PRIVATE_B'));
      for (const path of ['/api/budget', '/api/archive?UtenteID=' + B.id]) assert.equal((await call(path, 'GET', signedA)).status, 403);
      const defaultA = await call('/api/preferences?month=2026-10', 'GET', signedA);
      assert.equal(defaultA.body.budgetCents, 200000);
      assert.equal((await call('/api/preferences', 'PATCH', signedA, { month: '2026-10', budgetCents: 12345, expectedVersion: 0 })).status, 200);
      assert.equal((await call('/api/preferences', 'PATCH', signedA, { month: '2026-10', budgetCents: 1, expectedVersion: 0 })).status, 409);
      assert.equal((await call('/api/preferences?month=2026-10', 'GET', signedB)).body.budgetCents, 200000);
      assert.equal((await call('/api/categories', 'POST', signedB, { name: 'Forbidden', description: 'fixture', expectedVersion: 0 })).status, 403);
      for (const signed of [signedA, signedB]) {
        const form = new FormData(); form.set('image', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF2QAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'synthetic.png');
        const analyzed = await call('/api/receipts/analyze', 'POST', signed, form); assert.equal(analyzed.status, 200, JSON.stringify(analyzed.body)); assert.equal(analyzed.body.reusedFromCache, false);
        assert.equal((await call('/api/ai/usage', 'GET', signed)).body.analyses, 1);
      }
      assert.equal(paidCalls, 2);
      assert.equal((await call('/api/archive?view=dashboard', 'GET', { ...signedB, 'x-spesesmart-csrf': signedA['x-spesesmart-csrf'] })).status, 401);
      assert.equal((await call('/api/auth/logout', 'POST', signedA)).status, 200);
      assert.equal((await call('/api/archive?view=dashboard', 'GET', signedA)).status, 401);
      const nextB = await login('b');
      assert.equal((await call('/api/preferences?month=2026-10', 'GET', nextB)).body.budgetCents, 200000);
      assert.equal((await call('/api/archive?view=dashboard')).status, 401);
      const direct = new Request(`http://127.0.0.1:${backend.address().port}/api/archive?view=dashboard`, { headers: { host: `127.0.0.1:${backend.address().port}`, 'x-spesesmart-user-id': A.id } });
      assert.equal((await routes.GET(direct)).status, 401);
      await administerAccount(registryDir, 'disable', 'a');
      assert.equal((await call('/api/archive?view=dashboard', 'GET', signedA)).status, 401);
    } finally {
      gateway?.closeAllConnections(); backend?.closeAllConnections();
      await Promise.all([gateway && new Promise(resolve => gateway.close(resolve)), backend && new Promise(resolve => backend.close(resolve))]);
      names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
      test.mock.restoreAll(); syncBuiltinESMExports();
    }
  });
});
