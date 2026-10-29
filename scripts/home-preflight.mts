import nextEnvironment from '@next/env';
const { loadEnvConfig } = nextEnvironment;
import { access, lstat, open, realpath, readdir, statfs, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectTechnicalState } from '../src/lib/server-backup';
import { aiConfiguration, getAIUsage } from '../src/lib/ai-usage';
import { createUpdateStore } from '../src/lib/sheets-update-store';

export async function homePreflight(env: NodeJS.ProcessEnv = process.env, allowTemporaryFixture = false, readOnly = false) {
  const ai = aiConfiguration(env), store = createUpdateStore(allowTemporaryFixture ? { ...env, NODE_ENV: 'test' } : env);
  const base = env.SPESESMART_SHEETS_UPDATE_DIR;
  if (!base || !env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim()) throw Error('Configurazione persistente incompleta.');
  for (const directory of [ai.directory, base, join(base, store.scope)]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700
      || await realpath(directory) !== directory || !relative(process.cwd(), directory).startsWith('..')
      || (!allowTemporaryFixture && directory.startsWith('/tmp/'))) throw Error('Disco persistente non sicuro.');
    const fs = await statfs(directory);
    // Local durable filesystems only; fail closed for tmpfs/network/unknown disks.
    if (!allowTemporaryFixture && ![0xef53, 0x58465342, 0x9123683e, 0x2fc12fc1, 0xf2f52010].includes(fs.type)) throw Error('Filesystem persistente non supportato.');
    if (fs.bavail * fs.bsize < 16 * 1024 * 1024) throw Error('Spazio persistente insufficiente.');
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  }
  const markerPath = join(base, `${store.scope}.initialized`);
  const marker = await lstat(markerPath);
  if (!marker.isFile() || marker.isSymbolicLink() || marker.uid !== process.getuid?.() || (marker.mode & 0o777) !== 0o600) throw Error('Marcatore registro mancante o non privato.');
  const markerFile = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (await markerFile.readFile('utf8') !== store.scope) throw Error('Marcatore registro non valido.'); } finally { await markerFile.close(); }
  const journals = await store.list(); // Validates checksum, UUID, scope and backups without initialize/put/lock.
  await getAIUsage(ai); // Read-only: never initializes or resets usage.
  for (const directory of [ai.directory, join(base, store.scope)]) {
    for (const name of await readdir(directory)) {
      const stat = await lstat(join(directory, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || name.endsWith('.tmp')) throw Error('File tecnico non privato o incompleto.');
    }
  }
  const technical = await inspectTechnicalState(allowTemporaryFixture ? { ...env, NODE_ENV: 'test' } : env);
  if (!readOnly) for (const directory of [base, ai.directory]) {
    const probe = join(directory, `.preflight-${randomUUID()}`);
    try {
      const file = await open(probe, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile('preflight'); await file.sync(); } finally { await file.close(); }
    } finally { await unlink(probe); }
    const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await folder.sync(); } finally { await folder.close(); }
  }
  return { scope: store.scope, aiDirectory: ai.directory, updateDirectory: base,
    pending: journals.filter(j => j.state === 'pending').length, unknownAI: technical.unknownAI,
    recovery: technical.pending > 0 || technical.unknownAI > 0 ? 'required' : 'none' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  // Canonical explicit defaults passed back to the launcher, not secret values.
  const { homedir } = await import('node:os');
  process.env.SPESESMART_SHEETS_UPDATE_DIR ||= join(homedir(), '.local/share/spesesmart/sheets-updates');
  try { process.stdout.write(JSON.stringify(await homePreflight())); }
  catch { console.error('Preflight fallito: verifica disco, permessi, ledger e journal esistenti. Nessun registro inizializzato.'); process.exitCode = 1; }
}
