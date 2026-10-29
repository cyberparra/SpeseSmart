// Read-only hardware preparation; deliberately grants no operational capability.
import { execFileSync } from 'node:child_process';
import { lstat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { piConfig } from './pi-config.mjs';
export function validateMigrationMount(result, config = piConfig()) {
  const rows = result?.filesystems;
  if (!Array.isArray(rows) || rows.length !== 1) throw Error('SSD assente o ambiguo.');
  const disk = rows[0], options = String(disk.options).split(',');
  if (disk.target !== config.mount || disk.uuid !== config.ssdUUID || disk.fstype !== 'ext4'
    || !options.includes('rw') || options.includes('ro')) throw Error('SSD diverso o non scrivibile.');
}
export async function migrationHardwareCheck() {
  if (process.platform !== 'linux' || process.arch !== 'arm64' || process.env.VERCEL) throw Error('Ambiente Raspberry non valido.');
  const config = piConfig();
  validateMigrationMount(JSON.parse(execFileSync('findmnt', ['-J', '-M', config.mount, '-o', 'TARGET,FSTYPE,UUID,OPTIONS'], { encoding: 'utf8', timeout: 5000 })), config);
  const path = config.app, stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) || await realpath(path) !== path) throw Error('Directory applicazione non sicura.');
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  return { hardware: 'verified', operationalAuthorized: false };
}
async function main() {
  try { console.log(JSON.stringify(await migrationHardwareCheck())); }
  catch { console.error('Preparazione Raspberry fallita: verificare architettura, mount SSD UUID e permessi. Nessun writer autorizzato.'); process.exitCode = 1; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
