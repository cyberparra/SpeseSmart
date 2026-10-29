import test from 'node:test';
import { initializePreferences, updatePersonalBudget, personalBudget } from '../src/lib/user-preferences.ts';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, chmod, readFile, writeFile, readdir, rm, unlink, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { serverBackupConfig, initializeBackupRoot, createServerBackup, verifyServerBackup, restoreBackupIsolated, rotationPlan, applyRotation, validateBackupMountIdentity } from '../src/lib/server-backup.ts';
import { validateFinancialBackup, assertOrdinaryBackupData, createFinancialBackupReader, backupDigest } from '../src/lib/backup-sheets.ts';
import { initializeAI, aiConfiguration, controlledAnalysis } from '../src/lib/ai-usage.ts';
import { createUpdateStore } from '../src/lib/sheets-update-store.ts';
import { withHomeWriterLock } from '../scripts/home-runtime.mjs';
import { TABLE_HEADERS, extraHeaders, canonical, chunks } from '../src/lib/sheets-persistence-model.ts';
import { transitionJournals, inspectLegacyJournals } from '../src/lib/journal-transition.ts';
import { validateStoredJournal, validateBackupJournal } from '../src/lib/sheets-update-store.ts';
import { initializeAccounts, administerAccount, readAccounts, authenticateAccount } from '../scripts/accounts.mjs';
import { encryptAccounts, decryptAccounts } from '../src/lib/account-backup.ts';
import { dailySnapshot, verifyDaily, restoreDaily, backupHistory } from '../scripts/pi-backup-worker.mts';
import { categoryDefinitions } from '../src/lib/categories.ts';
import { createSheetsRepository } from '../src/lib/sheets-repository.ts';
import { createDraft, prepareConfirmation } from '../src/lib/receipts/model.ts';
import { demoReceipt } from '../src/lib/receipts/demo.ts';

const code = wanted => e => e.code === wanted;
const expectedUSB = 'a1111111-b222-4333-8444-c55555555555';
const mountedUSB = () => ({ filesystems: [{ target: '/mnt/spesesmart-backup', uuid: expectedUSB, fstype: 'ext4', 'maj:min': '8:17' }] });

test('identità USB: UUID corretto e mount esatto sono accettati senza dipendere dal nome sdb', () => {
  const actual = validateBackupMountIdentity('/mnt/spesesmart-backup', expectedUSB.toUpperCase(), mountedUSB());
  assert.equal(actual.uuid, expectedUSB);
});

test('identità USB: mount assente, parent filesystem o risposta ambigua sono rifiutati', () => {
  for (const result of [{ filesystems: [] }, null, { filesystems: [mountedUSB().filesystems[0], mountedUSB().filesystems[0]] },
    { filesystems: [{ ...mountedUSB().filesystems[0], target: '/' }] }]) {
    assert.throws(() => validateBackupMountIdentity('/mnt/spesesmart-backup', expectedUSB, result), code('BACKUP_UUID'));
  }
});

test('identità USB: UUID errato, sconosciuto o configurazione mancante non autorizzano scritture', () => {
  for (const actualUUID of ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', null, '']) {
    assert.throws(() => validateBackupMountIdentity('/mnt/spesesmart-backup', expectedUSB,
      { filesystems: [{ ...mountedUSB().filesystems[0], uuid: actualUUID }] }), code('BACKUP_UUID'));
  }
  for (const configured of [undefined, '', 'D528-43BE', '../device']) {
    assert.throws(() => validateBackupMountIdentity('/mnt/spesesmart-backup', configured, mountedUSB()), code('BACKUP_UUID'));
  }
});

async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), 'spesesmart-backup-fixture-')); await chmod(directory, 0o700);
  const env = { NODE_ENV: 'test', GOOGLE_SHEETS_SPREADSHEET_ID: 'fixture', SPESESMART_AI_DATA_DIR: join(directory, 'ai'),
    SPESESMART_SHEETS_UPDATE_DIR: join(directory, 'updates'), SPESESMART_BACKUP_MOUNT: directory, SPESESMART_BACKUP_ROOT: join(directory, 'backups'), SPESESMART_BACKUP_UUID: '11111111-2222-4333-8444-555555555555' };
  await initializeAI(aiConfiguration(env)); const store = createUpdateStore(env); await store.lock(async () => {});
  await mkdir(env.SPESESMART_BACKUP_ROOT, { mode: 0o700 });
  const config = { ...serverBackupConfig(env), runtime: join(directory, 'runtime') };
  await initializeBackupRoot(config, true);
  const data = Object.fromEntries(Object.entries(TABLE_HEADERS).map(([name, headers], id) => [name, { id, columns: 50, rows: [[...headers, ...(name === 'Categorie' ? [] : extraHeaders(1))]] }]));
  data.Categorie.rows.push(...categoryDefinitions.map(c => [c.name, 'Spese', 'Sì', c.description]));
  const transport = { data, failAt: 0, writes: 0, async read() { return structuredClone(data); }, async guardDeletion() {}, async write(changes) {
    this.writes++; if (this.failAt === this.writes) throw new Error('simulated interruption');
    for (const c of changes) for (let n = 0; n < c.values.length; n++) {
      data[c.sheet].rows[c.row + n] ??= [];
      c.values[n].forEach((v, i) => { data[c.sheet].rows[c.row + n][c.column + i] = v; });
      while (data[c.sheet].rows[c.row + n].at(-1) === '') data[c.sheet].rows[c.row + n].pop();
    }
  } };
  const repo = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, store);
  const raw = () => ({ spreadsheetId: 'fixture', properties: { title: 'Fixture' }, namedRanges: [{ name: 'Tecnico', namedRangeId: 'stable' }], sheets: [
    ...Object.entries(data).map(([title, table]) => ({ properties: { title, sheetId: table.id, gridProperties: { rowCount: 1000, columnCount: table.columns } },
      data: [{ rowData: table.rows.map(row => ({ values: row.map(v => { const value = typeof v === 'number' ? { numberValue: v } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) }; return { userEnteredValue: value, effectiveValue: value }; }) })) }] })),
    { properties: { title: 'LEGGIMI', sheetId: 9 }, data: [{ rowData: [{ values: [{ userEnteredValue: { stringValue: 'Configurazione' } }] }] }] },
    { properties: { title: 'Metadati', sheetId: 10 }, data: [{ rowData: [{ values: [{ userEnteredValue: { formulaValue: '=1+1' }, effectiveValue: { numberValue: 2 } }] }] }] },
  ] });
  const readFinancial = async () => raw();
  const manual = async () => { const operationId = randomUUID(); await repo.save({ kind: 'manual', operationId, draft: { description: 'Fixture', date: '2026-10-12', notes: 'Note', items: [{ amount: '7.00', category: 'Alimentari' }] } }); return `manual-${operationId}`; };
  const deletion = async id => ({ documentId: id, operationId: randomUUID(), expectedVersion: (await repo.load()).editablePurchases[id].version, confirmed: true });
  try { await work({ directory, config, env, store, repo, transport, raw, readFinancial, manual, deletion }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('preflight production: directory ordinaria non montata rifiutata prima di creare lock o marker', () => fixture(async f => {
  const root = join(f.directory, 'unmounted-root'); await mkdir(root, { mode: 0o700 });
  const realPolicy = { ...f.config, root, mount: root, env: { ...f.env, NODE_ENV: 'production' } };
  await assert.rejects(initializeBackupRoot(realPolicy, true), code('BACKUP_UUID'));
  assert.deepEqual(await readdir(root), []);
}));

test('backup tecnico: byte ledger, marker, cache e permessi preservati; nessuna chiamata remota', () => fixture(async f => {
  await controlledAnalysis(Buffer.from('fixture-image'), false, async () => ({ receipt: demoReceipt, usage: { input: 4000, cached: 1000, output: 1500 }, model: 'gpt-4.1-mini', completed: true }), aiConfiguration(f.env));
  const cacheName = (await readdir(f.env.SPESESMART_AI_DATA_DIR)).find(name => name.endsWith('.cache.json'));
  const cachePath = join(f.env.SPESESMART_AI_DATA_DIR, cacheName);
  const historical = JSON.parse(await readFile(cachePath, 'utf8'));
  historical.receipt.items[0].category = 'Abbonamenti Digitali';
  await writeFile(cachePath, JSON.stringify(historical));
  const originalCache = await readFile(cachePath);
  const original = await readFile(join(f.env.SPESESMART_AI_DATA_DIR, 'usage.json'));
  const result = await createServerBackup(f.config, 'daily', { readFinancial() { throw new Error('never read'); } });
  const manifest = await verifyServerBackup(result.directory);
  assert.ok(manifest.files.some(file => file.path.endsWith('.cache.json')));
  assert.deepEqual(await readFile(join(result.directory, 'technical/ai', cacheName)), originalCache);
  assert.deepEqual(await readFile(join(result.directory, 'technical/ai/usage.json')), original);
  for (const file of manifest.files) assert.equal((await stat(join(result.directory, file.path))).mode & 0o777, 0o600);
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
}));

test('backup settimanale: tutte le schede, formule, metadati e tombstone; copia isolata su percorsi nuovi', () => fixture(async f => {
  const id = await f.manual(); await f.repo.delete(await f.deletion(id));
  const before = f.raw(); const result = await createServerBackup(f.config, 'weekly', { readFinancial: f.readFinancial });
  assert.deepEqual(JSON.parse(await readFile(join(result.directory, 'financial/google-sheets.json'), 'utf8')), before);
  assert.equal(validateFinancialBackup(before, f.store.scope).deletedDocuments, 1);
  const target = join(f.directory, 'isolated'); const restored = await restoreBackupIsolated(f.config, result.directory, target);
  assert.equal(restored.remoteRestore, false);
  assert.deepEqual(JSON.parse(await readFile(join(target, 'financial/google-sheets.json'), 'utf8')), before);
  assert.equal((await createUpdateStore({ ...f.env, SPESESMART_SHEETS_UPDATE_DIR: join(target, 'sheets-updates') }).list())[0].state, 'complete');
  await assert.rejects(restoreBackupIsolated(f.config, result.directory, target));
}));

test('backup: destinazione assente, permessi errati e spazio insufficiente non pubblicano copie', () => fixture(async f => {
  await assert.rejects(createServerBackup({ ...f.config, root: join(f.directory, 'absent') }, 'daily'), { code: 'ENOENT' });
  await chmod(f.config.root, 0o755); await assert.rejects(createServerBackup(f.config, 'daily'), code('PERMISSIONS')); await chmod(f.config.root, 0o700);
  await assert.rejects(createServerBackup(f.config, 'daily', { availableBytes: async () => 0 }), code('SPACE'));
  assert.deepEqual(await readdir(join(f.config.root, 'sets')), []);
}));

test('backup: interruzione lascia solo staging privato, mai adottato o cancellato dalla rotazione', () => fixture(async f => {
  await assert.rejects(createServerBackup(f.config, 'daily', { beforePublish: async () => { throw new Error('interrupted'); } }));
  const files = await readdir(join(f.config.root, 'sets')); assert.equal(files.length, 1); assert.match(files[0], /^\.partial-/);
  assert.deepEqual((await rotationPlan(f.config)).remove, []);
  assert.equal((await stat(join(f.config.root, 'sets', files[0]))).mode & 0o777, 0o700);
}));

test('backup: checksum alterato, link e ledger mancante/danneggiato sono bloccanti', () => fixture(async f => {
  const result = await createServerBackup(f.config, 'daily');
  await writeFile(join(result.directory, 'technical/ai/usage.json'), '{}'); await assert.rejects(verifyServerBackup(result.directory), code('CHECKSUM'));
  const ledger = join(f.env.SPESESMART_AI_DATA_DIR, 'usage.json'); const original = await readFile(ledger);
  await unlink(ledger); await assert.rejects(createServerBackup(f.config, 'daily')); await assert.rejects(readFile(ledger), { code: 'ENOENT' });
  await writeFile(ledger, '{bad', { mode: 0o600 }); await assert.rejects(createServerBackup(f.config, 'daily'));
  await writeFile(ledger, original); await symlink(ledger, join(f.env.SPESESMART_AI_DATA_DIR, 'extra.json')); await assert.rejects(createServerBackup(f.config, 'daily'));
}));

test('backup: writer attivo e due backup simultanei non copiano né interrompono operazioni', () => fixture(async f => {
  await withHomeWriterLock(async () => {
    await assert.rejects(createServerBackup(f.config, 'weekly', { readFinancial() { assert.fail('remote read while writer active'); } }), /già attivo/);
  }, f.config.runtime);
  let ready; const started = new Promise(r => { ready = r; }); let release; const gate = new Promise(r => { release = r; });
  const first = createServerBackup(f.config, 'daily', { beforePublish: async () => { ready(); await gate; } });
  await started; try { await assert.rejects(createServerBackup(f.config, 'daily'), code('BUSY')); } finally { release(); }
  await first;
}));

test('backup: pendente di eliminazione parziale e UUID preservati senza recupero automatico', () => fixture(async f => {
  const id = await f.manual(), request = await f.deletion(id); f.transport.failAt = f.transport.writes + 2;
  await assert.rejects(f.repo.delete(request));
  assert.equal((await f.store.list())[0].state, 'pending');
  const original = JSON.stringify(f.transport.data);
  const result = await createServerBackup(f.config, 'weekly', { readFinancial: f.readFinancial });
  assert.equal(result.pending, 1); assert.equal(JSON.stringify(f.transport.data), original);
  const restored = await restoreBackupIsolated(f.config, result.directory, join(f.directory, 'pending-restore'));
  assert.equal(restored.pending, 1); assert.deepEqual((await verifyServerBackup(result.directory)).state.pendingOperations, [request.operationId]);
}));

test('backup: prenotazioni AI sconosciute anche di mesi passati restano intatte; ledger obsoleto rifiutato', () => fixture(async f => {
  const old = await createServerBackup(f.config, 'daily');
  await assert.rejects(controlledAnalysis(Buffer.from('unknown'), false, async () => { throw new Error('provider simulated'); }, aiConfiguration(f.env), () => new Date('2026-01-01T12:00:00Z')));
  const before = await readFile(join(f.env.SPESESMART_AI_DATA_DIR, 'usage.json'));
  await assert.rejects(restoreBackupIsolated(f.config, old.directory, join(f.directory, 'stale')), code('STALE_LEDGER'));
  const fresh = await createServerBackup(f.config, 'daily'); assert.equal(fresh.unknownAI, 1);
  const restored = await restoreBackupIsolated(f.config, fresh.directory, join(f.directory, 'unknown-restore')); assert.equal(restored.unknownAI, 1);
  assert.deepEqual(await readFile(join(f.env.SPESESMART_AI_DATA_DIR, 'usage.json')), before);
}));

test('backup: immagini dirette, frammenti, base64, formule immagine e segreti bloccano senza sanificazione', () => fixture(async f => {
  for (const value of [{ image: 'foto' }, { notes: 'data:image/png;base64,AA==' }, { private_key: 'sensitive' }, { photoData: 'abc' }, { note: '/9j/' + 'A'.repeat(200) }]) assert.throws(() => assertOrdinaryBackupData(value));
  const raw = f.raw(); raw.sheets[1].data[0].rowData.push({ values: [{ userEnteredValue: { formulaValue: '=IMAGE("https://example.test/photo")' } }] });
  assert.throws(() => validateFinancialBackup(raw, f.store.scope), code('REVIEW_REQUIRED'));
  const fragmented = { rows: [['SpeseSmart JSON 1', 'SpeseSmart JSON 2'], ['{"image":"data:ima', 'ge/png;base64,AA=="}']] };
  assert.throws(() => assertOrdinaryBackupData(fragmented));
  await writeFile(join(f.env.SPESESMART_AI_DATA_DIR, 'unrecognized.tmp'), 'interrupted', { mode: 0o600 });
  await assert.rejects(createServerBackup(f.config, 'daily'));
}));

test('backup: snapshot esterno cambiato o ID diverso impediscono la pubblicazione', () => fixture(async f => {
  let reads = 0;
  await assert.rejects(createServerBackup(f.config, 'weekly', { readFinancial: async () => ({ ...f.raw(), properties: { title: String(++reads) } }) }), code('REMOTE_CHANGED'));
  await assert.rejects(createServerBackup(f.config, 'weekly', { readFinancial: async () => ({ ...f.raw(), spreadsheetId: 'different' }) }), code('REVIEW_REQUIRED'));
  assert.deepEqual(await readdir(join(f.config.root, 'sets')), []);
}));

test('backup: rete indisponibile e marker perso non ricreano registri e non dichiarano successo', () => fixture(async f => {
  await assert.rejects(createServerBackup(f.config, 'weekly', { readFinancial: async () => { throw new Error('network unavailable'); } }));
  const marker = join(f.env.SPESESMART_SHEETS_UPDATE_DIR, `${f.store.scope}.initialized`); await unlink(marker);
  await assert.rejects(createServerBackup(f.config, 'daily')); await assert.rejects(readFile(marker), { code: 'ENOENT' });
}));

test('backup: scontrino multicategoria preserva prodotti, categorie, versioni e dati strutturati', () => fixture(async f => {
  let n = 0; const receipt = prepareConfirmation(createDraft(demoReceipt, () => `item-${++n}`), demoReceipt, '', false, () => `document-${++n}`, 'a'.repeat(64));
  await f.repo.save({ kind: 'receipt', operationId: receipt.Documenti[0].id, receipt });
  const raw = f.raw(), result = await createServerBackup(f.config, 'weekly', { readFinancial: f.readFinancial });
  assert.equal(validateFinancialBackup(raw, f.store.scope).deletedDocuments, 0);
  assert.deepEqual(JSON.parse(await readFile(join(result.directory, 'financial/google-sheets.json'), 'utf8')), raw);
}));

test('rotazione GFS: 7 giorni, 4 settimane, 3 mesi; piano obsoleto bloccato e copie estranee preservate', () => fixture(async f => {
  for (const date of ['2026-07-01', '2026-08-02', '2026-09-06', '2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']) await createServerBackup(f.config, 'weekly', { readFinancial: f.readFinancial }, new Date(date + 'T12:00:00Z'));
  for (let day = 19; day <= 27; day++) await createServerBackup(f.config, 'daily', {}, new Date(`2026-10-${day}T18:00:00Z`));
  const plan = await rotationPlan(f.config); assert.ok(plan.remove.length > 0);
  const kept = await Promise.all(plan.keep.map(r => verifyServerBackup(join(f.config.root, 'sets', r.id))));
  assert.equal(kept.filter(m => m.kind === 'weekly').length, 6); // four weeks plus August/September monthly anchors
  assert.equal(kept.filter(m => m.kind === 'daily').length, 7); // latest copy of Oct25 is the daily one
  const legacy = join(f.config.root, 'sets', 'old-reset-backup'); await mkdir(legacy, { mode: 0o700 });
  await createServerBackup(f.config, 'daily', {}, new Date('2026-10-28T12:00:00Z'));
  await assert.rejects(applyRotation(f.config, plan), code('ROTATION_CHANGED'));
  const fresh = await rotationPlan(f.config); const result = await applyRotation(f.config, fresh);
  assert.equal(result.removed, fresh.remove.length); assert.ok((await stat(legacy)).isDirectory());
  for (const item of fresh.keep) await verifyServerBackup(join(f.config.root, 'sets', item.id));
}));

test('backup: CLI rifiuta il bypass NODE_ENV=test e Vercel prima di accedere ai registri', () => {
  const result = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/backup.mts', 'daily'], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', VERCEL: '1' } });
  assert.equal(result.status, 1); assert.match(result.stderr, /CONFIGURATION/);
});

test('ripristino: riferimento AI archiviato resta immutabile e verificabile su un altro percorso', () => fixture(async f => {
  const result = await createServerBackup(f.config, 'daily');
  const reference = join(result.directory, 'technical/ai');
  const before = await readdir(reference);
  await restoreBackupIsolated(f.config, result.directory, join(f.directory, 'portable'), reference);
  assert.deepEqual(await readdir(reference), before); await verifyServerBackup(result.directory);
  const store = createUpdateStore({ ...f.env, SPESESMART_SHEETS_UPDATE_DIR: join(f.directory, 'portable/sheets-updates') });
  assert.deepEqual(await store.list(), []);
}));

test('backup: mount mancante, registro journal danneggiato e destinazione storica non sono adottati', () => fixture(async f => {
  await assert.rejects(createServerBackup({ ...f.config, mount: join(f.directory, 'missing-mount') }, 'daily'));
  await writeFile(join(f.env.SPESESMART_SHEETS_UPDATE_DIR, f.store.scope, `${randomUUID()}.json`), '{}', { mode: 0o600 });
  await assert.rejects(createServerBackup(f.config, 'daily'));
  const other = join(f.directory, 'old-backups'); await mkdir(other, { mode: 0o700 });
  await writeFile(join(other, 'previous-reset.json'), '{}', { mode: 0o600 });
  await assert.rejects(initializeBackupRoot({ ...f.config, root: other }, true), code('DESTINATION_NOT_EMPTY'));
  assert.equal(await readFile(join(other, 'previous-reset.json'), 'utf8'), '{}');
}));

test('export Sheets: usa soltanto spreadsheets.get readonly con timeout, verifica ID e nessuna scrittura', async () => {
  let called = 0;
  const env = { GOOGLE_SHEETS_SPREADSHEET_ID: 'fixture', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'fixture@example.test', GOOGLE_PRIVATE_KEY: 'fixture' };
  // Auth configuration is validated before the fake SDK call; provide its existing JSON format.
  env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'fixture@example.test', private_key: 'fixture', type: 'service_account' });
  const read = createFinancialBackupReader(env, () => ({ spreadsheets: { get: async (request, options) => {
    called++; assert.deepEqual(request, { spreadsheetId: 'fixture', includeGridData: true }); assert.equal(options.retry, false); assert.equal(options.timeout, 30000);
    return { data: { spreadsheetId: 'fixture' } };
  } } }));
  assert.equal((await read()).spreadsheetId, 'fixture'); assert.equal(called, 1);
  assert.equal(backupDigest('fixture').length, 64);
});

test('backup multiutente: preferenze e cache attribuite recuperabili, credenziali escluse', () => fixture(async f => {
  const A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  const preferences = join(f.directory, 'preferences');
  f.config.env.SPESESMART_PREFERENCES_DIR = preferences;
  await initializePreferences(f.config.env);
  await updatePersonalBudget(A, { month: '2026-10', budgetCents: 12345, expectedVersion: 0 }, f.config.env);
  await controlledAnalysis(Buffer.from('user A synthetic backup'), false, async () => ({ receipt: demoReceipt, usage: { input: 10, cached: 0, output: 10 }, model: 'gpt-4.1-mini', completed: true }), aiConfiguration(f.env), undefined, A.id);
  const created = await createServerBackup(f.config, 'daily');
  const manifest = await verifyServerBackup(created.directory);
  assert.equal(manifest.configuration.preferences, true);
  assert.ok(manifest.files.some(file => file.path === 'technical/preferences/preferences.json'));
  assert.ok(manifest.files.every(file => !/accounts|credentials/.test(file.path)));
  const target = join(f.directory, 'restored-multiuser');
  await restoreBackupIsolated(f.config, created.directory, target);
  const restored = { ...f.env, SPESESMART_PREFERENCES_DIR: join(target, 'preferences') };
  assert.equal((await personalBudget(A, '2026-10', restored)).budgetCents, 12345);
  assert.equal((await personalBudget(B, '2026-10', restored)).budgetCents, 200000);
  const ledger = JSON.parse(await readFile(join(target, 'ai/usage.json'), 'utf8'));
  assert.equal(ledger.entries[0].userId, A.id);
  const content = await readFile(join(target, 'preferences/preferences.json'), 'utf8');
  assert.ok(!/password|credential|api_key/.test(content));
  await writeFile(join(created.directory, 'technical/preferences/preferences.json'), '{}');
  await assert.rejects(verifyServerBackup(created.directory), code('CHECKSUM'));
}));

// Synthetic old layouts are reconstructed from the public v1 contract, with
// checksums and request hashes computed independently of the compatibility reader.
function legacyRow(name, row, header = false) {
  if (name === 'Categorie' || !row.some(v => v !== '')) return row;
  const size = TABLE_HEADERS[name].length;
  const result = [...row.slice(0, size - 1), ...row.slice(size, size + 2)];
  if (header) return [...row.slice(0, size - 1), ...row.slice(size)];
  if (row[size + 2]) { const data = JSON.parse(row.slice(size + 2).join('')); delete data.userId; result.push(...chunks(data)); }
  return result;
}
function legacyJournal(journal) {
  const value = structuredClone(journal); value.version = 1; delete value.userId;
  value.requestHash = backupDigest(canonical(value.request));
  for (const patch of [value.marker, ...value.patches, value.commit]) {
    patch.before = legacyRow(patch.sheet, patch.before); patch.after = legacyRow(patch.sheet, patch.after);
  }
  for (const name of Object.keys(value.headers)) value.headers[name] = legacyRow(name, value.headers[name], true);
  return JSON.stringify({ checksum: backupDigest(canonical(value)), journal: value });
}
async function journalFixture(f) {
  const id = await f.manual(); const editable = (await f.repo.load()).editablePurchases[id];
  await f.repo.update({ documentId: id, operationId: randomUUID(), expectedVersion: editable.version, draft: editable.draft });
  const journal = (await f.store.list())[0], name = `${journal.operationId}.json`;
  return { journal, name, path: join(f.env.SPESESMART_SHEETS_UPDATE_DIR, f.store.scope, name), old: legacyJournal(journal) };
}

test('transizione: v1 completati archiviati senza adozione, marker invariato, backup e rollback byte-identici', () => fixture(async f => {
  const j = await journalFixture(f); await writeFile(j.path, j.old);
  assert.equal(validateBackupJournal(j.old, f.store.scope, j.name).version, 1);
  assert.throws(() => validateStoredJournal(j.old, f.store.scope, j.name));
  await assert.rejects(f.store.list());
  const marker = await readFile(join(f.env.SPESESMART_SHEETS_UPDATE_DIR, `${f.store.scope}.initialized`));
  const plan = await transitionJournals(f.env, 'plan');
  await assert.rejects(transitionJournals(f.env, 'apply', '0'.repeat(64)));
  await transitionJournals(f.env, 'apply', plan.fingerprint);
  assert.deepEqual(await f.store.list(), []);
  const archive = join(f.env.SPESESMART_SHEETS_UPDATE_DIR, `${f.store.scope}.legacy-v1`);
  assert.equal(await readFile(join(archive, j.name), 'utf8'), j.old);
  const copied = await createServerBackup(f.config, 'daily');
  assert.ok((await verifyServerBackup(copied.directory)).files.some(file => file.path.startsWith('technical/legacy/')));
  const restored = join(f.directory, 'transition-restored'); await restoreBackupIsolated(f.config, copied.directory, restored);
  await inspectLegacyJournals(join(restored, 'sheets-updates', `${f.store.scope}.legacy-v1`), f.store.scope, true);
  const archiveManifest = await readFile(join(archive, 'transition-manifest.json'));
  await unlink(join(archive, 'transition-manifest.json')); await assert.rejects(createServerBackup(f.config, 'daily'));
  await writeFile(join(archive, 'transition-manifest.json'), archiveManifest, { mode: 0o600 });
  await transitionJournals(f.env, 'rollback', plan.fingerprint);
  assert.equal(await readFile(j.path, 'utf8'), j.old);
  assert.deepEqual(await readFile(join(f.env.SPESESMART_SHEETS_UPDATE_DIR, `${f.store.scope}.initialized`)), marker);
}));

test('transizione: pending, corruzione, writer attivo e nuove operazioni v2 impediscono alterazioni', () => fixture(async f => {
  const j = await journalFixture(f); const pending = JSON.parse(j.old); pending.journal.state = 'pending'; pending.checksum = backupDigest(canonical(pending.journal));
  const cli = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/transition-journals.mts', 'plan'], { env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS, ...f.env }, encoding: 'utf8' });
  assert.equal(cli.status, 1); // The real CLI never accepts the /tmp test bypass.
  await writeFile(j.path, JSON.stringify(pending)); await assert.rejects(transitionJournals(f.env, 'plan'));
  await writeFile(j.path, j.old); const plan = await transitionJournals(f.env, 'plan');
  await withHomeWriterLock(async () => { await assert.rejects(transitionJournals(f.env, 'apply', plan.fingerprint)); });
  assert.equal(await readFile(j.path, 'utf8'), j.old);
  await writeFile(j.path, '{}'); await assert.rejects(transitionJournals(f.env, 'apply', plan.fingerprint));
  await writeFile(j.path, j.old); await transitionJournals(f.env, 'apply', plan.fingerprint);
  await f.store.lock(() => f.store.put(j.journal));
  await assert.rejects(transitionJournals(f.env, 'rollback', plan.fingerprint));
  assert.equal((await f.store.list())[0].version, 2);
}));

test('transizione: ripresa esplicita dopo rename e rollback parziale, guard impedisce uso applicativo', () => fixture(async f => {
  const j = await journalFixture(f); await writeFile(j.path, j.old); const plan = await transitionJournals(f.env, 'plan');
  const base = f.env.SPESESMART_SHEETS_UPDATE_DIR, active = join(base, f.store.scope), archive = `${active}.legacy-v1`;
  await mkdir(`${active}.v2-staging`, { mode: 0o700 });
  await writeFile(`${active}.transition-pending`, `apply:${plan.fingerprint}`, { mode: 0o600 });
  const { rename } = await import('node:fs/promises'); await rename(active, archive);
  await assert.rejects(f.store.list()); await assert.rejects(f.store.lock(async () => {}));
  await transitionJournals(f.env, 'apply', plan.fingerprint); assert.deepEqual(await f.store.list(), []);
  await writeFile(`${active}.transition-pending`, `rollback:${plan.fingerprint}`, { mode: 0o600 });
  await writeFile(j.path, j.old, { mode: 0o600 });
  await transitionJournals(f.env, 'rollback', plan.fingerprint); assert.equal(await readFile(j.path, 'utf8'), j.old);
}));

async function rewriteHistoricSet(directory, scope) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  for (const file of manifest.files) {
    const path = join(directory, file.path);
    if (file.path.startsWith(`technical/sheets/${scope}/`)) {
      await writeFile(path, legacyJournal(JSON.parse(await readFile(path, 'utf8')).journal));
    }
    if (file.path === 'financial/google-sheets.json') {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      for (const sheet of raw.sheets) {
        const name = sheet.properties.title;
        if (!['Movimenti', 'Prodotti', 'Documenti'].includes(name)) continue;
        const rows = sheet.data[0].rowData;
        sheet.data[0].rowData = rows.map((row, i) => ({ values: legacyRow(name, row.values.map(c => c.effectiveValue?.stringValue ?? c.effectiveValue?.numberValue ?? c.effectiveValue?.boolValue ?? ''), i === 0).map(value => {
          const cell = typeof value === 'number' ? { numberValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value) };
          return { userEnteredValue: cell, effectiveValue: cell };
        }) }));
      }
      await writeFile(path, JSON.stringify(raw));
    }
    const data = await readFile(path); file.sha256 = backupDigest(data); file.bytes = data.length;
  }
  const data = JSON.stringify(manifest); await writeFile(join(directory, 'manifest.json'), data); await writeFile(join(directory, 'manifest.sha256'), backupDigest(data));
}

test('storico: sei set v1 (4 daily, 2 weekly) restano immutati, verificabili e ripristinabili', () => fixture(async f => {
  const j = await journalFixture(f); const previous = [];
  for (let i = 0; i < 6; i++) {
    const copy = await createServerBackup(f.config, i < 4 ? 'daily' : 'weekly', { readFinancial: f.readFinancial });
    await rewriteHistoricSet(copy.directory, f.store.scope); await verifyServerBackup(copy.directory);
    previous.push(copy);
  }
  const history = await backupHistory(f.config);
  await writeFile(j.path, j.old); const plan = await transitionJournals(f.env, 'plan'); await transitionJournals(f.env, 'apply', plan.fingerprint);
  for (const [i, copy] of previous.entries()) {
    await verifyServerBackup(copy.directory);
    await restoreBackupIsolated(f.config, copy.directory, join(f.directory, `historic-${i}`));
  }
  assert.deepEqual(await backupHistory(f.config), history);
}));

test('storico: weekly v1 pendente resta recuperabile offline, righe estranee vengono rifiutate', () => fixture(async f => {
  const id = await f.manual(), editable = (await f.repo.load()).editablePurchases[id];
  f.transport.failAt = f.transport.writes + 2;
  await assert.rejects(f.repo.update({ documentId: id, operationId: randomUUID(), expectedVersion: editable.version, draft: editable.draft }));
  const copy = await createServerBackup(f.config, 'weekly', { readFinancial: f.readFinancial });
  await rewriteHistoricSet(copy.directory, f.store.scope);
  assert.equal((await verifyServerBackup(copy.directory)).state.pendingOperations.length, 1);
  await restoreBackupIsolated(f.config, copy.directory, join(f.directory, 'legacy-pending'));
  const file = join(copy.directory, 'financial/google-sheets.json'), raw = JSON.parse(await readFile(file, 'utf8'));
  raw.sheets.find(sheet => sheet.properties.title === 'Documenti').data[0].rowData[1].values[3] = { effectiveValue: { stringValue: 'external change' } };
  const data = JSON.stringify(raw); await writeFile(file, data);
  const manifest = JSON.parse(await readFile(join(copy.directory, 'manifest.json'), 'utf8'));
  const record = manifest.files.find(file => file.path === 'financial/google-sheets.json'); record.bytes = Buffer.byteLength(data); record.sha256 = backupDigest(data);
  const text = JSON.stringify(manifest); await writeFile(join(copy.directory, 'manifest.json'), text); await writeFile(join(copy.directory, 'manifest.sha256'), backupDigest(text));
  await assert.rejects(verifyServerBackup(copy.directory));
}));

async function accountKeys(f) {
  Object.assign(f.config.env, { SPESESMART_MULTIUSER: 'true', SPESESMART_ACCOUNT_DIR: join(f.directory, 'accounts'), SPESESMART_PREFERENCES_DIR: join(f.directory, 'preferences'),
    SPESESMART_ACCOUNT_BACKUP_PUBLIC_KEY_FILE: join(f.directory, 'backup-public.pem'), SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE: join(f.directory, 'backup-private.pem') });
  const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
  await writeFile(f.config.env.SPESESMART_ACCOUNT_BACKUP_PUBLIC_KEY_FILE, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  await writeFile(f.config.env.SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await initializeAccounts(f.config.env.SPESESMART_ACCOUNT_DIR); await initializePreferences(f.config.env);
  for (const [username, role] of [['admin', 'admin'], ['a', 'user'], ['b', 'user']]) await administerAccount(f.config.env.SPESESMART_ACCOUNT_DIR, 'create', username, { role, password: 'synthetic backup password' });
}

test('account cifrati: daily, fingerprint coordinatore e restore con login, UUID, revisioni, budget e stato preservati', () => fixture(async f => {
  await accountKeys(f);
  const original = await readAccounts(f.config.env.SPESESMART_ACCOUNT_DIR), a = original.accounts[1];
  await updatePersonalBudget(a, { month: '2026-10', budgetCents: 54321, expectedVersion: 0 }, f.config.env);
  await administerAccount(f.config.env.SPESESMART_ACCOUNT_DIR, 'disable', 'b');
  const accounts = await readAccounts(f.config.env.SPESESMART_ACCOUNT_DIR);
  const first = await dailySnapshot(f.config); const copy = await createServerBackup(f.config, 'daily');
  const verified = await verifyDaily(f.config, copy.id); assert.equal(verified.fingerprint, first.fingerprint);
  const manifest = await verifyServerBackup(copy.directory); assert.equal(manifest.configuration.accountsEncrypted, true);
  const cipher = await readFile(join(copy.directory, 'technical/accounts/accounts.enc'), 'utf8');
  for (const secret of ['synthetic backup password', a.id, a.revision, a.credential.hash, 'PRIVATE KEY']) assert.ok(!cipher.includes(secret));
  assert.ok(manifest.files.every(file => !file.path.includes('.pem') && !file.path.includes('accounts.json')));
  const target = join(f.directory, 'accounts-restored'); await restoreBackupIsolated(f.config, copy.directory, target);
  assert.deepEqual(await readAccounts(join(target, 'accounts')), accounts);
  assert.equal((await authenticateAccount(join(target, 'accounts'), 'a', 'synthetic backup password')).id, a.id);
  assert.equal(await authenticateAccount(join(target, 'accounts'), 'b', 'synthetic backup password'), null);
  assert.equal((await personalBudget(a, '2026-10', { ...f.config.env, SPESESMART_PREFERENCES_DIR: join(target, 'preferences') })).budgetCents, 54321);
  await restoreDaily(f.config, copy.id, join(f.directory, 'automation-restores'));
  assert.equal((await dailySnapshot(f.config)).fingerprint, first.fingerprint);
}));

test('account cifrati: chiave mancante/errata, permessi, ciphertext e scope alterati bloccano il recupero', () => fixture(async f => {
  await accountKeys(f); const env = f.config.env, data = await encryptAccounts(env, f.store.scope);
  const other = generateKeyPairSync('rsa', { modulusLength: 3072 }); const wrong = join(f.directory, 'wrong-private.pem');
  await writeFile(wrong, other.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await assert.rejects(decryptAccounts(data, { ...env, SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE: wrong }, f.store.scope));
  await assert.rejects(decryptAccounts(data, { ...env, SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE: undefined }, f.store.scope));
  await assert.rejects(decryptAccounts(data, env, '0'.repeat(64)));
  const corrupt = JSON.parse(data); const bytes = Buffer.from(corrupt.ciphertext, 'base64'); bytes[0] ^= 1; corrupt.ciphertext = bytes.toString('base64');
  await assert.rejects(decryptAccounts(Buffer.from(JSON.stringify(corrupt)), env, f.store.scope));
  await chmod(env.SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE, 0o644); await assert.rejects(dailySnapshot(f.config));
  await assert.rejects(createServerBackup(f.config, 'daily'));
  assert.deepEqual(await readdir(join(f.config.root, 'sets')), []);
}));
