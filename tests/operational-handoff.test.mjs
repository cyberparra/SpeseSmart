import { fixturePiConfig } from './helpers/pi-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostPolicy, saveHostPolicy, hostOperationsAllowed, requireHostRole } from '../scripts/host-policy.mjs';
import { privatePiDirectory, validatePiEnvironment } from '../scripts/pi-production-profile.mjs';
import { recoveryCheck, observedLock } from '../scripts/migration-preflight.mts';
import { initializeAI, aiConfiguration, controlledAnalysis } from '../src/lib/ai-usage.ts';
import { createUpdateStore } from '../src/lib/sheets-update-store.ts';
import { homePreflight } from '../scripts/home-preflight.mts';
import { inspectTechnicalState } from '../src/lib/server-backup.ts';
import { demoReceipt } from '../src/lib/receipts/demo.ts';
const identity = 'a'.repeat(64);
async function isolated(work) {
  const path = await mkdtemp(join(tmpdir(), 'spesesmart-handoff-'));
  try { await work(path); } finally { await rm(path, { recursive: true, force: true }); }
}
test('Policy host: default PC preservato, disabilitazione e riabilitazione esplicita, nessuna env override', () => isolated(async root => {
  const path = join(root, 'policy', 'access.json');
  assert.equal(readHostPolicy(path, identity).configured, false);
  assert.equal(hostOperationsAllowed(path, identity), true);
  assert.throws(() => requireHostRole('raspberry', path, identity));
  await saveHostPolicy('disabled', path, identity);
  assert.equal(hostOperationsAllowed(path, identity), false);
  assert.throws(() => requireHostRole('pc', path, identity));
  assert.equal((await readFile(path, 'utf8')).includes('disabled'), true);
  await saveHostPolicy('pc', path, identity); assert.doesNotThrow(() => requireHostRole('pc', path, identity));
  await saveHostPolicy('raspberry', path, identity); assert.doesNotThrow(() => requireHostRole('raspberry', path, identity));
  assert.throws(() => requireHostRole('pc', path, identity));
}));
test('Policy host: permessi errati, macchina diversa, corruzione e rimozione parziale falliscono chiusi', () => isolated(async root => {
  const path = join(root, 'policy', 'access.json');
  await saveHostPolicy('disabled', path, identity);
  assert.equal(readHostPolicy(path, 'b'.repeat(64)).valid, false);
  await chmod(path, 0o644); assert.equal(readHostPolicy(path, identity).valid, false); await chmod(path, 0o600);
  await writeFile(path, '{broken'); assert.equal(hostOperationsAllowed(path, identity), false);
  await assert.rejects(saveHostPolicy('pc', path, identity));
  await unlink(path); assert.equal(readHostPolicy(path, identity).valid, false);
}));
test('Pi production: percorsi dati fissi e no Vercel/readonly, nessuna autorizzazione da flag', () => {
  const env = { SPESESMART_AI_DATA_DIR: `${fixturePiConfig.data}/ai`, SPESESMART_SHEETS_UPDATE_DIR: `${fixturePiConfig.data}/sheets-updates`, SPESESMART_LAN_DIR: `${fixturePiConfig.data}/lan` };
  assert.doesNotThrow(() => validatePiEnvironment(env, fixturePiConfig));
  for (const change of [{ SPESESMART_AI_DATA_DIR: '/tmp/ai' }, { SPESESMART_SHEETS_UPDATE_DIR: '' }, { SPESESMART_LAN_DIR: '/home/lan' }, { VERCEL: '1' }, { SPESESMART_LAN_READ_ONLY: 'true' }]) assert.throws(() => validatePiEnvironment({ ...env, ...change }, fixturePiConfig));
});
test('Pi production: directory mancante, symlink, percorso non canonico e permessi incompatibili', () => isolated(async root => {
  const data = join(root, 'data'); await mkdir(data, { mode: 0o700 });
  await privatePiDirectory(data, root);
  await assert.rejects(privatePiDirectory(join(root, 'missing'), root));
  await assert.rejects(privatePiDirectory(`${data}/../data`, root));
  await symlink(data, join(root, 'link')); await assert.rejects(privatePiDirectory(join(root, 'link'), root));
  await chmod(data, 0o755); await assert.rejects(privatePiDirectory(data, root));
}));
test('Preflight: informazioni mancanti non PASS e recovery valido richiede verifica senza blocco indiscriminato', () => isolated(async root => {
  assert.equal(observedLock(join(root, 'missing.lock')).status, 'NOT VERIFIED');
  assert.deepEqual(await readdir(root), []);
  assert.equal(recoveryCheck(0, 0).status, 'PASS');
  assert.equal(recoveryCheck(1, 0).status, 'MANUAL CHECK');
  assert.equal(recoveryCheck(0, 1).status, 'MANUAL CHECK');
}));
test('Preflight readonly: ledger/marker preservati, consumo sconosciuto recuperabile, corruzione o ledger mancante bloccano', () => isolated(async root => {
  const env = { NODE_ENV: 'test', GOOGLE_SHEETS_SPREADSHEET_ID: 'fixture', SPESESMART_AI_DATA_DIR: join(root, 'ai'), SPESESMART_SHEETS_UPDATE_DIR: join(root, 'updates') };
  await initializeAI(aiConfiguration(env)); const store = createUpdateStore(env); await store.lock(async () => {});
  const before = await inspectTechnicalState(env);
  const state = await homePreflight(env, true, true); assert.equal(state.recovery, 'none');
  assert.deepEqual(await inspectTechnicalState(env), before);
  await assert.rejects(controlledAnalysis(Buffer.from('synthetic'), false, async () => ({ receipt: demoReceipt, usage: null, model: 'gpt-4.1-mini', completed: true }), aiConfiguration(env)));
  assert.equal((await homePreflight(env, true, true)).recovery, 'required');
  const ledger = join(env.SPESESMART_AI_DATA_DIR, 'usage.json'), bytes = await readFile(ledger);
  await homePreflight(env, true, true); assert.deepEqual(await readFile(ledger), bytes);
  await writeFile(ledger, '{broken'); await assert.rejects(homePreflight(env, true, true));
  await unlink(ledger); await assert.rejects(homePreflight(env, true, true));
}));

test('Pi production: gate runtime reale con proof SSD, lock ereditato, policy e marker simulati', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', 'tests/helpers/pi-runtime-fixture.mjs'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /10 controlli sintetici riusciti/);
});
