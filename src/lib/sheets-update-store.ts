import "server-only";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { canonical, PersistenceError, rowOwner, type Cell, type SheetSnapshot } from "./sheets-persistence-model";
import { EditRequestSchema } from "./purchase-edit";
import { DeleteRequestSchema } from "./purchase-delete";
import { parseBackup } from "./archive";

const CellSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const PatchSchema = z.object({ sheet: z.enum(["Movimenti", "Prodotti", "Documenti"]), row: z.number().int().min(1), before: z.array(CellSchema), after: z.array(CellSchema) }).strict();
const JournalSchema = z.object({ version: z.literal(2), userId: z.uuid(), scope: z.string().regex(/^[a-f0-9]{64}$/), operationId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/), request: EditRequestSchema, documentId: z.string().min(1), state: z.enum(["pending", "complete"]), marker: PatchSchema,
  patches: z.array(PatchSchema), commit: PatchSchema, headers: z.record(z.string(), z.array(CellSchema)), sheetIds: z.record(z.string(), z.number().int()), createdAt: z.iso.datetime() }).strict();
export type UpdatePatch = { sheet: "Movimenti" | "Prodotti" | "Documenti"; row: number; before: Cell[]; after: Cell[] };
export type UpdateJournal = z.infer<typeof JournalSchema>;
const DeletionJournalSchema = JournalSchema.omit({ request: true }).extend({ kind: z.literal("delete"), request: DeleteRequestSchema, backup: z.unknown() }).strict();
const MutationJournalSchema = z.union([JournalSchema, DeletionJournalSchema]);
const LegacyUpdateSchema = JournalSchema.omit({ userId: true, version: true }).extend({ version: z.literal(1) }).strict();
const LegacyDeleteSchema = DeletionJournalSchema.omit({ userId: true, version: true }).extend({ version: z.literal(1) }).strict();
export type LegacyJournal = z.infer<typeof LegacyUpdateSchema> | z.infer<typeof LegacyDeleteSchema>;
// Offline only. Active financial stores continue to accept v2 exclusively.
export function validateBackupJournal(text: string, scope: string, name: string): MutationJournal | LegacyJournal {
  if (JSON.parse(text)?.journal?.version !== 1) return validateStoredJournal(text, scope, name);
  const envelope = z.object({ checksum: z.string(), journal: z.union([LegacyUpdateSchema, LegacyDeleteSchema]) }).strict().parse(JSON.parse(text));
  const journal = envelope.journal;
  if (envelope.checksum !== digest(journal) || journal.scope !== scope || name !== `${journal.operationId}.json`
    || journal.request.operationId !== journal.operationId || journal.request.documentId !== journal.documentId
    || digest(journal.request) !== journal.requestHash) throw blocked();
  if ('backup' in journal) parseBackup(JSON.stringify(journal.backup));
  return journal;
}
export type DeletionJournal = z.infer<typeof DeletionJournalSchema>;
export type MutationJournal = UpdateJournal | DeletionJournal;
export function isDeletionJournal(journal: MutationJournal): journal is DeletionJournal { return "kind" in journal && journal.kind === "delete"; }
export interface UpdateStore {
  scope: string;
  lock<T>(work: () => Promise<T>): Promise<T>;
  list(): Promise<MutationJournal[]>;
  put(journal: MutationJournal): Promise<void>;
}
const blocked = () => new PersistenceError("UPDATE_STORAGE", "Registro aggiornamenti non disponibile o non sicuro. Nessuna nuova scrittura consentita.");
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function decode(text: string) {
  const envelope = z.object({ checksum: z.string(), journal: MutationJournalSchema }).strict().parse(JSON.parse(text));
  if (envelope.checksum !== digest(envelope.journal)) throw blocked();
  if (isDeletionJournal(envelope.journal)) parseBackup(JSON.stringify(envelope.journal.backup));
  return envelope.journal;
}
export function validateStoredJournal(text: string, scope: string, name: string) {
  const journal = decode(text);
  if (journal.scope !== scope || name !== `${journal.operationId}.json` || journal.request.operationId !== journal.operationId || journal.request.documentId !== journal.documentId || digest({ userId: journal.userId, request: journal.request }) !== journal.requestHash) throw blocked();
  for (const patch of [journal.marker, ...journal.patches, journal.commit]) {
    if ([patch.before, patch.after].some(row => row.some(cell => cell !== "") && rowOwner(patch.sheet, row) !== journal.userId)) throw blocked();
  }
  return journal;
}
async function secure(path: string, directory = false) {
  const info = await lstat(/*turbopackIgnore: true*/ path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw blocked();
}
export function createUpdateStore(env: NodeJS.ProcessEnv = process.env): UpdateStore {
  const scope = createHash("sha256").update(env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() ?? "").digest("hex");
  const base = env.SPESESMART_SHEETS_UPDATE_DIR || join(homedir(), ".local/share/spesesmart/sheets-updates");
  const resolvedBase = resolve(/*turbopackIgnore: true*/ base);
  if (process.platform !== "linux" || env.VERCEL || !isAbsolute(base) || !relative(process.cwd(), resolvedBase).startsWith("..") || (env.NODE_ENV !== "test" && (resolvedBase.startsWith("/tmp/") || resolvedBase === "/tmp"))) throw blocked();
  const directory = join(resolvedBase, scope);
  // Explicit marker detects loss of a previously initialized journal directory.
  const initialize = async () => {
    try {
      try { await lstat(join(base, `${scope}.transition-pending`)); throw blocked(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await mkdir(/*turbopackIgnore: true*/ base, { recursive: true, mode: 0o700 }); await secure(base, true);
      if (await realpath(/*turbopackIgnore: true*/ base) !== resolvedBase) throw blocked();
      const markerPath = join(base, `${scope}.initialized`);
      let initialized = false;
      try { await secure(markerPath); initialized = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (initialized) { if (await readFile(/*turbopackIgnore: true*/ markerPath, "utf8") !== scope) throw blocked(); await secure(directory, true); return; }
      await mkdir(/*turbopackIgnore: true*/ directory, { mode: 0o700 }); await secure(directory, true);
      const marker = await open(/*turbopackIgnore: true*/ markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await marker.writeFile(scope); await marker.sync(); } finally { await marker.close(); }
      const dir = await open(/*turbopackIgnore: true*/ base, constants.O_RDONLY | constants.O_DIRECTORY); try { await dir.sync(); } finally { await dir.close(); }
    } catch { throw blocked(); }
  };
  return {
    scope,
    async lock(work) {
      await initialize();
      const lockPath = join(directory, "writer.lock");
      const file = await open(/*turbopackIgnore: true*/ lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600).catch(() => { throw blocked(); }); await file.close(); await secure(lockPath);
      const child = spawn("flock", ["-x", "-w", "50", lockPath, process.execPath, "-e", 'process.stdout.write("LOCKED\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'], { stdio: ["pipe", "pipe", "ignore"] });
      child.stdin.on("error", () => {});
      const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
      try {
        await new Promise<void>((resolve, reject) => { child.once("error", () => reject(blocked())); child.once("exit", () => reject(blocked())); child.stdout.once("data", value => String(value).startsWith("LOCKED") ? resolve() : reject(blocked())); });
        return await work();
      } finally { child.stdin.end(); await closed; }
    },
    async list() {
      try {
        try { await lstat(join(base, `${scope}.transition-pending`)); throw blocked(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        try { await lstat(/*turbopackIgnore: true*/ directory); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try { await lstat(/*turbopackIgnore: true*/ join(base, `${scope}.initialized`)); } catch (markerError) {
            if ((markerError as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw markerError;
          }
          throw blocked();
        }
        await secure(directory, true);
        const result: MutationJournal[] = [];
        for (const name of await readdir(/*turbopackIgnore: true*/ directory)) {
          if (name === "writer.lock") continue;
          // A leftover temporary file may precede an interrupted reservation: block for inspection.
          if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw blocked();
          const path = join(directory, name); await secure(path);
          const journal = validateStoredJournal(await readFile(/*turbopackIgnore: true*/ path, "utf8"), scope, name);
          result.push(journal);
        }
        return result;
      } catch { throw blocked(); }
    },
    async put(value) {
      try {
        const journal = validateStoredJournal(JSON.stringify({ checksum: digest(value), journal: value }), scope, `${value.operationId}.json`);
        if (isDeletionJournal(journal)) parseBackup(JSON.stringify(journal.backup));
        if (journal.scope !== scope || /data:image\//i.test(JSON.stringify(journal))) throw blocked();
        const path = join(directory, `${journal.operationId}.json`);
        const temporary = `${path}.${randomUUID()}.tmp`;
        const file = await open(/*turbopackIgnore: true*/ temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(JSON.stringify({ checksum: digest(journal), journal })); await file.sync(); } finally { await file.close(); }
        await rename(/*turbopackIgnore: true*/ temporary, path);
        const dir = await open(/*turbopackIgnore: true*/ directory, constants.O_RDONLY | constants.O_DIRECTORY); try { await dir.sync(); } finally { await dir.close(); }
        // Read-back before allowing a remote write.
        if (JSON.stringify(decode(await readFile(/*turbopackIgnore: true*/ path, "utf8"))) !== JSON.stringify(journal)) throw blocked();
      } catch { throw blocked(); }
    },
  };
}
export function journalStructure(snapshot: SheetSnapshot) {
  return { headers: Object.fromEntries(Object.entries(snapshot).map(([name, table]) => [name, table.rows[0]])), sheetIds: Object.fromEntries(Object.entries(snapshot).map(([name, table]) => [name, table.id])) };
}
