import "server-only";
import { constants } from "node:fs";
import { lstat, realpath, mkdir, open, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute, join } from "node:path";
import { z } from "zod";
import { createUpdateStore } from "./sheets-update-store";
import { PersistenceError, rejectClientOwner, requireFinancialUser, type FinancialUser } from "./sheets-persistence-model";
import { applyCategoryExtensions, categoryDefinitions, legacyIncomeCategories, legacySubscriptionCategory } from "./categories";
import { DEFAULT_BUDGET_CENTS } from "./budget";

const month = z.string().regex(/^(20\d{2})-(0[1-9]|1[0-2])$/);
const cents = z.number().int().min(0).max(99999999);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const extension = z.object({ id: z.string().regex(/^custom-[a-f0-9-]{36}$/), name: z.string().trim().min(1).max(60), description: z.string().max(300) }).strict();
const schema = z.object({ version: z.literal(1), catalogRevision: revision, extensions: z.array(extension).max(50),
  users: z.record(z.uuid(), z.object({ revision, budgets: z.record(month, cents) }).strict()) }).strict();
export function validatePreferences(value: unknown) {
  const checked = schema.parse(value);
  const names = [...categoryDefinitions.filter(c => !c.id.startsWith("custom-")).map(c => c.name), ...legacyIncomeCategories, legacySubscriptionCategory, "Shopping", "Casa", "Svago", "Salute", ...checked.extensions.map(c => c.name)].map(n => n.toLowerCase());
  if (new Set(names).size !== names.length || new Set(checked.extensions.map(c => c.id)).size !== checked.extensions.length) throw new PersistenceError("PREFERENCES", "Catalogo categorie non valido.");
  return checked;
}
export function preferencesDirectory(env: NodeJS.ProcessEnv = process.env) {
  const value = env.SPESESMART_PREFERENCES_DIR;
  if (!value || !isAbsolute(value) || resolve(value) !== value || !relative(process.cwd(), value).startsWith("../")) throw new PersistenceError("PREFERENCES", "Configura una directory preferenze privata esterna al progetto.");
  return value;
}
async function secure(path: string, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== (directory ? 0o700 : 0o600) || (directory ? !info.isDirectory() : !info.isFile())) throw Error("private storage");
}
export async function readPreferences(env: NodeJS.ProcessEnv = process.env) {
  try {
    const directory = preferencesDirectory(env); await secure(directory, true);
    if (await realpath(directory) !== directory) throw Error();
    const path = join(directory, "preferences.json"); await secure(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return validatePreferences(JSON.parse(await file.readFile("utf8"))); } finally { await file.close(); }
  } catch { throw new PersistenceError("PREFERENCES", "Preferenze non disponibili o non sicure. Nessun dato modificato."); }
}
async function writePreferences(value: ReturnType<typeof validatePreferences>, env: NodeJS.ProcessEnv, initialize = false) {
  const directory = preferencesDirectory(env), path = join(directory, "preferences.json"), temporary = initialize ? path : join(directory, `.preferences-${randomUUID()}.tmp`);
  const checked = validatePreferences(value), text = JSON.stringify(checked);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  if (!initialize) await rename(temporary, path);
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
  if (JSON.stringify(await readPreferences(env)) !== text) throw new PersistenceError("PREFERENCES", "Salvataggio delle preferenze non verificato.");
}
export async function initializePreferences(env: NodeJS.ProcessEnv = process.env) {
  const directory = preferencesDirectory(env); await mkdir(directory, { mode: 0o700, recursive: true }); await secure(directory, true);
  if (await realpath(directory) !== directory) throw new PersistenceError("PREFERENCES", "Percorso preferenze non canonico.");
  await createUpdateStore(env).lock(() => writePreferences({ version: 1, users: {}, extensions: [], catalogRevision: 0 }, env, true));
}
export async function loadCatalog(env: NodeJS.ProcessEnv = process.env) {
  const data = await readPreferences(env);
  applyCategoryExtensions(data.extensions, data.catalogRevision, preferencesDirectory(env));
  return { extensions: data.extensions, revision: data.catalogRevision };
}
export async function personalBudget(user: FinancialUser, selectedMonth: string, env: NodeJS.ProcessEnv = process.env) {
  const id = requireFinancialUser(user); month.parse(selectedMonth);
  const data = await readPreferences(env), entry = data.users[id];
  return { month: selectedMonth, budgetCents: entry?.budgets[selectedMonth] ?? DEFAULT_BUDGET_CENTS, configured: Object.hasOwn(entry?.budgets ?? {}, selectedMonth), version: entry?.revision ?? 0 };
}
export async function updatePersonalBudget(user: FinancialUser, input: unknown, env: NodeJS.ProcessEnv = process.env) {
  const id = requireFinancialUser(user); rejectClientOwner(input);
  const parsed = z.object({ month, budgetCents: cents, expectedVersion: revision }).strict().safeParse(input);
  if (!parsed.success) throw new PersistenceError("INVALID", "Budget non valido: usa centesimi interi non negativi.");
  return createUpdateStore(env).lock(async () => {
    const data = await readPreferences(env), entry = data.users[id] ?? { budgets: {}, revision: 0 };
    if (entry.revision !== parsed.data.expectedVersion) throw new PersistenceError("PREFERENCE_CONFLICT", "Budget modificato da un altro dispositivo. Rileggi prima di confermare.");
    entry.budgets[parsed.data.month] = parsed.data.budgetCents; entry.revision++; data.users[id] = entry;
    await writePreferences(data, env); return personalBudget(user, parsed.data.month, env);
  });
}
export async function addCategory(user: FinancialUser & { role: string }, input: unknown, env: NodeJS.ProcessEnv = process.env) {
  requireFinancialUser(user);
  if (user.role !== "admin") throw new PersistenceError("FORBIDDEN", "Gestione categorie riservata all’amministratore.");
  rejectClientOwner(input);
  const parsed = z.object({ name: extension.shape.name, description: extension.shape.description, expectedVersion: revision }).strict().safeParse(input);
  if (!parsed.success) throw new PersistenceError("INVALID", "Categoria non valida.");
  return createUpdateStore(env).lock(async () => {
    const data = await readPreferences(env);
    if (data.catalogRevision !== parsed.data.expectedVersion) throw new PersistenceError("PREFERENCE_CONFLICT", "Catalogo aggiornato: rileggi le categorie.");
    data.extensions.push({ id: `custom-${randomUUID()}`, name: parsed.data.name, description: parsed.data.description }); data.catalogRevision++;
    await writePreferences(data, env); return loadCatalog(env);
  });
}
