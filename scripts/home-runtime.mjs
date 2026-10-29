// Private, per-user lifetime lock shared by dev and both operational LAN modes.
import { constants, fstatSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostOperationsAllowed, requireHostRole } from './host-policy.mjs';
import { piConfig } from './pi-config.mjs';
import { validateMigrationMount } from './pi-migration-check.mjs';
import { createHash } from 'node:crypto';

export const homeRuntimeDirectory = () => join(homedir(), '.local/share/spesesmart/runtime');
const privateStat = (stat, directory = false) => !stat.isSymbolicLink?.()
  && (directory ? stat.isDirectory() : stat.isFile()) && stat.uid === process.getuid()
  && (stat.mode & 0o777) === (directory ? 0o700 : 0o600);

export async function withHomeWriterLock(action, directory = homeRuntimeDirectory()) {
  await mkdir(/*turbopackIgnore: true*/ directory, { recursive: true, mode: 0o700 });
  if (await realpath(/*turbopackIgnore: true*/ directory) !== resolve(/*turbopackIgnore: true*/ directory) || !privateStat(lstatSync(/*turbopackIgnore: true*/ directory), true)) throw Error('Directory runtime domestica non privata.');
  const path = join(directory, 'writer.lock');
  const file = await open(/*turbopackIgnore: true*/ path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!privateStat(await file.stat())) throw Error('Lock writer domestico non privato.');
    const result = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', file.fd] });
    if (result.error || result.status !== 0) throw Error('Un server finanziario è già attivo. Ferma dev/lan:operate/lan:production prima di riprovare.');
    return await action(file.fd, directory);
  } finally { await file.close(); }
}

export async function writeHomeProof(directory, value) {
  const path = join(directory, 'production.json');
  // A stale proof cannot authorize a new backend: capability and parent PID differ.
  await unlink(/*turbopackIgnore: true*/ path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const file = await open(/*turbopackIgnore: true*/ path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  const folder = await open(/*turbopackIgnore: true*/ directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await folder.sync(); } finally { await folder.close(); }
  return path;
}

// This check grants only the explicitly launched home-production profile.
// FD 3 is inherited from the launcher, keeps the writer lock across parent failure.
export function homeProductionReady(env = process.env) {
  try {
    if (process.platform !== 'linux' || env.VERCEL || env.NODE_ENV !== 'production'
      || env.SPESESMART_HOME_PRODUCTION !== 'true') return false;
    if (!hostOperationsAllowed()) return false;
    const pi = env.SPESESMART_PI_PRODUCTION === 'true';
    const config = pi ? piConfig(env) : null;
    if (pi) {
      requireHostRole('raspberry');
      if (process.arch !== 'arm64') return false;
      const mount = spawnSync('findmnt', ['-J', '-M', config.mount, '-o', 'TARGET,FSTYPE,UUID,OPTIONS'], { encoding: 'utf8', timeout: 5000 });
      if (mount.status !== 0) return false;
      validateMigrationMount(JSON.parse(mount.stdout), config);
      if (env.SPESESMART_AI_DATA_DIR !== `${config.data}/ai` || env.SPESESMART_SHEETS_UPDATE_DIR !== `${config.data}/sheets-updates`) return false;
    }
    const directory = pi ? `${config.data}/runtime` : homeRuntimeDirectory(), path = join(directory, 'production.json');
    if (env.SPESESMART_HOME_PROOF !== path || realpathSync(/*turbopackIgnore: true*/ directory) !== directory
      || !privateStat(lstatSync(/*turbopackIgnore: true*/ directory), true) || !privateStat(lstatSync(/*turbopackIgnore: true*/ path))) return false;
    const proof = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, 'utf8'));
    if (proof.multiuser === true || env.SPESESMART_MULTIUSER === 'true') {
      if (proof.multiuser !== true || env.SPESESMART_MULTIUSER !== 'true'
        || proof.accountDirectory !== env.SPESESMART_ACCOUNT_DIR || proof.preferencesDirectory !== env.SPESESMART_PREFERENCES_DIR) return false;
      for (const base of [proof.accountDirectory, proof.preferencesDirectory]) {
        if (!base || realpathSync(base) !== base || !privateStat(lstatSync(base), true)) return false;
      }
    }
    const inherited = fstatSync(3), lock = lstatSync(/*turbopackIgnore: true*/ join(homeRuntimeDirectory(), 'writer.lock'));
    if (!privateStat(inherited) || !privateStat(lock) || inherited.ino !== lock.ino || inherited.dev !== lock.dev) return false;
    const probe = spawnSync('flock', ['--exclusive', '--nonblock', join(homeRuntimeDirectory(), 'writer.lock'), 'true'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 1) return false; // Lock must already be held.
    if (!Number.isInteger(proof.pid) || proof.pid < 1) return false;
    process.kill(proof.pid, 0);
    const scope = createHash('sha256').update(env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() ?? '').digest('hex');
    if ((pi && proof.pi !== true) || proof.version !== 1 || proof.capability !== env.SPESESMART_LAN_CAPABILITY
      || proof.origin !== env.SPESESMART_LAN_ORIGIN || proof.port !== env.SPESESMART_LAN_INTERNAL_PORT
      || proof.scope !== scope || proof.aiDirectory !== resolve(/*turbopackIgnore: true*/ env.SPESESMART_AI_DATA_DIR || join(homedir(), '.local/share/spesesmart/ai'))
      || proof.updateDirectory !== resolve(/*turbopackIgnore: true*/ env.SPESESMART_SHEETS_UPDATE_DIR || join(homedir(), '.local/share/spesesmart/sheets-updates'))) return false;
    for (const base of [proof.aiDirectory, proof.updateDirectory, join(proof.updateDirectory, scope)]) {
      if (realpathSync(/*turbopackIgnore: true*/ base) !== base || !privateStat(lstatSync(/*turbopackIgnore: true*/ base), true)) return false;
    }
    const marker = join(proof.updateDirectory, `${scope}.initialized`);
    return privateStat(lstatSync(/*turbopackIgnore: true*/ join(proof.aiDirectory, 'usage.json')))
      && privateStat(lstatSync(/*turbopackIgnore: true*/ marker)) && readFileSync(/*turbopackIgnore: true*/ marker, 'utf8') === scope;
  } catch { return false; }
}
