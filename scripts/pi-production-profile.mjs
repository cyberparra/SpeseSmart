import { userInfo } from 'node:os';
import { lstat, realpath, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { migrationHardwareCheck } from './pi-migration-check.mjs';
import { requireHostRole } from './host-policy.mjs';
import { loadPiTLS } from './pi-tls.mjs';
import { readAccounts } from './accounts.mjs';
import { piConfig } from './pi-config.mjs';
export let PI_DATA, PI_CA, PI_TLS;
function configure(config = piConfig()) { PI_DATA = config.data; PI_CA = config.caSHA256; PI_TLS = config.tlsDirectory; return config; }
export async function privatePiDirectory(path, root = piConfig().mount) {
  if (resolve(path) !== path || !(path === root || path.startsWith(root + '/'))) throw Error('Percorso Pi errato.');
  const device = (await lstat(root)).dev;
  for (let current = path; current !== root; current = dirname(current)) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== device || stat.uid !== process.getuid()
      || (stat.mode & 0o777) !== 0o700 || await realpath(current) !== current) throw Error('Directory persistente Pi non privata o fuori SSD.');
  }
}
export function validatePiEnvironment(env, config = piConfig(env)) {
  configure(config);
  for (const [key, value] of Object.entries({ SPESESMART_AI_DATA_DIR: `${PI_DATA}/ai`, SPESESMART_SHEETS_UPDATE_DIR: `${PI_DATA}/sheets-updates`, SPESESMART_LAN_DIR: `${PI_DATA}/lan` })) {
    if (env[key] !== value) throw Error('Percorsi persistenti Pi obbligatori.');
  }
  if (env.VERCEL || env.SPESESMART_LAN_READ_ONLY === 'true') throw Error('Profilo operativo Pi non valido.');
  if (env.SPESESMART_MULTIUSER === 'true') {
    for (const [key, value] of Object.entries({ SPESESMART_ACCOUNT_DIR: `${PI_DATA}/accounts`, SPESESMART_PREFERENCES_DIR: `${PI_DATA}/preferences`,
      SPESESMART_ACCOUNT_BACKUP_PUBLIC_KEY_FILE: `${PI_DATA}/credentials/account-backup-public.pem`,
      SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE: `${PI_DATA}/credentials/account-backup-private.pem` })) {
      if (env[key] !== value) throw Error('Percorsi multiutente Pi obbligatori.');
    }
  }
}
export async function preparePiSetup() {
  const config = configure();
  await migrationHardwareCheck();
  if (config.user !== userInfo().username || config.home !== userInfo().homedir || await realpath(config.node) !== await realpath(process.execPath)) throw Error('Utente o Node diversi dalla configurazione Pi.');
  if (process.cwd() !== config.app || await realpath(process.cwd()) !== process.cwd()) throw Error('Applicazione Pi non canonica.');
  await privatePiDirectory(PI_DATA);
  process.env.SPESESMART_LAN_DIR = `${PI_DATA}/lan`;
}
export async function preparePiProduction() {
  const config = configure();
  await migrationHardwareCheck();
  if (config.user !== userInfo().username || config.home !== userInfo().homedir || await realpath(config.node) !== await realpath(process.execPath)) throw Error('Utente o Node diversi dalla configurazione Pi.');
  if (await realpath(process.cwd()) !== config.app || process.cwd() !== config.app) throw Error('Applicazione Pi non canonica.');
  requireHostRole('raspberry');
  // Explicit private server-side file, never in the application repository.
  await privatePiDirectory(PI_DATA);
  const path = join(PI_DATA, 'production.env'), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || await realpath(path) !== path) throw Error('Configurazione Pi non privata.');
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    try { await access(`${config.app}/${name}`); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw Error('Configurazione reale vietata nel repository Pi.');
  }
  process.loadEnvFile(path);
  validatePiEnvironment(process.env);
  if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID || !process.env.GOOGLE_APPLICATION_CREDENTIALS) throw Error('Credenziali server non configurate.');
  const credential = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (resolve(credential) !== credential || !credential.startsWith(`${PI_DATA}/`)) throw Error('Credenziale Google fuori dalla directory dati.');
  await privatePiDirectory(dirname(credential));
  const credentialStat = await lstat(credential);
  if (!credentialStat.isFile() || credentialStat.isSymbolicLink() || credentialStat.uid !== process.getuid() || (credentialStat.mode & 0o777) !== 0o600 || await realpath(credential) !== credential) throw Error('Credenziale Google non privata.');
  for (const name of ['ai', 'sheets-updates', 'lan', 'runtime']) await privatePiDirectory(join(PI_DATA, name));
  if (process.env.SPESESMART_MULTIUSER === 'true') {
    for (const name of ['accounts', 'preferences', 'credentials']) await privatePiDirectory(join(PI_DATA, name));
    const registry = await readAccounts(process.env.SPESESMART_ACCOUNT_DIR);
    if (!registry.accounts.some(account => account.active && account.role === 'admin')) throw Error('Amministratore attivo richiesto.');
  }
  process.env.SPESESMART_PI_PRODUCTION = 'true';
  process.env.SPESESMART_LAN_PORT = '3443';
  process.env.SPESESMART_LAN_UPSTREAM_PORT = '3444';
}
export async function piProductionTLS(ip) {
  configure();
  if (ip !== piConfig().ip) throw Error('IP Pi cambiato: rivalidare SAN e configurazione.');
  return loadPiTLS(PI_TLS, ip, PI_CA);
}
