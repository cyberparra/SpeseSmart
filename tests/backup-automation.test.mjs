import { renderPiService } from '../scripts/pi-install.mts';
import { fixturePiConfig } from './helpers/pi-config.mjs';
import './helpers/isolated-host-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dailyPreflight, dailySnapshot, verifyDaily, restoreDaily, observeWriterLock, backupHistory } from '../scripts/pi-backup-worker.mts';
import { serverBackupConfig, initializeBackupRoot, createServerBackup, verifyServerBackup, validateWritableBackupMount, validateReadonlyBackupMount } from '../src/lib/server-backup.ts';
import { initializeAI, aiConfiguration, controlledAnalysis } from '../src/lib/ai-usage.ts';
import { createUpdateStore } from '../src/lib/sheets-update-store.ts';
import { withHomeWriterLock } from '../scripts/home-runtime.mjs';
import { demoReceipt } from '../src/lib/receipts/demo.ts';

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), 'spesesmart-daily-automation-'));
  await chmod(root, 0o700);
  const env = { NODE_ENV: 'test', GOOGLE_SHEETS_SPREADSHEET_ID: 'synthetic-fixture',
    SPESESMART_AI_DATA_DIR: join(root, 'ai'), SPESESMART_SHEETS_UPDATE_DIR: join(root, 'sheets'),
    SPESESMART_BACKUP_ROOT: join(root, 'backups'), SPESESMART_BACKUP_MOUNT: root,
    SPESESMART_BACKUP_UUID: '11111111-2222-4333-8444-555555555555' };
  const config = { ...serverBackupConfig(env), runtime: join(root, 'runtime') };
  try {
    await initializeAI(aiConfiguration(env)); await createUpdateStore(env).lock(async () => {});
    await controlledAnalysis(Buffer.from('synthetic cache'), false, async () => ({ receipt: demoReceipt,
      usage: { input: 4000, cached: 1000, output: 1500 }, model: 'gpt-4.1-mini', completed: true }), aiConfiguration(env));
    await mkdir(config.root, { mode: 0o700 }); await initializeBackupRoot(config, true);
    await work({ root, env, config });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('automazione: mount readonly, opzioni mancanti o filesystem errato bloccano prima dello stop', () => {
  validateWritableBackupMount({ fstype: 'ext4', options: 'rw,nosuid,nodev,noexec,relatime' });
  for (const mount of [{ fstype: 'ext4', options: 'ro,nosuid,nodev,noexec' }, { fstype: 'ext4', options: 'rw' },
    { fstype: 'ext4', options: 'rw,nosuid,nodev,noexec,noload' }, { fstype: 'ext4', options: 'rw,nosuid,nodev,noexec,norecovery' },
    { fstype: 'ext4' }, { fstype: 'xfs', options: 'rw,nosuid,nodev,noexec' }]) {
    assert.throws(() => validateWritableBackupMount(mount), { code: 'BACKUP_MOUNT' });
  }
  validateReadonlyBackupMount({ fstype: 'ext4', options: 'ro,nosuid,nodev,noexec,norecovery' });
  for (const options of ['rw,nosuid,nodev,noexec', 'ro', 'ro,rw,nosuid,nodev,noexec']) {
    assert.throws(() => validateReadonlyBackupMount({ fstype: 'ext4', options }), { code: 'BACKUP_MOUNT' });
  }
});

test('automazione: preparazione readonly e inventario storico non modificano set o registri', () => fixture(async f => {
  const old = await createServerBackup(f.config, 'daily');
  const first = await backupHistory(f.config), ledger = await readFile(join(f.env.SPESESMART_AI_DATA_DIR, 'usage.json'));
  await dailyPreflight(f.config, [], 'readonly');
  assert.deepEqual(await backupHistory(f.config), first);
  const fresh = await createServerBackup(f.config, 'daily');
  const second = await backupHistory(f.config);
  assert.equal(second.repositorySHA256, first.repositorySHA256);
  assert.equal(second.sets[old.id], first.sets[old.id]);
  assert.ok(second.sets[fresh.id]);
  assert.deepEqual(await readFile(join(f.env.SPESESMART_AI_DATA_DIR, 'usage.json')), ledger);
}));

test('automazione: inventario conserva partial e rifiuta payload storico corrotto', () => fixture(async f => {
  const old = await createServerBackup(f.config, 'daily');
  const partial = join(f.config.root, 'sets', '.partial-11111111-2222-4333-8444-555555555555');
  await mkdir(partial, { mode: 0o700 });
  assert.equal((await backupHistory(f.config)).partial.length, 1);
  assert.deepEqual(await readdir(partial), []);
  await writeFile(join(old.directory, 'technical/ai/usage.json'), '{}');
  await assert.rejects(backupHistory(f.config), { code: 'CHECKSUM' });
  assert.equal(await readFile(join(old.directory, 'technical/ai/usage.json'), 'utf8'), '{}');
}));

test('automazione: preflight readonly, daily ufficiale, verifica e restore tecnico con byte operativi invariati', () => fixture(async f => {
  const ledger = join(f.env.SPESESMART_AI_DATA_DIR, 'usage.json'), before = await readFile(ledger);
  // An existing archive is preserved even though automation neither reads nor rotates it.
  const historical = join(f.config.root, 'sets', 'historical-weekly'); await mkdir(historical, { mode: 0o700 });
  await writeFile(join(historical, 'preserve.bin'), 'historical bytes', { mode: 0o600 });
  const initialTree = await readdir(f.config.root);
  const initial = await dailyPreflight(f.config);
  assert.deepEqual(await readdir(f.config.root), initialTree);
  const created = await createServerBackup(f.config, 'daily', { readFinancial() { assert.fail('No financial API call permitted'); } });
  const verified = await verifyDaily(f.config, created.id);
  assert.equal(verified.fingerprint, initial.fingerprint);
  const manifest = await verifyServerBackup(created.directory);
  assert.ok(manifest.files.some(file => file.path.endsWith('.cache.json')));
  assert.ok(manifest.files.every(file => file.path.startsWith('technical/')));
  const result = await restoreDaily(f.config, created.id, join(f.root, 'isolated-tests'));
  assert.deepEqual(result, { status: 'isolated-verified', remoteRestore: false });
  assert.equal((await dailySnapshot(f.config)).fingerprint, initial.fingerprint);
  assert.deepEqual(await readFile(ledger), before);
  assert.equal(await readFile(join(historical, 'preserve.bin'), 'utf8'), 'historical bytes');
}));

test('automazione: writer attivo non viene aggirato neppure per daily o restore', () => fixture(async f => {
  const created = await createServerBackup(f.config, 'daily');
  await withHomeWriterLock(async () => {
    assert.equal(observeWriterLock(join(f.config.runtime, 'writer.lock')), 'HELD');
    await dailyPreflight(f.config); // Inspection is permitted while serving.
    await assert.rejects(createServerBackup(f.config, 'daily'), /già attivo/);
    await assert.rejects(restoreDaily(f.config, created.id, join(f.root, 'isolated-tests')), /già attivo/);
  }, f.config.runtime);
  assert.equal(observeWriterLock(join(f.config.runtime, 'writer.lock')), 'FREE');
}));

test('automazione: .partial e consumi sconosciuti conservati e bloccanti, nessuna riconciliazione', () => fixture(async f => {
  const partial = join(f.config.root, 'sets', '.partial-interrupted'); await mkdir(partial, { mode: 0o700 });
  await assert.rejects(dailyPreflight(f.config), { code: 'PARTIAL_PRESENT' });
  assert.deepEqual(await readdir(partial), []);
  // Removal is confined to this synthetic fixture to exercise the next condition.
  await rm(partial, { recursive: true });
  await assert.rejects(controlledAnalysis(Buffer.from('unknown fixture'), false, async () => { throw Error('synthetic timeout'); }, aiConfiguration(f.env)));
  const ledger = join(f.env.SPESESMART_AI_DATA_DIR, 'usage.json'), before = await readFile(ledger);
  await assert.rejects(dailyPreflight(f.config), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(await readFile(ledger), before);
}));

test('automazione: restore rifiuta copia obsoleta, checksum alterato e parent con symlink', () => fixture(async f => {
  const old = await createServerBackup(f.config, 'daily');
  await controlledAnalysis(Buffer.from('newer fixture'), false, async () => ({ receipt: demoReceipt,
    usage: { input: 4000, cached: 1000, output: 1500 }, model: 'gpt-4.1-mini', completed: true }), aiConfiguration(f.env));
  await assert.rejects(restoreDaily(f.config, old.id, join(f.root, 'stale-test')), { code: 'STALE_LEDGER' });
  const fresh = await createServerBackup(f.config, 'daily');
  const real = join(f.root, 'real-parent'); await mkdir(real, { mode: 0o700 });
  const link = join(f.root, 'linked-parent'); await symlink(real, link);
  await assert.rejects(restoreDaily(f.config, fresh.id, link), { code: 'RESTORE_PATH' });
  await writeFile(join(fresh.directory, 'technical/ai/usage.json'), '{}');
  await assert.rejects(verifyDaily(f.config, fresh.id), { code: 'CHECKSUM' });
}));

test('automazione: lock osservato non viene creato se assente', () => fixture(async f => {
  await assert.rejects(async () => observeWriterLock(join(f.root, 'missing.lock')), { code: 'WRITER_LOCK' });
  assert.ok(!(await readdir(f.root)).includes('missing.lock'));
}));

test('automazione: CLI worker non offre weekly, percorsi arbitrari o bypass fixture', () => {
  for (const args of [['weekly'], ['restore', '../../elsewhere'], ['preflight', '--fixture']]) {
    const result = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/pi-backup-worker.mts', ...args], {
      encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', TSX_DISABLE_CACHE: '1' }, timeout: 30000,
    });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'BLOCK', code: 'USAGE' });
  }
});

test('automazione: coordinatore e timer passano fixture systemd, errori, crash e ripartenze condizionate', () => {
  const result = spawnSync('/usr/bin/python3', ['-I', '-B', fileURLToPath(new URL('./helpers/pi-backup-fixtures.py', import.meta.url))], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 50 tests/);
  assert.match(result.stderr, /\bOK\b/);
});

test('automazione: timer senza catch-up e unità con namespace host, senza esportazioni o dipendenze production', async () => {
  const service = await readFile(new URL('../docs/spesesmart-backup-daily.service.example', import.meta.url), 'utf8');
  const timer = await readFile(new URL('../docs/spesesmart-backup-daily.timer.example', import.meta.url), 'utf8');
  assert.match(timer, /^OnCalendar=\*-\*-\* 03:15:00 Europe\/Rome$/m);
  assert.match(timer, /^Persistent=false$/m);
  assert.doesNotMatch(timer, /^OnBootSec=|^OnStartupSec=|^Persistent=true/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/python3 -I -B \/usr\/local\/libexec\/spesesmart\/pi-backup-coordinator.py$/m);
  for (const directive of ['Restart=no', 'KillSignal=SIGTERM', 'SendSIGKILL=no', 'RestrictAddressFamilies=AF_UNIX AF_NETLINK', 'IPAddressDeny=any']) assert.ok(service.split('\n').includes(directive));
  assert.doesNotMatch(service, /^(?:Exec\w+=.*(?:weekly|prune|rotation|mount)|Conflicts=|(?:Requires|Wants|After|Before)=.*spesesmart-pi\.service|EnvironmentFile=)/m);
  assert.doesNotMatch(service, /^(?:PrivateMounts|PrivateTmp|ProtectSystem|ProtectHome|ReadOnlyPaths|ReadWritePaths|InaccessiblePaths)=/m);
  for (const args of [[], ['--first-trial'], ['--first-trial', '--fixture'], ['--now=Sunday'], ['--usb=/dev/sda']]) {
    const python = spawnSync('/usr/bin/python3', ['-I', '-B', 'scripts/pi-backup-coordinator.py', ...args], { encoding: 'utf8' });
    assert.equal(python.status, 1);
    assert.equal(JSON.parse(python.stdout).code, 'INSTALLATION_REQUIRED');
  }
});

test('automazione: systemd valida staticamente unità e calendario, senza installazione o avvio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spesesmart-backup-unit-fixture-'));
  try {
    const paths = [];
    for (const suffix of ['service', 'timer']) {
      const source = suffix === 'service' ? renderPiService(fixturePiConfig, '/etc/spesesmart/pi.json', 'backup') : await readFile(new URL(`../docs/spesesmart-backup-daily.${suffix}.example`, import.meta.url));
      const path = join(root, `spesesmart-backup-daily.${suffix}`); await writeFile(path, source); paths.push(path);
    }
    const mount = join(root, 'srv-spesesmart.mount');
    await writeFile(mount, '[Mount]\nWhat=/dev/disk/by-uuid/11111111-2222-4333-8444-555555555555\nWhere=/srv/spesesmart\nType=ext4\n');
    const verify = spawnSync('systemd-analyze', ['verify', '--man=no', ...paths, mount], { encoding: 'utf8', timeout: 30000 });
    assert.equal(verify.status, 0, verify.stderr);
    const calendar = spawnSync('systemd-analyze', ['calendar', '*-*-* 03:15:00 Europe/Rome'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(calendar.status, 0, calendar.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});
