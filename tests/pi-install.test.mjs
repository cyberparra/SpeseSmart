import './helpers/isolated-host-policy.mjs';
import '../scripts/pi-preview-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeInstallation, installationEnvironment } from '../scripts/pi-install.mts';
import { piConfig, validatePiConfig } from '../scripts/pi-config.mjs';
import { fixturePiConfig } from './helpers/pi-config.mjs';
import { readAccounts, administerAccount, authenticateAccount } from '../scripts/accounts.mjs';
import { homePreflight } from '../scripts/home-preflight.mts';
import { getAIUsage, aiConfiguration } from '../src/lib/ai-usage.ts';
import { setupPlan } from '../src/lib/sheets-repository.ts';
import { createUpdateStore } from '../src/lib/sheets-update-store.ts';
import { initializeBackupRoot, createServerBackup, restoreBackupIsolated, serverBackupConfig } from '../src/lib/server-backup.ts';

test('prima installazione offline: stato vuoto, admin proprio, preflight, backup e mancata ricreazione registri', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spesesmart-first-install-'));
  const config = { ...fixturePiConfig, mount: root, app: join(root, 'app'), data: join(root, 'data') };
  const env = { ...installationEnvironment(config), NODE_ENV: 'test', GOOGLE_SHEETS_SPREADSHEET_ID: 'synthetic-empty-sheet',
    SPESESMART_BACKUP_ROOT: join(root, 'backup'), SPESESMART_BACKUP_MOUNT: root, SPESESMART_BACKUP_UUID: fixturePiConfig.ssdUUID };
  try {
    await mkdir(config.data, { mode: 0o700 });
    await mkdir(join(config.data, 'credentials'), { mode: 0o700 });
    await initializeInstallation(config, env);
    assert.deepEqual((await readAccounts(env.SPESESMART_ACCOUNT_DIR)).accounts, []);
    await administerAccount(env.SPESESMART_ACCOUNT_DIR, 'create', 'admin-sintetico', { role: 'admin', password: 'password-sintetica-123' });
    const admin = await authenticateAccount(env.SPESESMART_ACCOUNT_DIR, 'admin-sintetico', 'password-sintetica-123');
    assert.equal(admin.role, 'admin');
    assert.equal(await authenticateAccount(env.SPESESMART_ACCOUNT_DIR, 'admin-sintetico', 'errata'), null);
    const state = await homePreflight(env, true, true);
    assert.equal(state.pending, 0); assert.equal(state.unknownAI, 0);
    assert.deepEqual(await createUpdateStore(env).list(), []);
    await getAIUsage(aiConfiguration(env));
    const ledger = await readFile(join(env.SPESESMART_AI_DATA_DIR, 'usage.json'));
    await assert.rejects(initializeInstallation(config, env));
    assert.deepEqual(await readFile(join(env.SPESESMART_AI_DATA_DIR, 'usage.json')), ledger);
    await mkdir(env.SPESESMART_BACKUP_ROOT, { mode: 0o700 });
    const backupConfig = { ...serverBackupConfig(env), runtime: join(root, 'runtime') };
    await initializeBackupRoot(backupConfig, true);
    const backup = await createServerBackup(backupConfig, 'daily', { readFinancial() { assert.fail('Accesso Sheets vietato'); } });
    const restored = await restoreBackupIsolated(backupConfig, backup.directory, join(root, 'restore'));
    assert.equal(restored.remoteRestore, false);
    assert.deepEqual(await readFile(join(env.SPESESMART_AI_DATA_DIR, 'usage.json')), ledger);
    await unlink(join(env.SPESESMART_ACCOUNT_DIR, 'accounts.json'));
    await assert.rejects(initializeInstallation(config, env));
    await assert.rejects(readAccounts(env.SPESESMART_ACCOUNT_DIR));
    await unlink(join(env.SPESESMART_AI_DATA_DIR, 'usage.json'));
    await assert.rejects(homePreflight(env, true, true));
    await assert.rejects(initializeInstallation(config, env));
    await assert.rejects(readFile(join(env.SPESESMART_AI_DATA_DIR, 'usage.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configurazione locale: identità obbligatorie, mount diversi e file protetto', async () => {
  const config = { ...fixturePiConfig }; delete config.app; delete config.data;
  assert.equal(validatePiConfig(config).data, config.mount + '/data');
  for (const change of [{ ssdUUID: '' }, { ip: '0.0.0.0' }, { ip: '8.8.8.8' }, { caSHA256: '00'.repeat(32) },
    { mount: '/' }, { mount: '/srv/a/../b' }, { tlsDirectory: '/tmp/tls' }, { user: 'x\nExecStart=evil' },
    { backupMount: '/backup', backupUUID: config.ssdUUID, backupLabel: 'BKP' }]) assert.throws(() => validatePiConfig({ ...config, ...change }));
  const root = await mkdtemp(join(tmpdir(), 'spesesmart-config-'));
  try {
    const file = join(root, 'pi.json');
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    assert.equal(piConfig({ SPESESMART_PI_CONFIG: file }).ip, config.ip);
    await chmod(file, 0o666); assert.throws(() => piConfig({ SPESESMART_PI_CONFIG: file })); await chmod(file, 0o600);
    await symlink(file, join(root, 'link')); assert.throws(() => piConfig({ SPESESMART_PI_CONFIG: join(root, 'link') }));
    assert.throws(() => piConfig({}));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('modello foglio nuovo: schema completo senza allineamenti o dati finanziari', async () => {
  const template = JSON.parse(await readFile(new URL('../docs/google-sheets-template.json', import.meta.url), 'utf8'));
  const snapshot = Object.fromEntries(template.sheets.filter(s => s.title !== 'LEGGIMI').map((sheet, id) => [sheet.title, { id, columns: sheet.columns, rows: sheet.rows }]));
  assert.deepEqual(setupPlan(snapshot).changes, []);
  for (const name of ['Movimenti', 'Prodotti', 'Documenti']) assert.equal(snapshot[name].rows.length, 1);
});
