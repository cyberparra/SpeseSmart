// Offline bootstrap only. An exclusive installation marker prevents lost state resets.
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { migrationHardwareCheck } from './pi-migration-check.mjs';
import { withHomeWriterLock } from './home-runtime.mjs';
import { privateLANFile } from './lan-credentials.mjs';
import { piConfig } from './pi-config.mjs';
import { privatePiDirectory } from './pi-production-profile.mjs';
import { initializeAccounts } from './accounts.mjs';
import { initializePreferences } from '../src/lib/user-preferences';
import { initializeAI, aiConfiguration } from '../src/lib/ai-usage';
import { createUpdateStore } from '../src/lib/sheets-update-store';

export function installationEnvironment(config: ReturnType<typeof piConfig>) {
  return {
    SPESESMART_MULTIUSER: 'true',
    SPESESMART_AI_DATA_DIR: `${config.data}/ai`, SPESESMART_SHEETS_UPDATE_DIR: `${config.data}/sheets-updates`,
    SPESESMART_LAN_DIR: `${config.data}/lan`, SPESESMART_ACCOUNT_DIR: `${config.data}/accounts`,
    SPESESMART_PREFERENCES_DIR: `${config.data}/preferences`,
    SPESESMART_ACCOUNT_BACKUP_PUBLIC_KEY_FILE: `${config.data}/credentials/account-backup-public.pem`,
    SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE: `${config.data}/credentials/account-backup-private.pem`,
    GOOGLE_APPLICATION_CREDENTIALS: `${config.data}/credentials/google.json`,
    GOOGLE_SHEETS_SPREADSHEET_ID: '', OPENAI_API_KEY: '', OPENAI_RECEIPT_MODEL: 'gpt-4.1-mini',
    SPESESMART_AI_MONTHLY_USD: '2', SPESESMART_AI_MAX_ANALYSES: '100',
    SPESESMART_AI_TARIFF_JSON: '{"input":0.4,"cachedInput":0.1,"output":1.6}',
    ...(config.backupMount ? { SPESESMART_BACKUP_MOUNT: config.backupMount, SPESESMART_BACKUP_ROOT: config.backupMount + '/spesesmart', SPESESMART_BACKUP_UUID: config.backupUUID } : {}),
  };
}
export async function initializeInstallation(config: ReturnType<typeof piConfig>, env: NodeJS.ProcessEnv) {
  const expected = installationEnvironment(config);
  for (const [key, value] of Object.entries(expected)) if (key.endsWith('_DIR') || key.includes('_KEY_FILE')) {
    if (env[key] !== value) throw Error('Percorsi bootstrap diversi dalla configurazione.');
  }
  if (env.SPESESMART_MULTIUSER !== 'true' || !env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim()) throw Error('Configurare foglio e multiutente.');
  await privatePiDirectory(config.data, config.mount);
  await privatePiDirectory(join(config.data, 'credentials'), config.mount);
  const names = ['accounts', 'preferences', 'ai', 'sheets-updates', 'lan', 'runtime'];
  for (const name of [...names, 'credentials/account-backup-public.pem', 'credentials/account-backup-private.pem']) {
    try { await lstat(join(config.data, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw Error('Bootstrap consentito soltanto con directory di stato nuove.');
  }
  const marker = await open(join(config.data, 'installation.json'), 'wx', 0o600);
  try { await marker.writeFile(JSON.stringify({ version: 1, status: 'initialization-started' })); await marker.sync(); } finally { await marker.close(); }
  const directory = await open(config.data, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  // Leave the marker on any failure: never retry initialization of partial/lost state.
  for (const name of names) await mkdir(join(config.data, name), { mode: 0o700 });
  await initializeAccounts(env.SPESESMART_ACCOUNT_DIR);
  await initializePreferences(env);
  await initializeAI(aiConfiguration(env));
  await createUpdateStore(env).lock(async () => {});
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  for (const [name, text] of [['public', pair.publicKey], ['private', pair.privateKey]]) {
    const file = await open(join(config.data, 'credentials', `account-backup-${name}.pem`), 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  }
  const credentials = await open(join(config.data, 'credentials'), 'r');
  try { await credentials.sync(); } finally { await credentials.close(); }
}
export function renderPiService(config: ReturnType<typeof piConfig>, configPath: string, kind: 'production' | 'backup' = 'production') {
  const template = readFileSync(new URL(kind === 'backup' ? '../docs/spesesmart-backup-daily.service.example' : '../docs/spesesmart-pi.service.example', import.meta.url), 'utf8');
  const values = { ...config, configPath, mountUnit: execFileSync('systemd-escape', ['--path', '--suffix=mount', config.mount], { encoding: 'utf8' }).trim() };
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(configPath)) throw Error('Percorso configurazione non valido per systemd.');
  return template.replace(/@([a-zA-Z]+)@/g, (_, key: keyof typeof values) => {
    if (!values[key]) throw Error('Parametro systemd mancante.');
    return String(values[key]);
  });
}
async function main() {
  if (process.argv.length !== 3) throw Error('Un solo sottocomando richiesto.');
  const config = piConfig();
  if (['env', 'init'].includes(process.argv[2] || '')) await migrationHardwareCheck();
  if (process.argv[2] === 'env') {
    const path = join(config.data, 'production.env');
    await privatePiDirectory(config.data, config.mount);
    await writeFile(path, Object.entries(installationEnvironment(config)).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    console.log('production.env creato: completare ID Google Sheets e credenziali prima di init.');
  } else if (process.argv[2] === 'init') {
    await privateLANFile(join(config.data, 'production.env'));
    process.loadEnvFile(join(config.data, 'production.env'));
    await withHomeWriterLock(() => initializeInstallation(config, process.env));
    console.log('Stato locale inizializzato senza account. Creare ora il proprio amministratore; custodire una copia separata della chiave di recupero backup.');
  } else if (process.argv[2] === 'backup-service') {
    if (process.env.SPESESMART_PI_CONFIG !== '/etc/spesesmart/pi.json' || !config.backupMount) throw Error('Configurare backup in /etc/spesesmart/pi.json.');
    process.stdout.write(renderPiService(config, process.env.SPESESMART_PI_CONFIG, 'backup'));
  } else if (process.argv[2] === 'service') process.stdout.write(renderPiService(config, process.env.SPESESMART_PI_CONFIG!));
  else throw Error('Uso: pi:install -- env | init | service | backup-service');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Preparazione interrotta: controllare configurazione, permessi e stato preesistente. Nessun registro sovrascritto; in caso di inizializzazione parziale occorre verifica manuale.'); process.exitCode = 1;
});
