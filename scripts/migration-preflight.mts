import { piConfig } from './pi-config.mjs';
// Read-only observations, never an authorization, migration or financial API call.
import nextEnvironment from '@next/env';
import { hostname, arch, userInfo } from 'node:os';
import { join } from 'node:path';
import { openSync, closeSync, constants, lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readHostPolicy } from './host-policy.mjs';
import { migrationHardwareCheck } from './pi-migration-check.mjs';
import { privatePiDirectory, validatePiEnvironment, piProductionTLS } from './pi-production-profile.mjs';
import { homeRuntimeDirectory } from './home-runtime.mjs';
import { homePreflight } from './home-preflight.mjs';
import { inspectTechnicalState, verifyServerBackup } from '../src/lib/server-backup';
export type Check = { check: string; status: 'PASS' | 'BLOCK' | 'MANUAL CHECK' | 'NOT VERIFIED'; detail: string };
export function recoveryCheck(pending: number, unknownAI: number): Check {
  return { check: 'recovery', status: pending || unknownAI ? 'MANUAL CHECK' : 'PASS',
    detail: `Journal pendenti: ${pending}; consumi AI sconosciuti: ${unknownAI}. Nessuna ripresa automatica.` };
}
export function observedLock(path: string): Check {
  let fd: number | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || realpathSync(path) !== path) throw Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const result = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    return result.status === 0 ? { check: 'local-lock', status: 'PASS', detail: 'Lock locale libero al momento del controllo; non prova assenza di altri writer.' }
      : { check: 'local-lock', status: 'BLOCK', detail: 'Lock occupato o non verificabile: non trasferire registri.' };
  } catch { return { check: 'local-lock', status: 'NOT VERIFIED', detail: 'Lock assente o non verificabile; nessun file creato.' }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export async function migrationPreflight(role: string, backup?: string): Promise<Check[]> {
  if (!['pc', 'pi'].includes(role)) throw Error('Ruolo richiesto pc o pi.');
  const checks: Check[] = [];
  checks.push({ check: 'identity', status: role === 'pi' && (arch() !== 'arm64') ? 'BLOCK' : 'MANUAL CHECK', detail: `Host osservato ${hostname()}, ${arch()}; confermare fisicamente il ruolo ${role}.` });
  const policy = readHostPolicy();
  checks.push({ check: 'policy', status: !policy.valid || (role === 'pi' && (!policy.configured || policy.role !== 'raspberry')) ? 'BLOCK' : policy.configured && policy.role === 'disabled' ? 'PASS' : 'MANUAL CHECK', detail: `Policy locale: ${policy.role}; configurata: ${policy.configured}. Nessuna abilitazione eseguita.` });
  checks.push(observedLock(join(homeRuntimeDirectory(), 'writer.lock')));
  if (role === 'pi') {
    try {
      await migrationHardwareCheck();
      const data = piConfig().data;
      for (const name of ['', '/ai', '/sheets-updates', '/lan', '/runtime']) await privatePiDirectory(data + name);
      const path = join(data, 'production.env'), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || realpathSync(path) !== path) throw Error();
      process.loadEnvFile(path); validatePiEnvironment(process.env);
      checks.push({ check: 'ssd-config', status: 'PASS', detail: 'SSD, directory e percorsi configurati validati.' });
    } catch { checks.push({ check: 'ssd-config', status: 'BLOCK', detail: 'SSD, dati o configurazione ancora mancanti/non validi.' }); }
    try { await piProductionTLS(piConfig().ip); checks.push({ check: 'tls', status: 'PASS', detail: 'CA, leaf, SAN, usi, chiave e permessi verificati offline.' }); }
    catch { checks.push({ check: 'tls', status: 'BLOCK', detail: 'TLS operativo non verificato.' }); }
  } else nextEnvironment.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  process.env.SPESESMART_SHEETS_UPDATE_DIR ||= join(userInfo().homedir, '.local/share/spesesmart/sheets-updates');
  try {
    await homePreflight(process.env, false, true);
    const first = await inspectTechnicalState(process.env), second = await inspectTechnicalState(process.env);
    if (first.fingerprint !== second.fingerprint) throw Error();
    checks.push({ check: 'technical-state', status: 'PASS', detail: 'Schema, checksum, marker, journal, ledger e cache leggibili; nessuna modifica.' }, recoveryCheck(first.pending, first.unknownAI));
  } catch { checks.push({ check: 'technical-state', status: 'BLOCK', detail: 'Registri mancanti, non validi o modificati durante la lettura; nessuna correzione automatica.' }); }
  try {
    const result = spawnSync('findmnt', ['-J', '-M', process.env.SPESESMART_BACKUP_MOUNT || '', '-o', 'TARGET,FSTYPE,UUID,OPTIONS'], { encoding: 'utf8', timeout: 5000 });
    const disk = JSON.parse(result.stdout).filesystems;
    if (disk.length !== 1 || disk[0].target !== process.env.SPESESMART_BACKUP_MOUNT || disk[0].uuid !== process.env.SPESESMART_BACKUP_UUID || disk[0].fstype !== 'ext4' || !String(disk[0].options).split(',').includes('ro')) throw Error();
    checks.push({ check: 'usb', status: 'PASS', detail: 'Supporto backup UUID atteso montata readonly.' });
  } catch { checks.push({ check: 'usb', status: 'NOT VERIFIED', detail: 'Supporto backup readonly non verificata su questo host.' }); }
  if (backup) {
    try { await verifyServerBackup(backup); checks.push({ check: 'backup-integrity', status: 'PASS', detail: 'Manifest e payload integri; attualità del set non provata.' }); }
    catch { checks.push({ check: 'backup-integrity', status: 'BLOCK', detail: 'Backup indicato non valido.' }); }
  } else checks.push({ check: 'backup-integrity', status: 'NOT VERIFIED', detail: 'Nessun set finale indicato.' });
  checks.push({ check: 'final-backup-freshness', status: 'MANUAL CHECK', detail: 'Occorre backup finale creato dopo arresto PC e confronto con ultimo ledger, senza altre scritture.' },
    { check: 'other-host', status: 'NOT VERIFIED', detail: 'Questo comando non osserva né autorizza l’altro host. Eseguire entrambi i preflight e verificare arresto/policy amministrativamente.' },
    { check: 'sheets', status: 'NOT VERIFIED', detail: 'Nessuna API contattata. Confronto readonly remoto e recovery delle versioni da eseguire successivamente.' });
  return checks;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [role, backup, ...extra] = process.argv.slice(2); if (extra.length) throw Error();
    const checks = await migrationPreflight(role, backup);
    console.log(JSON.stringify({ readOnly: true, operationalAuthorized: false, checks }, null, 2));
    if (checks.some(c => c.status === 'BLOCK')) process.exitCode = 1;
    else if (checks.some(c => c.status !== 'PASS')) process.exitCode = 2;
  } catch { console.error('Preflight non eseguito: usare migration:preflight -- pc|pi [percorso-assoluto-set]. Nessun trasferimento o avvio.'); process.exitCode = 1; }
}
