import { piConfig } from './pi-config.mjs';
// Unprivileged worker. The production CLI has fixed Pi paths and no fixture switch.
import { constants, openSync, closeSync, lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, statfs } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inspectTechnicalState, inspectServerBackupDestination, serverBackupConfig,
  verifyServerBackup, restoreBackupIsolated, type ServerBackupConfig } from '../src/lib/server-backup';
import { BackupError, backupDigest } from '../src/lib/backup-sheets';
import { aiConfiguration } from '../src/lib/ai-usage';
import { createUpdateStore } from '../src/lib/sheets-update-store';
import { homePreflight } from './home-preflight.mjs';
import { preparePiProduction, PI_TLS } from './pi-production-profile.mjs';
import { canonical } from '../src/lib/sheets-persistence-model';
import { decryptAccounts } from '../src/lib/account-backup';

const fail = (code: string): never => { throw new BackupError(code, 'Controllo backup tecnico non superato. Nessuna correzione automatica.'); };
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;


export async function dailySnapshot(config: ServerBackupConfig, configurationFiles: string[] = []) {
  await homePreflight(config.env, config.env.NODE_ENV === 'test', true);
  const first = await inspectTechnicalState(config.env);
  const ai = aiConfiguration(config.env), store = createUpdateStore(config.env);
  const technicalBytes = first.technicalBytes;
  const configurationHashes: string[] = [];
  for (const path of configurationFiles) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || (stat.mode & 0o777) !== 0o600 || await realpath(path) !== path) fail('CONFIGURATION');
    configurationHashes.push(backupDigest(await readFile(path)));
  }
  const second = await inspectTechnicalState(config.env);
  if (first.fingerprint !== second.fingerprint) fail('SOURCE_CHANGED');
  if (first.pending || first.unknownAI) fail('RECOVERY_REQUIRED');
  return { ...first, technicalBytes, configurationFingerprint: backupDigest(JSON.stringify([
    config.root, config.mount, config.env.SPESESMART_BACKUP_UUID, store.scope, ai, configurationHashes,
  ])) };
}

export async function dailyPreflight(config: ServerBackupConfig, configurationFiles: string[] = [], access: 'readonly' | 'writable' = 'writable') {
  const destination = await inspectServerBackupDestination(config, access);
  const state = await dailySnapshot(config, configurationFiles);
  if (destination.availableBytes < state.technicalBytes + 16 * 1024 * 1024) fail('SPACE');
  return { ...state, installationId: destination.installationId };
}

// Verify existing archives offline, including historical weekly payloads. No SDK
// reader, lock, writes or recovery. Partial sets are retained and reported only.
export async function backupHistory(config: ServerBackupConfig) {
  const sets: Record<string, string> = {}, partial: string[] = [];
  const repository = join(config.root, 'repository.json'), info = await lstat(repository);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()
    || (info.mode & 0o777) !== 0o600 || await realpath(repository) !== repository) fail('PERMISSIONS');
  for (const id of (await readdir(join(config.root, 'sets'))).sort()) {
    if (/^\.partial-[a-f0-9-]+$/.test(id)) { partial.push(id); continue; }
    if (!idPattern.test(id)) fail('MANIFEST');
    const directory = join(config.root, 'sets', id), manifest = await verifyServerBackup(directory);
    if (manifest.id !== id || manifest.scope !== createUpdateStore(config.env).scope) fail('MANIFEST');
    sets[id] = backupDigest(await readFile(join(directory, 'manifest.json')));
  }
  return { repositorySHA256: backupDigest(await readFile(repository)), sets, partial };
}

export function observeWriterLock(path: string) {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || (stat.mode & 0o777) !== 0o600 || realpathSync(path) !== path) fail('WRITER_LOCK');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const probe = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    if (probe.error || ![0, 1].includes(probe.status!)) fail('WRITER_LOCK');
    return probe.status === 0 ? 'FREE' : 'HELD';
  } catch { return fail('WRITER_LOCK'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function verifyDaily(config: ServerBackupConfig, id: string) {
  if (!idPattern.test(id)) fail('BACKUP_ID');
  const directory = join(config.root, 'sets', id), manifest = await verifyServerBackup(directory);
  if (manifest.id !== id || manifest.kind !== 'daily' || manifest.scope !== createUpdateStore(config.env).scope
    || manifest.files.some(file => !file.path.startsWith('technical/')) || manifest.state.pendingOperations.length || manifest.state.unknownAI) fail('MANIFEST');
  const accounts = manifest.configuration.accountsEncrypted ? canonical(await decryptAccounts(await readFile(join(directory, 'technical/accounts/accounts.enc')), config.env, manifest.scope)) : '';
  const fingerprint = backupDigest(JSON.stringify(manifest.files.filter(file => file.path !== 'technical/accounts/accounts.enc').map(file => [file.path, file.sha256]).sort()) + accounts);
  return { id, kind: manifest.kind, fingerprint, installationId: manifest.installationId, manifestSHA256: backupDigest(await readFile(join(directory, 'manifest.json'))), createdAt: manifest.createdAt };
}

export async function restoreDaily(config: ServerBackupConfig, id: string, parent: string) {
  await verifyDaily(config, id);
  const state = await dailySnapshot(config), space = await statfs(aiConfiguration(config.env).directory);
  if (space.bavail * space.bsize < state.technicalBytes + 16 * 1024 * 1024) fail('SPACE');
  // A dedicated sibling of operational storage; no merges and no deletion of old tests.
  try { await mkdir(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700
    || await realpath(parent) !== parent || stat.dev !== (await lstat(aiConfiguration(config.env).directory)).dev) fail('RESTORE_PATH');
  const directory = join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  const result = await restoreBackupIsolated(config, join(config.root, 'sets', id), directory);
  if (result.remoteRestore || result.pending || result.unknownAI) fail('RESTORE_VALIDATION');
  return { status: 'isolated-verified', remoteRestore: false };
}

function applicationListeners() {
  const result = spawnSync('ss', ['-H', '-ltn'], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) fail('LISTENERS');
  return result.stdout.split('\n').map(line => line.trim().split(/\s+/)[3]).filter((address): address is string => /:344[345]$/.test(address || ''));
}

async function main() {
  try {
    const [action, id, ...extra] = process.argv.slice(2);
    if (extra.length || !['preflight', 'preflight-readonly', 'history', 'snapshot', 'quiescent', 'running', 'verify', 'restore'].includes(action)
      || (['verify', 'restore'].includes(action) ? !idPattern.test(id || '') : id !== undefined)) fail('USAGE');
    process.chdir(fileURLToPath(new URL('..', import.meta.url)));
    Object.assign(process.env, { NODE_ENV: 'production' });
    await preparePiProduction();
    const installation = piConfig();
    const config = serverBackupConfig();
    if (config.root !== installation.backupMount + '/spesesmart' || config.mount !== installation.backupMount
      || config.env.SPESESMART_BACKUP_UUID !== installation.backupUUID) fail('CONFIGURATION');
    const configurationFiles = [installation.data + '/production.env', process.env.GOOGLE_APPLICATION_CREDENTIALS!,
      ...(process.env.SPESESMART_MULTIUSER === 'true' ? [process.env.SPESESMART_ACCOUNT_BACKUP_PUBLIC_KEY_FILE!, process.env.SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE!] : [installation.data + '/lan/access.json']),
      ...['ca.crt', 'server.crt', 'server.key'].map(name => join(PI_TLS, name))];
    let value: unknown;
    if (action === 'preflight') value = await dailyPreflight(config, configurationFiles);
    else if (action === 'preflight-readonly') value = await dailyPreflight(config, configurationFiles, 'readonly');
    else if (action === 'history') value = await backupHistory(config);
    else if (action === 'verify') value = await verifyDaily(config, id);
    else if (action === 'restore') value = await restoreDaily(config, id, installation.mount + '/backup-restore-tests');
    else {
      const state = await dailySnapshot(config, configurationFiles);
      if (action !== 'snapshot') {
        const writer = observeWriterLock(join(config.runtime, 'writer.lock')), listeners = applicationListeners();
        if (action === 'quiescent' && (writer !== 'FREE' || listeners.length)) fail('BUSY');
        if (action === 'running' && (writer !== 'HELD' || !listeners.includes(`${installation.ip}:3443`)
          || !listeners.includes('127.0.0.1:3444') || listeners.some(address => ![`${installation.ip}:3443`, '127.0.0.1:3444', '127.0.0.1:3445'].includes(address))
          || new Set(listeners).size !== listeners.length)) fail('LISTENERS');
      }
      value = state;
    }
    console.log(JSON.stringify({ status: 'PASS', ...(value as object) }));
  } catch (error) {
    console.log(JSON.stringify({ status: 'BLOCK', code: error instanceof BackupError ? error.code : 'VALIDATION' }));
    process.exitCode = 1;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
