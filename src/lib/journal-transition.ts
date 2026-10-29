import 'server-only';
import { mkdir, open, readFile, readdir, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonical } from './sheets-persistence-model';
import { createUpdateStore, validateBackupJournal } from './sheets-update-store';
import { withHomeWriterLock } from '../../scripts/home-runtime.mjs';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const manifestSchema = z.object({ version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({ name: z.string().regex(/^[a-f0-9-]{36}\.json$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()) }).strict();
const fail = (): never => { throw Error('Transizione journal bloccata: verificare piano, registri e stato. Nessuna ripresa finanziaria automatica.'); };
async function secure(path: string, directory = false) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || await realpath(path) !== path) fail();
}
async function exists(path: string) { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function sync(path: string) { const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY); try { await fd.sync(); } finally { await fd.close(); } }
async function write(path: string, data: string) {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
}
export async function inspectLegacyJournals(directory: string, scope: string, archived = false) {
  await secure(directory, true);
  const files: { name: string; sha256: string }[] = [];
  for (const name of (await readdir(directory)).sort()) {
    await secure(join(directory, name));
    if (name === 'writer.lock' || (archived && name === 'transition-manifest.json')) continue;
    const data = await readFile(join(directory, name));
    const journal = validateBackupJournal(data.toString(), scope, name);
    if (journal.version !== 1 || journal.state !== 'complete') fail();
    files.push({ name, sha256: hash(data) });
  }
  const manifest = manifestSchema.parse({ version: 1, scope, files });
  if (archived) {
    const original = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'transition-manifest.json'), 'utf8')));
    if (canonical(original) !== canonical(manifest)) fail();
  }
  return { manifest, fingerprint: hash(canonical(manifest)) };
}
export async function transitionJournals(env: NodeJS.ProcessEnv, action: 'plan' | 'apply' | 'rollback', fingerprint?: string) {
  const store = createUpdateStore(env), base = env.SPESESMART_SHEETS_UPDATE_DIR;
  if (!base || !env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim()) return fail();
  await secure(base, true);
  const active = join(base, store.scope), archive = join(base, `${store.scope}.legacy-v1`), staging = join(base, `${store.scope}.v2-staging`);
  const guard = join(base, `${store.scope}.transition-pending`), marker = join(base, `${store.scope}.initialized`);
  await secure(marker);
  if (await readFile(marker, 'utf8') !== store.scope) fail();
  if (action === 'plan') return inspectLegacyJournals(active, store.scope);
  if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) fail();
  return withHomeWriterLock(async () => {
    const hasArchive = await exists(archive);
    const guardExists = await exists(guard);
    if (guardExists) { await secure(guard); if (await readFile(guard, 'utf8') !== `${action}:${fingerprint}`) return fail(); }
    if (action === 'rollback') {
      if (!hasArchive || await exists(staging)) return fail();
      const inspected = await inspectLegacyJournals(archive, store.scope, true);
      if (inspected.fingerprint !== fingerprint) return fail();
      await secure(active, true);
      // Never discard new v2 operations. An interrupted rollback may contain
      // only byte-identical originals already restored by this same command.
      for (const name of await readdir(active)) {
        await secure(join(active, name));
        if (name === 'writer.lock') continue;
        const file = inspected.manifest.files.find(file => file.name === name);
        if (!guardExists || !file || hash(await readFile(join(active, name))) !== file.sha256) return fail();
      }
      if (!guardExists) { await write(guard, `rollback:${fingerprint}`); await sync(base); }
      for (const file of inspected.manifest.files) {
        if (!await exists(join(active, file.name))) await write(join(active, file.name), await readFile(join(archive, file.name), 'utf8'));
      }
      await sync(active);
      if ((await inspectLegacyJournals(active, store.scope)).fingerprint !== fingerprint || await readFile(marker, 'utf8') !== store.scope) return fail();
      await unlink(guard); await sync(base);
      return { status: 'rolled-back', fingerprint };
    }
    if (hasArchive) {
      if (!guardExists) return fail();
      // The process may have stopped immediately after the original rename.
      const hasManifest = await exists(join(archive, 'transition-manifest.json'));
      const inspected = await inspectLegacyJournals(archive, store.scope, hasManifest);
      if (inspected.fingerprint !== fingerprint) return fail();
      if (!hasManifest) { await write(join(archive, 'transition-manifest.json'), JSON.stringify(inspected.manifest)); await sync(archive); }
    } else {
      const inspected = await inspectLegacyJournals(active, store.scope);
      if (inspected.fingerprint !== fingerprint) return fail();
      if (await exists(staging)) { await secure(staging, true); if ((await readdir(staging)).length) return fail(); }
      else await mkdir(staging, { mode: 0o700 });
      await sync(staging);
      if (!guardExists) { await write(guard, `apply:${fingerprint}`); await sync(base); }
      await rename(active, archive); await sync(base);
      await write(join(archive, 'transition-manifest.json'), JSON.stringify(inspected.manifest)); await sync(archive);
    }
    if (!await exists(active)) {
      await secure(staging, true); if ((await readdir(staging)).length) return fail();
      await rename(staging, active); await sync(base);
    } else {
      await secure(active, true);
      if (await exists(staging) || (await readdir(active)).length) return fail();
    }
    if ((await inspectLegacyJournals(archive, store.scope, true)).fingerprint !== fingerprint || await readFile(marker, 'utf8') !== store.scope) return fail();
    await unlink(guard); await sync(base);
    return { status: 'v2-ready', fingerprint };
  });
}
