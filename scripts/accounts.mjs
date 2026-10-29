// Shared by the HTTPS gateway and the local, interactive account administrator.
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, rename } from 'node:fs/promises';
import { isAbsolute, relative, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { privateLANFile, withLANCredentialsLock } from './lan-credentials.mjs';

const derive = promisify(scrypt);
const parameters = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const credentialSchema = z.object({ algorithm: z.literal('scrypt'), N: z.literal(parameters.N), r: z.literal(8), p: z.literal(1),
  salt: z.string().regex(/^[a-f0-9]{32}$/), hash: z.string().regex(/^[a-f0-9]{128}$/) }).strict();
const accountSchema = z.object({ id: z.uuid(), username: z.string().regex(/^[a-z0-9._-]{1,64}$/),
  role: z.enum(['admin', 'user']), active: z.boolean(), revision: z.uuid(), credential: credentialSchema }).strict();
const registrySchema = z.object({ version: z.literal(1), accounts: z.array(accountSchema).max(1000) }).strict();
export function validateAccounts(value) {
  const registry = registrySchema.parse(value);
  for (const key of ['id', 'username']) if (new Set(registry.accounts.map(a => a[key])).size !== registry.accounts.length) throw unavailable();
  return registry;
}
const unavailable = () => Error('Registro account assente, non valido o non privato. Nessun accesso autorizzato.');
export const publicAccount = account => ({ id: account.id, username: account.username, role: account.role });
export function accountDirectory(env = process.env) {
  const directory = env.SPESESMART_ACCOUNT_DIR;
  if (!directory || !isAbsolute(directory) || resolve(directory) !== directory) throw unavailable();
  const fromRepo = relative(process.cwd(), directory);
  if (!fromRepo.startsWith('..' + '/') && fromRepo !== '..' && !isAbsolute(fromRepo)) throw unavailable();
  return directory;
}
async function secureDirectory(directory) {
  accountDirectory({ SPESESMART_ACCOUNT_DIR: directory });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700
    || await realpath(directory) !== directory) throw unavailable();
}
export async function readAccounts(directory) {
  try {
    await secureDirectory(directory);
    if ((await lstat(join(directory, 'accounts.json'))).size > 1024 * 1024) throw unavailable();
    const registry = validateAccounts(JSON.parse(await privateLANFile(join(directory, 'accounts.json'))));
    return registry;
  } catch { throw unavailable(); }
}
function passwordValid(password) {
  return typeof password === 'string' && [...password].length >= 8 && [...password].length <= 256 && !/[\r\n]/.test(password);
}
async function passwordCredential(password) {
  if (!passwordValid(password)) throw Error('Password da 8 a 256 caratteri, su una sola riga, senza troncamento.');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, Buffer.from(salt, 'hex'), 64, parameters);
  return { algorithm: 'scrypt', N: parameters.N, r: 8, p: 1, salt, hash: hash.toString('hex') };
}
export async function authenticateAccount(directory, username, password) {
  const { accounts } = await readAccounts(directory);
  const account = accounts.find(a => a.username === username);
  // Unknown and disabled users still perform the same password derivation.
  const credential = account?.credential ?? { salt: '0'.repeat(32), hash: '0'.repeat(128) };
  const candidate = await derive(passwordValid(password) ? password : '', Buffer.from(credential.salt, 'hex'), 64, parameters);
  const matches = timingSafeEqual(candidate, Buffer.from(credential.hash, 'hex'));
  if (!passwordValid(password) || !matches || !account?.active) return null;
  const current = (await readAccounts(directory)).accounts.find(a => a.id === account.id);
  return current?.active && current.revision === account.revision ? current : null;
}
async function writeRegistry(directory, registry, initialize = false) {
  const text = JSON.stringify(registrySchema.parse(registry));
  const target = join(directory, 'accounts.json');
  const temporary = initialize ? target : join(directory, `.accounts-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  if (!initialize) await rename(temporary, target);
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
  if (JSON.stringify(await readAccounts(directory)) !== text) throw unavailable();
}
export async function initializeAccounts(directory) {
  accountDirectory({ SPESESMART_ACCOUNT_DIR: directory });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await secureDirectory(directory);
  return withLANCredentialsLock(directory, () => writeRegistry(directory, { version: 1, accounts: [] }, true));
}
export async function administerAccount(directory, action, username, { role = 'user', password } = {}) {
  await secureDirectory(directory);
  if (!/^[a-z0-9._-]{1,64}$/.test(username) || !['create', 'disable', 'password'].includes(action) || !['admin', 'user'].includes(role)) throw Error('Comando account non valido.');
  return withLANCredentialsLock(directory, async () => {
    const registry = await readAccounts(directory);
    const account = registry.accounts.find(a => a.username === username);
    if (action === 'create') {
      if (account) throw Error('Username già utilizzato.');
      registry.accounts.push({ id: randomUUID(), username, role, active: true, revision: randomUUID(), credential: await passwordCredential(password) });
    } else {
      if (!account) throw Error('Account non trovato.');
      if (action === 'disable') account.active = false;
      else account.credential = await passwordCredential(password);
      account.revision = randomUUID();
    }
    await writeRegistry(directory, registry);
  });
}

export async function changeAccountPassword(directory, id, revision, currentPassword, newPassword) {
  const fail = code => { throw Object.assign(Error('Cambio password non consentito.'), { code }); };
  if (!passwordValid(newPassword)) fail('PASSWORD_POLICY');
  await secureDirectory(directory);
  return withLANCredentialsLock(directory, async () => {
    const registry = await readAccounts(directory);
    const account = registry.accounts.find(a => a.id === id);
    if (!account?.active || account.revision !== revision) fail('ACCOUNT_CHANGED');
    // Verification and replacement share the existing lock, including CLI resets.
    if (!await authenticateAccount(directory, account.username, currentPassword)) fail('CURRENT_PASSWORD');
    account.credential = await passwordCredential(newPassword);
    account.revision = randomUUID();
    await writeRegistry(directory, registry);
    return { id: account.id, revision: account.revision };
  });
}
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('Usa un terminale locale interattivo. Non passare password in CLI o ambiente.');
  const [action, username, role, ...extra] = process.argv.slice(2);
  if (extra.length || !['init', 'create', 'disable', 'password'].includes(action)
    || (action === 'init' ? username !== undefined : username === undefined)
    || (action !== 'create' && role !== undefined) || (role && !['admin', 'user'].includes(role))) throw Error('Uso: accounts init | create username [admin|user] | disable username | password username');
  const directory = accountDirectory();
  if (action === 'init') await initializeAccounts(directory);
  else {
    let password;
    if (['create', 'password'].includes(action)) {
      let muted = false;
      const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
      const prompt = createInterface({ input: process.stdin, output, terminal: true });
      try {
        process.stdout.write('Password (8–256 caratteri, input nascosto): '); muted = true;
        password = await prompt.question('');
        muted = false; process.stdout.write('\nRipeti password: '); muted = true;
        const repeated = await prompt.question('');
        if (password !== repeated) throw Error('Password differenti. Nessuna modifica.');
      } finally { muted = false; process.stdout.write('\n'); prompt.close(); }
    }
    await administerAccount(directory, action, username, { role, password });
  }
  console.log('Operazione account completata. Nessun dato finanziario modificato.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Operazione account non riuscita: controlla comando, username, password e registro privato. Nessun segreto mostrato.'); process.exitCode = 1; });
}
