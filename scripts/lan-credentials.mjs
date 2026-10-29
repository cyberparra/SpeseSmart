// Policy for the temporary home-LAN entrypoint only, never Internet publication.
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function validateLANCredentials(value) {
  if (!value || typeof value.username !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(value.username) || typeof value.password !== 'string'
    || [...value.password].length < 8 || [...value.password].length > 256 || /[\r\n]/.test(value.password)) {
    throw Error('Credenziali LAN non valide: password da 8 a 256 caratteri, su una sola riga; nessun requisito di composizione.');
  }
  return value;
}

export async function privateLANFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw Error('File LAN non privato: richiesti proprietario corrente e permessi 0600.');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

function parseStoredCredentials(text) {
  try { return validateLANCredentials(JSON.parse(text)); }
  catch { throw Error('File credenziali LAN non valido. Il contenuto privato non viene mostrato.'); }
}

// Linux flock is held by this open file description even after the helper exits.
// Setup and the complete server lifetime share this lock; no stale PID files.
export async function withLANCredentialsLock(directory, action) {
  const lock = await open(join(directory, '.credentials.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await lock.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw Error('Lock credenziali LAN non privato.');
    const result = spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock.fd] });
    if (result.error || result.status !== 0) throw Error('Configurazione LAN occupata. Ferma npm run lan con Ctrl+C, oppure attendi la fine dell’altro setup, poi riprova.');
    return await action();
  } finally { await lock.close(); }
}

export async function saveLANCredentials(directory, credentials, previousText = null) {
  validateLANCredentials(credentials);
  const path = join(directory, 'access.json');
  let actual = null;
  try { actual = await privateLANFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (actual !== previousText) throw Error('Configurazione LAN cambiata durante il setup. Nessuna credenziale sovrascritta: riprova.');
  if (actual !== null) {
    const previous = parseStoredCredentials(actual);
    if (previous.username === credentials.username && previous.password === credentials.password) throw Error('Le credenziali sono identiche: cambia nome utente o password, oppure conserva la configurazione senza aggiornarla.');
  }
  const temporary = join(directory, `.access-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ username: credentials.username, password: credentials.password })); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await folder.sync(); } finally { await folder.close(); }
    const saved = parseStoredCredentials(await privateLANFile(path));
    if (saved.username !== credentials.username || saved.password !== credentials.password) throw Error('Salvataggio delle credenziali LAN non verificato.');
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
