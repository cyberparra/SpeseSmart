import "server-only";
import { constants } from "node:fs";
import { lstat, realpath, readFile, readdir, open, mkdir, rename, rm, statfs } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withHomeWriterLock, homeRuntimeDirectory } from "../../scripts/home-runtime.mjs";
import { aiConfiguration, getAIUsage, validateAILedger, validateAICache } from "./ai-usage";
import { createUpdateStore, validateBackupJournal, type MutationJournal, type LegacyJournal } from "./sheets-update-store";
import { canonical } from "./sheets-persistence-model";
import { loadCatalog, readPreferences, preferencesDirectory, validatePreferences } from "./user-preferences";
import { BackupError, backupDigest, assertOrdinaryBackupData, validateFinancialBackup, createFinancialBackupReader } from "./backup-sheets";
import type { sheets_v4 } from "@googleapis/sheets";
import { accountDirectory, readAccounts } from '../../scripts/accounts.mjs';
import { withLANCredentialsLock } from '../../scripts/lan-credentials.mjs';
import { encryptAccounts, decryptAccounts, inspectEncryptedAccounts } from './account-backup';
import { inspectLegacyJournals } from './journal-transition';

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.uuid();
const filesystemUUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const execFileAsync = promisify(execFile);

// Pure validator shared by the real preflight and simulated mount tests.
export function validateBackupMountIdentity(mount: string, expectedUUID: string | undefined, result: unknown) {
  if (!expectedUUID || !filesystemUUID.test(expectedUUID)) return fail("BACKUP_UUID", "Configura un UUID filesystem atteso valido sul server.");
  const parsed = z.object({ filesystems: z.array(z.object({ target: z.string(), uuid: z.string().nullable(), fstype: z.string(), "maj:min": z.string(), options: z.string().optional() })) }).safeParse(result);
  if (!parsed.success || parsed.data.filesystems.length !== 1) return fail("BACKUP_UUID", "Identità del mount non verificabile; nessuna scrittura consentita.");
  const actual = parsed.data.filesystems[0];
  if (actual.target !== mount || !actual.uuid || actual.uuid.toLowerCase() !== expectedUUID.toLowerCase()) return fail("BACKUP_UUID", "Supporto assente o diverso da quello configurato; nessuna scrittura consentita.");
  return actual;
}

async function verifyMountedUUID(config: ServerBackupConfig) {
  let result: unknown;
  try {
    const { stdout } = await execFileAsync("findmnt", ["--json", "--mountpoint", config.mount, "--output", "TARGET,FSTYPE,UUID,MAJ:MIN,OPTIONS"], { timeout: 5000, maxBuffer: 64 * 1024 });
    result = JSON.parse(stdout);
  } catch { return fail("BACKUP_UUID", "Identità del mount non verificabile; nessuna scrittura consentita."); }
  const actual = validateBackupMountIdentity(config.mount, config.env.SPESESMART_BACKUP_UUID, result);
  const mounts = (await readFile("/proc/self/mountinfo", "utf8")).split("\n").map(line => line.split(" "));
  if (!mounts.some(parts => parts[2] === actual["maj:min"] && parts[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))) === config.mount)) return fail("BACKUP_UUID", "Il mount è cambiato durante la verifica; nessuna scrittura consentita.");
  return actual;
}

export function validateWritableBackupMount(mount: { fstype: string; options?: string }) {
  const options = new Set(mount.options?.split(","));
  if (mount.fstype !== "ext4" || ["ro", "noload", "norecovery"].some(option => options.has(option)) || !["rw", "nosuid", "nodev", "noexec"].every(option => options.has(option))) {
    return fail("BACKUP_MOUNT", "La copia richiede la USB ext4 rw,nosuid,nodev,noexec con journaling normale.");
  }
}
export function validateReadonlyBackupMount(mount: { fstype: string; options?: string }) {
  const options = new Set(mount.options?.split(","));
  if (mount.fstype !== "ext4" || options.has("rw") || !["ro", "nosuid", "nodev", "noexec"].every(option => options.has(option))) {
    return fail("BACKUP_MOUNT", "La preparazione richiede la USB ext4 già montata ro,nosuid,nodev,noexec.");
  }
}
const configurationSchema = z.object({ accountsEncrypted: z.boolean().optional(), preferences: z.boolean().optional(), model: z.string(), budgetNanoUsd: z.number().int().positive(), maxAnalyses: z.number().int().positive(),
  tariff: z.object({ input: z.number(), cachedInput: z.number(), output: z.number() }).strict(), timeZone: z.literal("Europe/Rome") }).strict();
const rootSchema = z.object({ application: z.literal("SpeseSmartBackupRoot"), version: z.literal(1), installationId: uuid, scope: hash, allowSameFilesystem: z.boolean() }).strict();
const manifestSchema = z.object({ application: z.literal("SpeseSmartServerBackup"), version: z.literal(1), id: uuid, installationId: uuid,
  scope: hash, kind: z.enum(["daily", "weekly"]), createdAt: z.iso.datetime(), appVersion: z.string(), nextVersion: z.string(), nodeVersion: z.string(), arch: z.string(),
  configuration: configurationSchema, state: z.object({ pendingOperations: z.array(uuid), unknownAI: z.number().int().nonnegative() }).strict(),
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: hash }).strict()).min(2),
}).strict();
export type BackupManifest = z.infer<typeof manifestSchema>;
type Payload = Map<string, Buffer>;
export type ServerBackupConfig = { root: string; mount: string; env: NodeJS.ProcessEnv; runtime: string };
export type BackupDependencies = { readFinancial?: () => Promise<sheets_v4.Schema$Spreadsheet>; availableBytes?: (path: string) => Promise<number>;
  beforePublish?: (staging: string) => Promise<void> };
const fail = (code: string, message: string): never => { throw new BackupError(code, message); };
const inside = (base: string, path: string) => { const r = relative(base, path); return r === "" || (!r.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && r !== ".." && !isAbsolute(r)); };
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);
const dateParts = (date: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(date));
const dayKey = (date: string) => { const parts = dateParts(date); return ["year", "month", "day"].map(type => parts.find(p => p.type === type)!.value).join("-"); };

export function serverBackupConfig(env: NodeJS.ProcessEnv = process.env): ServerBackupConfig {
  if (process.platform !== "linux" || env.VERCEL || !env.SPESESMART_BACKUP_ROOT || !env.SPESESMART_BACKUP_MOUNT
    || !env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim()) return fail("CONFIGURATION", "Configura destinazione, mount e foglio sul server Ubuntu.");
  if (!env.SPESESMART_BACKUP_UUID || !filesystemUUID.test(env.SPESESMART_BACKUP_UUID)) return fail("BACKUP_UUID", "Configura un UUID filesystem atteso valido sul server.");
  const config = { root: env.SPESESMART_BACKUP_ROOT, mount: env.SPESESMART_BACKUP_MOUNT, env: { ...env,
    SPESESMART_SHEETS_UPDATE_DIR: env.SPESESMART_SHEETS_UPDATE_DIR || join(homedir(), ".local/share/spesesmart/sheets-updates") }, runtime: homeRuntimeDirectory() };
  const ai = aiConfiguration(config.env);
  for (const path of [config.root, config.mount, config.env.SPESESMART_SHEETS_UPDATE_DIR!, ai.directory]) {
    if (!isAbsolute(path) || resolve(path) !== path) return fail("PATH", "Percorso assoluto canonico richiesto.");
  }
  for (const path of [process.cwd(), ai.directory, config.env.SPESESMART_SHEETS_UPDATE_DIR!, config.runtime,
    ...[env.SPESESMART_PREFERENCES_DIR, env.SPESESMART_ACCOUNT_DIR, env.SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE, env.SPESESMART_ACCOUNT_BACKUP_PUBLIC_KEY_FILE].filter((path): path is string => !!path)]) {
    if (overlap(config.root, path)) return fail("PATH", "Destinazione sovrapposta a progetto o dati del server.");
  }
  if (!inside(config.mount, config.root)) return fail("PATH", "Destinazione fuori dal mount configurato.");
  if (env.NODE_ENV !== "test" && inside("/tmp", config.root)) return fail("PATH", "Backup reali vietati su disco temporaneo.");
  return config;
}

async function secure(path: string, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || info.uid !== process.getuid?.()
    || (info.mode & 0o777) !== (directory ? 0o700 : 0o600) || (!directory && info.nlink !== 1)) return fail("PERMISSIONS", "Percorso backup o registro non privato, non regolare o collegato.");
  if (await realpath(path) !== path) return fail("PATH", "Collegamenti simbolici non ammessi nei percorsi.");
  return info;
}
async function privateRead(path: string) {
  await secure(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || !info.isFile() || info.size > 256 * 1024 * 1024) return fail("PERMISSIONS", "File tecnico non valido o troppo grande.");
    return await file.readFile();
  } finally { await file.close(); }
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await file.sync(); } finally { await file.close(); }
}
async function privateWrite(path: string, data: Buffer | string) {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
}
async function fileLock<T>(path: string, work: () => Promise<T>) {
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await secure(path);
    const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", file.fd] });
    if (result.error || result.status !== 0) return fail("BUSY", "Backup o registro occupato. Nessuna richiesta interrotta; riprova nella finestra di manutenzione.");
    return await work();
  } finally { await file.close(); }
}
async function destination(config: ServerBackupConfig) {
  await secure(config.root, true);
  if (await realpath(config.mount) !== config.mount) return fail("DISK", "Mount di backup non disponibile.");
  if (config.env.NODE_ENV !== "test") {
    await verifyMountedUUID(config);
    const mounts = (await readFile("/proc/self/mountinfo", "utf8")).split("\n").map(line => line.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
    if (!mounts.includes(config.mount) || (await lstat(config.mount)).dev !== (await lstat(config.root)).dev) return fail("DISK", "Disco di backup assente o mount differente. Nessuna directory alternativa creata.");
    const fs = await statfs(config.root);
    if (![0xef53, 0x58465342, 0x9123683e, 0x2fc12fc1, 0xf2f52010].includes(fs.type)) return fail("DISK", "Filesystem di backup non supportato per pubblicazione durabile.");
  }
}
export async function initializeBackupRoot(config: ServerBackupConfig, allowSameFilesystem = false) {
  await destination(config);
  return fileLock(join(config.root, ".backup.lock"), async () => {
    const scope = createUpdateStore(config.env).scope;
    const same = (await lstat(config.root)).dev === (await lstat(aiConfiguration(config.env).directory)).dev
      || (await lstat(config.root)).dev === (await lstat(config.env.SPESESMART_SHEETS_UPDATE_DIR!)).dev;
    if (same && !allowSameFilesystem) return fail("SAME_FILESYSTEM", "Preferisci un disco separato; per accettare lo stesso filesystem serve --allow-same-filesystem esplicito.");
    const marker = join(config.root, "repository.json");
    try { const existing = rootSchema.parse(JSON.parse((await privateRead(marker)).toString()));
      if (existing.scope !== scope) return fail("SCOPE", "Destinazione già associata a un altro foglio."); return existing;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if ((await readdir(config.root)).some(name => name !== ".backup.lock")) return fail("DESTINATION_NOT_EMPTY", "Inizializza una nuova cartella vuota: i backup precedenti non vengono adottati o cancellati.");
    const value = rootSchema.parse({ application: "SpeseSmartBackupRoot", version: 1, installationId: randomUUID(), scope, allowSameFilesystem });
    await mkdir(join(config.root, "sets"), { mode: 0o700 }); await privateWrite(marker, JSON.stringify(value)); await syncDirectory(config.root);
    return value;
  });
}
async function repository(config: ServerBackupConfig) {
  await destination(config);
  const marker = rootSchema.parse(JSON.parse((await privateRead(join(config.root, "repository.json"))).toString()));
  if (marker.scope !== createUpdateStore(config.env).scope) return fail("SCOPE", "Foglio diverso dalla destinazione inizializzata.");
  await secure(join(config.root, "sets"), true);
  return marker;
}

// Read-only preparation before stopping production. Never initializes, locks or mounts.
export async function inspectServerBackupDestination(config: ServerBackupConfig, access: "readonly" | "writable" = "writable") {
  const marker = await repository(config);
  if (config.env.NODE_ENV !== "test") {
    const mount = await verifyMountedUUID(config);
    (access === "readonly" ? validateReadonlyBackupMount : validateWritableBackupMount)(mount);
  }
  if ((await readdir(join(config.root, "sets"))).some(name => name.startsWith(".partial-"))) {
    return fail("PARTIAL_PRESENT", "Copia interrotta presente: verifica manuale richiesta, nessuna cancellazione automatica.");
  }
  const fs = await statfs(config.root);
  return { installationId: marker.installationId, availableBytes: fs.bavail * fs.bsize };
}

async function technicalPayload(env: NodeJS.ProcessEnv, legacyReadonly = false): Promise<{ files: Payload; pending: string[]; unknownAI: number }> {
  const ai = aiConfiguration(env), store = createUpdateStore(env), base = env.SPESESMART_SHEETS_UPDATE_DIR!;
  await secure(base, true); await secure(ai.directory, true); await secure(join(base, store.scope), true);
  const marker = await privateRead(join(base, `${store.scope}.initialized`));
  if (marker.toString() !== store.scope) return fail("STORAGE", "Marcatore del registro mancante o diverso. Nessuna inizializzazione.");
  const journals = legacyReadonly ? await Promise.all((await readdir(join(base, store.scope))).filter(name => name !== 'writer.lock').map(async name => validateBackupJournal(await readFile(join(base, store.scope, name), 'utf8'), store.scope, name))) : await store.list();
  const files: Payload = new Map();
  const archive = join(base, `${store.scope}.legacy-v1`);
  let archivePresent = true;
  try { await lstat(archive); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; archivePresent = false; }
  if (archivePresent) {
    await inspectLegacyJournals(archive, store.scope, true);
    for (const name of (await readdir(archive)).filter(name => name !== 'writer.lock')) files.set(`technical/legacy/${store.scope}/${name}`, await privateRead(join(archive, name)));
  }
  if (env.SPESESMART_MULTIUSER === "true" || env.SPESESMART_PREFERENCES_DIR) {
    await loadCatalog(env); await readPreferences(env);
    files.set("technical/preferences/preferences.json", await privateRead(join(preferencesDirectory(env), "preferences.json")));
  }
  await getAIUsage(ai);
  let unknownAI = 0;
  files.set(`technical/sheets/${store.scope}.initialized`, marker);
  for (const name of await readdir(join(base, store.scope))) {
    if (name === "writer.lock") { await secure(join(base, store.scope, name)); continue; }
    const content = await privateRead(join(base, store.scope, name)); assertOrdinaryBackupData(JSON.parse(content.toString()));
    files.set(`technical/sheets/${store.scope}/${name}`, content);
  }
  for (const name of await readdir(ai.directory)) {
    if (name === "usage.lock") { await secure(join(ai.directory, name)); continue; }
    if (name !== "usage.json" && !/^[a-f0-9]{64}\.cache\.json$/.test(name)) return fail("STORAGE", "File tecnico sconosciuto o incompleto: verifica manuale richiesta.");
    const content = await privateRead(join(ai.directory, name)), parsed = JSON.parse(content.toString()); assertOrdinaryBackupData(parsed);
    if (name === "usage.json") unknownAI = validateAILedger(parsed).entries.filter(e => e.status === "consumo_sconosciuto").length;
    if (name !== "usage.json") {
      validateAICache(parsed, name.slice(0, 64));
    }
    files.set(`technical/ai/${name}`, content);
  }
  return { files, pending: journals.filter(j => j.state === "pending").map(j => j.operationId).sort(), unknownAI };
}
// Offline inspection shares the backup validators, without lock/initialize/copy/API calls.
export async function inspectTechnicalState(env: NodeJS.ProcessEnv) {
  const payload = await technicalPayload(env);
  const accounts = env.SPESESMART_MULTIUSER === 'true' || env.SPESESMART_ACCOUNT_DIR ? canonical(await readAccounts(accountDirectory(env))) : '';
  if (accounts && canonical(await decryptAccounts(await encryptAccounts(env, createUpdateStore(env).scope), env, createUpdateStore(env).scope)) !== accounts) return fail('ACCOUNTS', 'Chiavi di recupero account non verificate.');
  return { pending: payload.pending.length, unknownAI: payload.unknownAI,
    technicalBytes: [...payload.files.values()].reduce((sum, data) => sum + data.length, 0) + (accounts ? Buffer.byteLength(accounts) * 2 + 8192 : 0),
    fingerprint: backupDigest(Buffer.from(payloadSignature(payload.files) + accounts)) };
}
const payloadSignature = (files: Payload) => JSON.stringify([...files].map(([path, data]) => [path, backupDigest(data)]).sort());
async function spaceFor(path: string, needed: number, dependencies: BackupDependencies) {
  const fs = await statfs(path), available = await (dependencies.availableBytes?.(path) ?? Promise.resolve(fs.bavail * fs.bsize));
  if (available < needed + 16 * 1024 * 1024) return fail("SPACE", "Spazio insufficiente sul disco di backup; nessuna copia pubblicata.");
}
export async function createServerBackup(config: ServerBackupConfig, kind: "daily" | "weekly", dependencies: BackupDependencies = {}, now = new Date()) {
  await repository(config);
  return fileLock(join(config.root, ".backup.lock"), () => withHomeWriterLock(async () => {
    const root = await repository(config), ai = aiConfiguration(config.env), store = createUpdateStore(config.env);
    // Existing markers validated before creating/acquiring lock files. Never initialize stores.
    await technicalPayload(config.env);
    const withAccounts = <T,>(work: () => Promise<T>) => config.env.SPESESMART_MULTIUSER === 'true' || config.env.SPESESMART_ACCOUNT_DIR
      ? withLANCredentialsLock(accountDirectory(config.env), work) : work();
    return fileLock(join(ai.directory, "usage.lock"), () => fileLock(join(config.env.SPESESMART_SHEETS_UPDATE_DIR!, store.scope, "writer.lock"), () => withAccounts(async () => {
      const initial = await technicalPayload(config.env), files = initial.files;
      const accountState = config.env.SPESESMART_MULTIUSER === 'true' || config.env.SPESESMART_ACCOUNT_DIR
        ? canonical(await readAccounts(accountDirectory(config.env))) : '';
      if (accountState) {
        const encrypted = await encryptAccounts(config.env, store.scope);
        // Verify recovery with the separate operational key before publishing.
        if (canonical(await decryptAccounts(encrypted, config.env, store.scope)) !== accountState) return fail('ACCOUNTS', 'Recupero account non verificato.');
        files.set('technical/accounts/accounts.enc', encrypted);
      }
      if (kind === "weekly") {
        const read = dependencies.readFinancial ?? createFinancialBackupReader(config.env);
        const first = await read(), second = await read();
        if (backupDigest(canonical(first)) !== backupDigest(canonical(second))) return fail("REMOTE_CHANGED", "Il foglio è cambiato durante le letture. Backup finanziario non pubblicato; nessun retry automatico.");
        validateFinancialBackup(second, store.scope, await store.list());
        files.set("financial/google-sheets.json", Buffer.from(JSON.stringify(second)));
      }
      const final = await technicalPayload(config.env);
      const initialTechnical = new Map([...files].filter(([name]) => name.startsWith("technical/") && name !== 'technical/accounts/accounts.enc'));
      if (payloadSignature(initialTechnical) !== payloadSignature(final.files)) return fail("SOURCE_CHANGED", "Registri cambiati durante la copia. Nessun backup pubblicato.");
      if (accountState && canonical(await readAccounts(accountDirectory(config.env))) !== accountState) return fail('SOURCE_CHANGED', 'Account cambiati durante la copia.');
      const packageInfo = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
      const { directory: _directory, ...settings } = ai; void _directory;
      const id = randomUUID(), manifest = manifestSchema.parse({ application: "SpeseSmartServerBackup", version: 1, id,
        installationId: root.installationId, scope: store.scope, kind, createdAt: now.toISOString(), appVersion: packageInfo.version,
        nextVersion: packageInfo.dependencies.next, nodeVersion: process.version, arch: process.arch,
        configuration: { ...settings, ...(accountState ? { accountsEncrypted: true } : {}), ...(files.has("technical/preferences/preferences.json") ? { preferences: true } : {}), timeZone: "Europe/Rome" }, state: { pendingOperations: initial.pending, unknownAI: initial.unknownAI },
        files: [...files].map(([path, data]) => ({ path, bytes: data.length, sha256: backupDigest(data) })).sort((a, b) => a.path.localeCompare(b.path)) });
      await spaceFor(config.root, [...files.values()].reduce((sum, data) => sum + data.length, 0), dependencies);
      const staging = join(config.root, "sets", `.partial-${id}`), published = join(config.root, "sets", id);
      await mkdir(staging, { mode: 0o700 });
      await mkdir(join(staging, "technical/sheets", store.scope), { recursive: true, mode: 0o700 });
      // Failed/abrupt copies remain private .partial-* and are never adopted or rotated.
      for (const [path, data] of files) {
        await mkdir(resolve(staging, path, ".."), { recursive: true, mode: 0o700 }); await privateWrite(join(staging, path), data);
      }
      const text = JSON.stringify(manifest); await privateWrite(join(staging, "manifest.json"), text);
      await privateWrite(join(staging, "manifest.sha256"), backupDigest(text));
      await verifyServerBackup(staging);
      await dependencies.beforePublish?.(staging);
      for (const path of ['technical/accounts', 'technical/preferences', `technical/legacy/${store.scope}`, 'technical/legacy']) {
        if ([...files.keys()].some(name => name.startsWith(path + '/'))) await syncDirectory(join(staging, path));
      }
      for (const path of ["technical/ai", `technical/sheets/${store.scope}`, "technical/sheets", "technical", ...(kind === "weekly" ? ["financial"] : []), ""]) await syncDirectory(join(staging, path));
      const destinationNow = await repository(config); // No fallback to another disk/installation.
      if (canonical(destinationNow) !== canonical(root)) return fail("DISK", "Destinazione cambiata durante la copia.");
      await rename(staging, published); await syncDirectory(join(config.root, "sets"));
      await verifyServerBackup(published);
      return { id, directory: published, pending: manifest.state.pendingOperations.length, unknownAI: manifest.state.unknownAI, kind };
    })));
  }, config.runtime));
}

function allowedPayload(path: string, scope: string) {
  return path === 'technical/accounts/accounts.enc' || new RegExp(`^technical/legacy/${scope}/(?:[a-f0-9-]{36}\\.json|transition-manifest\\.json)$`).test(path)
    || path === "technical/preferences/preferences.json" || path === "technical/ai/usage.json" || /^technical\/ai\/[a-f0-9]{64}\.cache\.json$/.test(path)
    || path === `technical/sheets/${scope}.initialized` || new RegExp(`^technical/sheets/${scope}/[a-f0-9-]{36}\\.json$`).test(path)
    || path === "financial/google-sheets.json";
}
async function listTree(base: string, prefix = ""): Promise<string[]> {
  await secure(join(base, prefix), true);
  const result: string[] = [];
  for (const name of await readdir(join(base, prefix))) {
    const path = join(prefix, name), info = await lstat(join(base, path));
    if (info.isSymbolicLink()) return fail("PATH", "Link non ammessi nel backup.");
    if (info.isDirectory()) result.push(...await listTree(base, path)); else { await secure(join(base, path)); result.push(path); }
  }
  return result.sort();
}
export async function verifyServerBackup(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) !== directory) return fail("PATH", "Backup da verificare: percorso assoluto canonico richiesto.");
  await secure(directory, true);
  const raw = await privateRead(join(directory, "manifest.json"));
  if ((await privateRead(join(directory, "manifest.sha256"))).toString() !== backupDigest(raw)) return fail("CHECKSUM", "Checksum manifest non valido.");
  const manifest = manifestSchema.parse(JSON.parse(raw.toString()));
  if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length
    || manifest.files.some(file => !allowedPayload(file.path, manifest.scope))
    || manifest.files.some(file => file.path === "technical/preferences/preferences.json") !== (manifest.configuration.preferences === true)
    || manifest.files.some(file => file.path === 'technical/accounts/accounts.enc') !== (manifest.configuration.accountsEncrypted === true)
    || !manifest.files.some(file => file.path === "technical/ai/usage.json")
    || !manifest.files.some(file => file.path === `technical/sheets/${manifest.scope}.initialized`)
    || manifest.files.some(file => file.path === "financial/google-sheets.json") !== (manifest.kind === "weekly")) return fail("MANIFEST", "Elenco dei file non valido.");
  const expected = [...manifest.files.map(file => file.path), "manifest.json", "manifest.sha256"].sort();
  if (JSON.stringify(await listTree(directory)) !== JSON.stringify(expected)) return fail("MANIFEST", "File estranei, mancanti o incompleti nel backup.");
  if (manifest.configuration.preferences) {
    const data = await privateRead(join(directory, "technical/preferences/preferences.json"));
    const record = manifest.files.find(file => file.path === "technical/preferences/preferences.json")!;
    if (data.length !== record.bytes || backupDigest(data) !== record.sha256) return fail("CHECKSUM", "Checksum preferenze non valido.");
    validatePreferences(JSON.parse(data.toString()));
    await loadCatalog({ NODE_ENV: "test", SPESESMART_PREFERENCES_DIR: join(directory, "technical/preferences") });
  }
  const journals: (MutationJournal | LegacyJournal)[] = []; let unknownAI = 0;
  for (const file of manifest.files) {
    const data = await privateRead(join(directory, file.path));
    if (data.length !== file.bytes || backupDigest(data) !== file.sha256) return fail("CHECKSUM", "Checksum di un file non valido.");
    if (file.path.endsWith(".json")) assertOrdinaryBackupData(JSON.parse(data.toString()));
    if (file.path.startsWith(`technical/sheets/${manifest.scope}/`)) journals.push(validateBackupJournal(data.toString(), manifest.scope, file.path.split("/").at(-1)!));
    if (file.path === 'technical/accounts/accounts.enc') inspectEncryptedAccounts(data, manifest.scope);
    if (file.path === `technical/sheets/${manifest.scope}.initialized` && data.toString() !== manifest.scope) return fail("MANIFEST", "Marcatore di inizializzazione diverso.");
    if (file.path === "technical/ai/usage.json") unknownAI = validateAILedger(JSON.parse(data.toString())).entries.filter(e => e.status === "consumo_sconosciuto").length;
    if (/\.cache\.json$/.test(file.path)) {
      validateAICache(JSON.parse(data.toString()), file.path.split("/").at(-1)!.slice(0, 64));
    }
  }
  if (unknownAI !== manifest.state.unknownAI || canonical(journals.filter(j => j.state === "pending").map(j => j.operationId).sort()) !== canonical([...manifest.state.pendingOperations].sort())) return fail("MANIFEST", "Stato dei registri diverso dal manifest.");
  if (new Set(journals.map(journal => journal.version)).size > 1) return fail('MANIFEST', 'Versioni journal attive mescolate.');
  if (manifest.files.some(file => file.path.startsWith('technical/legacy/'))) await inspectLegacyJournals(join(directory, 'technical/legacy', manifest.scope), manifest.scope, true);
  if (manifest.kind === "weekly") {
    const raw = JSON.parse((await privateRead(join(directory, "financial/google-sheets.json"))).toString());
    const legacy = !raw.sheets?.find((sheet: sheets_v4.Schema$Sheet) => sheet.properties?.title === 'Movimenti')?.data?.[0]?.rowData?.[0]?.values?.some((cell: sheets_v4.Schema$CellData) => cell.effectiveValue?.stringValue === 'UtenteID' || cell.userEnteredValue?.stringValue === 'UtenteID');
    validateFinancialBackup(raw, manifest.scope, journals, legacy);
  }
  return manifest;
}

function assertLedgerNotOlder(backup: Buffer, current: Buffer) {
  const source = JSON.parse(backup.toString()), baseline = JSON.parse(current.toString());
  const entries = new Map(source.entries.map((entry: { id: string }) => [entry.id, entry]));
  if (baseline.entries.some((entry: { id: string }) => canonical(entries.get(entry.id)) !== canonical(entry))) {
    return fail("STALE_LEDGER", "Il ledger di riferimento contiene consumi o stati più recenti/diversi. Ripristino bloccato: non azzerare né retrocedere i consumi.");
  }
}
export async function restoreBackupIsolated(config: ServerBackupConfig, source: string, target: string, currentAI = aiConfiguration(config.env).directory) {
  // Only isolated restore exists. No command writes into configured production directories or Google.
  await secure(currentAI, true);
  const restore = async () => {
    const manifest = await verifyServerBackup(source), expectedScope = createUpdateStore(config.env).scope;
    if (manifest.scope !== expectedScope) return fail("SCOPE", "Backup di un altro foglio; ripristino non consentito.");
    if (!isAbsolute(target) || resolve(target) !== target || [source, config.root, process.cwd(), config.runtime,
      currentAI, config.env.SPESESMART_SHEETS_UPDATE_DIR!, aiConfiguration(config.env).directory,
      ...[config.env.SPESESMART_ACCOUNT_DIR, config.env.SPESESMART_ACCOUNT_BACKUP_PRIVATE_KEY_FILE, config.env.SPESESMART_ACCOUNT_BACKUP_PUBLIC_KEY_FILE, config.env.SPESESMART_PREFERENCES_DIR].filter((path): path is string => !!path)].some(path => overlap(target, path))) return fail("PATH", "Usa una directory isolata nuova, separata da progetto, backup e registri reali.");
    await secure(resolve(target, ".."), true);
    const currentConfig = aiConfiguration({ ...config.env, SPESESMART_AI_DATA_DIR: currentAI });
    await getAIUsage(currentConfig); // Missing current ledger is not treated as an empty ledger.
    const baseline = await privateRead(join(currentAI, "usage.json"));
    assertLedgerNotOlder(await privateRead(join(source, "technical/ai/usage.json")), baseline);
    let recoveredAccounts;
    if (manifest.configuration.accountsEncrypted) {
      const data = await privateRead(join(source, 'technical/accounts/accounts.enc'));
      const record = manifest.files.find(file => file.path === 'technical/accounts/accounts.enc')!;
      if (data.length !== record.bytes || backupDigest(data) !== record.sha256) return fail('CHECKSUM', 'Backup account cambiato durante il recupero.');
      recoveredAccounts = await decryptAccounts(data, config.env, manifest.scope);
    }
    await mkdir(target, { mode: 0o700 }); // Exclusive: never merge or overwrite an existing directory.
    await mkdir(join(target, "sheets-updates", expectedScope), { recursive: true, mode: 0o700 });
    for (const file of manifest.files) {
      if (file.path === 'technical/accounts/accounts.enc') continue;
      const path = file.path.replace(/^technical\/legacy\/([a-f0-9]{64})\//, 'sheets-updates/$1.legacy-v1/').replace(/^technical\/sheets\//, "sheets-updates/").replace(/^technical\/ai\//, "ai/").replace(/^technical\/preferences\//, "preferences/");
      const data = await privateRead(join(source, file.path));
      if (data.length !== file.bytes || backupDigest(data) !== file.sha256) return fail("CHECKSUM", "Backup cambiato durante il ripristino isolato.");
      await mkdir(resolve(target, path, ".."), { recursive: true, mode: 0o700 }); await privateWrite(join(target, path), data);
      if (backupDigest(await privateRead(join(target, path))) !== file.sha256) return fail("CHECKSUM", "Verifica della copia ripristinata fallita.");
    }
    if (recoveredAccounts) {
      await mkdir(join(target, 'accounts'), { mode: 0o700 });
      await privateWrite(join(target, 'accounts/accounts.json'), JSON.stringify(recoveredAccounts));
      if (canonical(await readAccounts(join(target, 'accounts'))) !== canonical(recoveredAccounts)) return fail('ACCOUNTS', 'Ripristino account non verificato.');
      await syncDirectory(join(target, 'accounts'));
    }
    // Validators operate on the restored copies. Test mode here only permits an isolated /tmp target.
    const restoredEnv: NodeJS.ProcessEnv = { ...config.env, NODE_ENV: "test", SPESESMART_MULTIUSER: recoveredAccounts ? 'true' : 'false', SPESESMART_ACCOUNT_DIR: recoveredAccounts ? join(target, 'accounts') : undefined, SPESESMART_AI_DATA_DIR: join(target, "ai"), SPESESMART_SHEETS_UPDATE_DIR: join(target, "sheets-updates"), SPESESMART_PREFERENCES_DIR: manifest.configuration.preferences ? join(target, "preferences") : undefined };
    const payload = await technicalPayload(restoredEnv, true);
    if (JSON.stringify(payload.pending) !== JSON.stringify([...manifest.state.pendingOperations].sort()) || payload.unknownAI !== manifest.state.unknownAI) return fail("MANIFEST", "Stato restaurato diverso dal manifest.");
    // Financial payload was already validated, including legacy layouts, before
    // copying; every restored byte has also been compared with its manifest.
    await privateWrite(join(target, "restore-validation.json"), JSON.stringify({ application: "SpeseSmartIsolatedRestore", version: 1,
      backupId: manifest.id, validatedAt: new Date().toISOString(), requiresRecovery: payload.pending.length > 0 || payload.unknownAI > 0,
      remoteRestore: false, configuration: manifest.configuration }));
    if (!baseline.equals(await privateRead(join(currentAI, "usage.json")))) return fail("SOURCE_CHANGED", "Ledger di riferimento cambiato durante il controllo.");
    for (const path of [`sheets-updates/${expectedScope}`, ...(manifest.files.some(file => file.path.startsWith('technical/legacy/')) ? [`sheets-updates/${expectedScope}.legacy-v1`] : []), "sheets-updates", "ai", ...(manifest.configuration.preferences ? ["preferences"] : []), ...(manifest.kind === "weekly" ? ["financial"] : []), ""]) await syncDirectory(join(target, path));
    return { directory: target, pending: payload.pending.length, unknownAI: payload.unknownAI, remoteRestore: false };
  };
  // An archived reference is immutable: never add a lock file to a verified copy.
  return withHomeWriterLock(() => currentAI === aiConfiguration(config.env).directory
    ? fileLock(join(currentAI, "usage.lock"), restore) : restore(), config.runtime);
}

export async function writeRotationPlan(config: ServerBackupConfig, output: string) {
  if (!isAbsolute(output) || resolve(output, "..") !== config.root) return fail("PATH", "Salva il piano nella radice privata dei backup, con nome nuovo.");
  const plan = await rotationPlan(config);
  await privateWrite(output, JSON.stringify(plan, null, 2)); await syncDirectory(config.root);
  return { kept: plan.keep.length, proposedRemovals: plan.remove.length };
}
export async function applyRotationFile(config: ServerBackupConfig, path: string) {
  if (!isAbsolute(path) || resolve(path, "..") !== config.root) return fail("PATH", "Usa un piano privato della destinazione configurata.");
  return applyRotation(config, JSON.parse((await privateRead(path)).toString()));
}

export async function rotationPlan(config: ServerBackupConfig) {
  const root = await repository(config), records: { manifest: BackupManifest; digest: string }[] = [];
  for (const name of await readdir(join(config.root, "sets"))) {
    if (!uuid.safeParse(name).success) continue; // Never touch partial/legacy/test/reset namespaces.
    const directory = join(config.root, "sets", name), manifest = await verifyServerBackup(directory);
    if (manifest.id !== name || manifest.installationId !== root.installationId || manifest.scope !== root.scope) return fail("SCOPE", "Copia estranea alla destinazione: rotazione bloccata.");
    records.push({ manifest, digest: backupDigest(await privateRead(join(directory, "manifest.json"))) });
  }
  records.sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt) || b.manifest.id.localeCompare(a.manifest.id));
  const keep = new Set<string>();
  const select = (items: typeof records, count: number, key: (date: string) => string) => {
    const buckets = new Set<string>();
    for (const { manifest } of items) { const bucket = key(manifest.createdAt); if (buckets.has(bucket)) continue; buckets.add(bucket); keep.add(manifest.id); if (buckets.size === count) break; }
  };
  const weekly = records.filter(r => r.manifest.kind === "weekly");
  select(records, 7, dayKey);
  select(weekly, 4, date => { const d = new Date(dayKey(date) + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); });
  select(weekly, 3, date => dayKey(date).slice(0, 7));
  const all = records.map(r => ({ id: r.manifest.id, manifestDigest: r.digest }));
  return { application: "SpeseSmartRotationPlan", version: 1, installationId: root.installationId, scope: root.scope,
    keep: all.filter(r => keep.has(r.id)), remove: all.filter(r => !keep.has(r.id)) };
}
export async function applyRotation(config: ServerBackupConfig, approvedPlan: unknown) {
  await repository(config);
  return fileLock(join(config.root, ".backup.lock"), async () => {
    const current = await rotationPlan(config);
    if (JSON.stringify(current) !== JSON.stringify(approvedPlan)) return fail("ROTATION_CHANGED", "Piano obsoleto o differente: nessun backup eliminato.");
    // All owned copies validated before any removal; newest daily/weekly/monthly protected.
    for (const record of current.remove) await rm(join(config.root, "sets", record.id), { recursive: true });
    await syncDirectory(join(config.root, "sets")); return { removed: current.remove.length, retained: current.keep.length };
  });
}
