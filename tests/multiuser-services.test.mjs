import './helpers/isolated-host-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializePreferences, personalBudget, updatePersonalBudget, loadCatalog, addCategory, readPreferences } from '../src/lib/user-preferences.ts';
import { initializeAI, aiConfiguration, controlledAnalysis, getAIUsage } from '../src/lib/ai-usage.ts';
import { applyCategoryExtensions, categoryIds, categoryDefinitions } from '../src/lib/categories.ts';
import { createSheetsRepository } from '../src/lib/sheets-repository.ts';
import { createUpdateStore } from '../src/lib/sheets-update-store.ts';
import { TABLE_HEADERS, extraHeaders } from '../src/lib/sheets-persistence-model.ts';
import { createDraft, prepareConfirmation, effectiveReceiptInstructions } from '../src/lib/receipts/model.ts';
import { randomUUID } from 'node:crypto';
import { demoReceipt } from '../src/lib/receipts/demo.ts';
import { bindSession, clearSession, sessionFetch } from '../src/lib/session-fetch.ts';
const A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'admin' }, B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'user' };
async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), 'spesesmart-multi-services-'));
  const env = { NODE_ENV: 'test', SPESESMART_SHEETS_UPDATE_DIR: join(directory, 'journal'), GOOGLE_SHEETS_SPREADSHEET_ID: 'synthetic', SPESESMART_PREFERENCES_DIR: join(directory, 'preferences') };
  try { await initializePreferences(env); await loadCatalog(env); await work({ directory, env }); }
  finally { applyCategoryExtensions([], 0, 'reset-' + directory); await rm(directory, { recursive: true, force: true }); }
}
test('preferenze: A/B separati, default e zero, versioni tra smartphone e dati client rifiutati', async () => fixture(async ({ env }) => {
  const first = await personalBudget(A, '2026-10', env); assert.equal(first.budgetCents, 200000); assert.equal(first.configured, false);
  const saved = await updatePersonalBudget(A, { month: '2026-10', budgetCents: 0, expectedVersion: 0 }, env);
  assert.equal(saved.budgetCents, 0); assert.equal(saved.configured, true);
  assert.deepEqual(await personalBudget(A, '2026-10', env), saved);
  assert.equal((await personalBudget(B, '2026-10', env)).budgetCents, 200000);
  await assert.rejects(updatePersonalBudget(A, { month: '2026-10', budgetCents: 999, expectedVersion: 0 }, env), { code: 'PREFERENCE_CONFLICT' });
  for (const budgetCents of [-1, 1.5, 100000000, '100']) await assert.rejects(updatePersonalBudget(B, { month: '2026-10', budgetCents, expectedVersion: 0 }, env), { code: 'INVALID' });
  await assert.rejects(updatePersonalBudget(A, { month: '2026-10', budgetCents: 1, expectedVersion: 1, userId: B.id }, env), { code: 'INVALID' });
  assert.equal((await personalBudget(B, '2026-10', env)).version, 0);
}));
test('categorie: solo admin aggiunge estensioni, ID stabili e catalogo condiviso senza mutare le 13 ufficiali', async () => fixture(async ({ env }) => {
  assert.equal(categoryIds['Utenze e Abbonamenti digitali'], 'digital-subscriptions');
  assert.equal(categoryIds['Manutenzioni Ristrutturazioni'], 'maintenance-renovations');
  const before = categoryIds.Alimentari;
  await assert.rejects(addCategory(B, { name: 'Extra sintetica', description: 'Fixture', expectedVersion: 0 }, env), { code: 'FORBIDDEN' });
  const added = await addCategory(A, { name: 'Extra sintetica', description: 'Solo fixture', expectedVersion: 0 }, env);
  assert.equal(categoryDefinitions.find(c => c.name === 'Extra sintetica').order, 15);
  await assert.rejects(addCategory(A, { name: 'Abbonamenti digitali', description: 'Alias riservato', expectedVersion: 1 }, env));
  assert.equal(added.extensions.length, 1); assert.match(added.extensions[0].id, /^custom-/);
  assert.equal(categoryIds.Alimentari, before); assert.equal(categoryIds['Extra sintetica'], added.extensions[0].id);
  await assert.rejects(addCategory(A, { name: 'Alimentari', description: 'Forbidden duplicate', expectedVersion: 1 }, env));
  await assert.rejects(addCategory(A, { name: 'Another', description: 'Fixture', expectedVersion: 0 }, env), { code: 'PREFERENCE_CONFLICT' });
  assert.deepEqual(await loadCatalog(env), added);
  const data = Object.fromEntries(Object.entries(TABLE_HEADERS).map(([name, headers], id) => [name, { id, columns: 60, rows: [[...headers, ...(name === 'Categorie' ? [] : extraHeaders(1))]] }]));
  data.Categorie.rows.push(...categoryDefinitions.filter(c => !c.id.startsWith('custom-')).map(c => [c.name, 'Spese', 'Sì', c.description]));
  const originalCategories = JSON.stringify(data.Categorie);
  const transport = { async read() { return structuredClone(data); }, async guardDeletion() {}, async write(changes) { for (const c of changes) for (const [n, row] of c.values.entries()) { data[c.sheet].rows[c.row + n] ??= []; row.forEach((v, i) => { data[c.sheet].rows[c.row + n][c.column + i] = v; }); } } };
  const a = createSheetsRepository(A, transport, true, createUpdateStore(env)), b = createSheetsRepository(B, transport, true, createUpdateStore(env));
  const operationId = randomUUID();
  await a.save({ kind: 'manual', operationId, draft: { description: 'Manuale estesa', date: '2026-10-20', notes: '', items: [{ category: 'Extra sintetica', amount: '1.00' }] } });
  const editable = (await a.load()).editablePurchases['manual-' + operationId];
  await a.update({ documentId: editable.documentId, operationId: randomUUID(), expectedVersion: editable.version, draft: editable.draft });
  const analysis = structuredClone(demoReceipt); analysis.items.forEach(item => { item.category = 'Extra sintetica'; });
  assert.ok(effectiveReceiptInstructions().includes('Extra sintetica: Solo fixture'));
  const receipt = prepareConfirmation(createDraft(analysis, randomUUID), analysis, '', false, randomUUID);
  await b.save({ kind: 'receipt', operationId: receipt.Documenti[0].id, receipt });
  const purchase = (await b.load()).editablePurchases[receipt.Documenti[0].id];
  await b.update({ documentId: purchase.documentId, operationId: randomUUID(), expectedVersion: purchase.version, draft: purchase.draft });
  assert.equal((await b.load()).archive.receipts[0].Prodotti[0].category, 'Extra sintetica');
  assert.equal(JSON.stringify(data.Categorie), originalCategories);
}));
test('preferenze: mancanza, corruzione e permessi invalidi non ricreano file o budget', async () => fixture(async ({ env }) => {
  const path = join(env.SPESESMART_PREFERENCES_DIR, 'preferences.json');
  await assert.rejects(initializePreferences(env));
  await chmod(path, 0o644); await assert.rejects(readPreferences(env), { code: 'PREFERENCES' }); await chmod(path, 0o600);
  await writeFile(path, '{}'); await assert.rejects(personalBudget(A, '2026-10', env), { code: 'PREFERENCES' });
  await rm(path); await assert.rejects(personalBudget(A, '2026-10', env), { code: 'PREFERENCES' });
}));
test('AI multiutente: ledger globale, cache private, consumi personali e limite condiviso invariato', async () => fixture(async ({ directory }) => {
  const config = aiConfiguration({ SPESESMART_AI_DATA_DIR: join(directory, 'ai'), SPESESMART_AI_MONTHLY_USD: '50', SPESESMART_AI_MAX_ANALYSES: '2' });
  await initializeAI(config); let calls = 0;
  const provider = async () => { calls++; return { receipt: structuredClone(demoReceipt), usage: { input: 10, cached: 0, output: 10 }, model: 'gpt-4.1-mini', completed: true }; };
  const image = Buffer.from('synthetic shared image');
  assert.equal((await controlledAnalysis(image, false, provider, config, undefined, A.id)).reusedFromCache, false);
  assert.equal((await controlledAnalysis(image, false, provider, config, undefined, B.id)).reusedFromCache, false);
  assert.equal((await controlledAnalysis(image, false, provider, config, undefined, A.id)).reusedFromCache, true);
  assert.equal(calls, 2);
  const usageA = await getAIUsage(config, undefined, A.id), usageB = await getAIUsage(config, undefined, B.id);
  assert.equal(usageA.analyses, 1); assert.equal(usageB.analyses, 1); assert.equal(usageA.cacheHits, 1); assert.equal(usageB.cacheHits, 0);
  assert.equal(usageA.blocked, true); assert.equal(usageB.blocked, true);
  await assert.rejects(controlledAnalysis(Buffer.from('new'), false, provider, config, undefined, B.id), { code: 'AI_LIMIT' });
  const ledger = JSON.parse(await readFile(join(config.directory, 'usage.json'), 'utf8'));
  assert.deepEqual(new Set(ledger.entries.map(e => e.userId)), new Set([A.id, B.id]));
  assert.equal(ledger.entries.some(e => 'receipt' in e), false);
}));
test('AI multiutente: consumo sconosciuto di A non condivide risultato o blocco foto con B', async () => fixture(async ({ directory }) => {
  const config = aiConfiguration({ SPESESMART_AI_DATA_DIR: join(directory, 'ai'), SPESESMART_AI_MONTHLY_USD: '50' }); await initializeAI(config);
  const image = Buffer.from('unknown fixture');
  await assert.rejects(controlledAnalysis(image, false, async () => { throw Error('synthetic timeout'); }, config, undefined, A.id));
  const provider = async () => ({ receipt: structuredClone(demoReceipt), usage: { input: 10, cached: 0, output: 10 }, model: 'gpt-4.1-mini', completed: true });
  await assert.rejects(controlledAnalysis(image, false, provider, config, undefined, A.id), { code: 'AI_UNKNOWN' });
  assert.equal((await controlledAnalysis(image, false, provider, config, undefined, B.id)).reusedFromCache, false);
  assert.equal((await getAIUsage(config, undefined, A.id)).unknown, 1); assert.equal((await getAIUsage(config, undefined, B.id)).unknown, 0);
}));
test('sessione UI: risposta tardiva e operazioni della pagina precedente non entrano nel nuovo account', async () => {
  const original = globalThis.fetch;
  try {
    let finish, forwarded = 0;
    globalThis.fetch = async () => { forwarded++; return new Promise(resolve => { finish = resolve; }); };
    bindSession(A.id, 'csrf-a'); const pending = sessionFetch('/api/archive?view=dashboard');
    clearSession(); bindSession(B.id, 'csrf-b'); finish(Response.json({ private: 'A' }));
    await assert.rejects(pending, { name: 'AbortError' });
    globalThis.fetch = async (_url, init) => { forwarded++; assert.equal(new Headers(init.headers).get('x-spesesmart-csrf'), 'csrf-b'); return Response.json({ user: A, csrf: 'csrf-a' }); };
    await assert.rejects(sessionFetch('/api/lan/session'), /Account cambiato/);
    await assert.rejects(sessionFetch('/api/archive', { method: 'POST' }), { name: 'AbortError' });
    assert.equal(forwarded, 2);
  } finally { bindSession(undefined, undefined, false); globalThis.fetch = original; }
});
