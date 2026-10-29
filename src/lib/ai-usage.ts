import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, lstat, readFile, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { storedReceiptSchema, effectiveReceiptSchema, effectiveReceiptInstructions, validateAnalysis, type ReceiptAnalysis } from "./receipts/model";
import { zodTextFormat } from "openai/helpers/zod";

// Upper bound imposed by GPT-4.1 mini's context window, including image/schema input.
// No guessed tokenizer/hidden-prompt allowance: reserve the entire window.
export const MAX_AI_INPUT = 1_047_576;
export const MAX_AI_OUTPUT = 12_000;
export const AI_MODEL = "gpt-4.1-mini";
export const INSTRUCTIONS_VERSION = "receipts-v1";
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const UsageSchema = z.object({ input: integer.max(MAX_AI_INPUT), cached: integer, output: integer.max(MAX_AI_OUTPUT) }).strict().refine(v => v.cached <= v.input);
export type AIUsage = z.infer<typeof UsageSchema>;
const TariffSchema = z.object({ input: z.number().positive(), cachedInput: z.number().nonnegative(), output: z.number().positive() }).strict().refine(t => t.cachedInput <= t.input && Object.values(t).every(v => Number.isSafeInteger(v * 1000)));
const EntrySchema = z.object({
  userId: z.uuid().optional(), id: z.uuid(), timestamp: z.iso.datetime(), month: z.string().regex(/^\d{4}-\d{2}$/), model: z.string(),
  imageHash: z.string().regex(/^[a-f0-9]{64}$/), analysisKey: z.string().regex(/^[a-f0-9]{64}$/), reused: z.boolean(),
  status: z.enum(["completata", "fallita", "consumo_sconosciuto"]), usage: UsageSchema.nullable(),
  costNanoUsd: integer, reservationNanoUsd: integer, tariff: TariffSchema,
}).strict();
const LedgerSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema) }).strict();
type Ledger = z.infer<typeof LedgerSchema>;
export class AIControlError extends Error {
  constructor(public code: string, message: string, public status = 503) { super(message); }
}
// Preserve provider error classification without logging its original payload.
class ProviderFailure { constructor(public original: unknown) {} }
const storageError = () => new AIControlError("AI_STORAGE", "Registro AI non disponibile o non sicuro. Analisi bloccata; verifica la cartella privata sul server.");
export function aiConfiguration(env: NodeJS.ProcessEnv = process.env) {
  try {
    const model = env.OPENAI_RECEIPT_MODEL || AI_MODEL;
    if (![AI_MODEL, "gpt-4.1-mini-2025-04-14"].includes(model) || process.platform !== "linux" || env.VERCEL) throw new Error();
    // External runtime storage must never be traced into a deployment bundle.
    const directory = resolve(/*turbopackIgnore: true*/ env.SPESESMART_AI_DATA_DIR || join(homedir(), ".local/share/spesesmart/ai"));
    if (!isAbsolute(env.SPESESMART_AI_DATA_DIR || directory) || !relative(process.cwd(), directory).startsWith("..")) throw new Error();
    const tariff = TariffSchema.parse(JSON.parse(env.SPESESMART_AI_TARIFF_JSON || '{"input":0.4,"cachedInput":0.1,"output":1.6}'));
    const budgetNanoUsd = Number(env.SPESESMART_AI_MONTHLY_USD || 2) * 1e9;
    const maxAnalyses = Number(env.SPESESMART_AI_MAX_ANALYSES || 100);
    if (!Number.isSafeInteger(budgetNanoUsd) || budgetNanoUsd <= 0 || !Number.isSafeInteger(maxAnalyses) || maxAnalyses < 1 || maxAnalyses > 10000) throw new Error();
    return { directory, model, tariff, budgetNanoUsd, maxAnalyses };
  } catch { throw new AIControlError("AI_CONFIGURATION", "Configurazione costi AI non valida. Sono supportati GPT-4.1 mini e un registro privato su Ubuntu, fuori dal repository."); }
}
export type AIConfig = ReturnType<typeof aiConfiguration>;
export function usageCost(usage: AIUsage, tariff: AIConfig["tariff"]) {
  const u = UsageSchema.parse(usage); const t = TariffSchema.parse(tariff);
  const value = (u.input - u.cached) * Math.round(t.input * 1000) + u.cached * Math.round(t.cachedInput * 1000) + u.output * Math.round(t.output * 1000);
  if (!Number.isSafeInteger(value)) throw storageError();
  return value;
}
export function aiMonth(date: Date) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" }).formatToParts(date);
  return `${parts.find(p => p.type === "year")!.value}-${parts.find(p => p.type === "month")!.value}`;
}
async function secure(path: string, directory: boolean) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw storageError();
}
async function verifyDirectory(config: AIConfig) {
  await secure(config.directory, true);
  if (await realpath(config.directory) !== config.directory) throw storageError();
}
async function readLedger(config: AIConfig): Promise<Ledger> {
  await verifyDirectory(config);
  const path = join(config.directory, "usage.json"); await secure(path, false);
  return validateAILedger(JSON.parse(await readFile(path, "utf8")));
}
// Shared by offline backup verification; never initializes or changes accounting.
export function validateAILedger(value: unknown): Ledger {
  const ledger = LedgerSchema.parse(value);
  if (new Set(ledger.entries.map(e => e.id)).size !== ledger.entries.length || ledger.entries.some(e =>
    e.month !== aiMonth(new Date(e.timestamp)) ||
    (e.reused && (e.status !== "completata" || e.costNanoUsd !== 0 || e.usage !== null)) ||
    (!e.reused && (e.reservationNanoUsd !== usageCost({ input: MAX_AI_INPUT, cached: 0, output: MAX_AI_OUTPUT }, e.tariff) || (e.status === "consumo_sconosciuto" ? e.usage !== null || e.costNanoUsd !== e.reservationNanoUsd : !e.usage || e.costNanoUsd !== usageCost(e.usage, e.tariff))))
  )) throw storageError();
  return ledger;
}
async function writePrivate(path: string, value: unknown, exclusive = false) {
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  if (!exclusive) await rename(target, path);
  const dir = await open(resolve(path, ".."), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await dir.sync(); } finally { await dir.close(); }
}
// Explicit initialization only. Missing/deleted ledger at runtime never resets limits.
export async function initializeAI(config = aiConfiguration()) {
  await mkdir(config.directory, { recursive: true, mode: 0o700 }); await verifyDirectory(config);
  try { await lstat(join(config.directory, "usage.json")); await readLedger(config); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw storageError(); }
  await writePrivate(join(config.directory, "usage.json"), { version: 1, entries: [] }, true);
}
async function locked<T>(config: AIConfig, work: () => Promise<T>): Promise<T> {
  await verifyDirectory(config);
  const path = join(config.directory, "usage.lock");
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); await file.close(); await secure(path, false);
  // flock releases the lock on process termination. stdin EOF also releases it.
  const child = spawn("flock", ["-x", "-w", "80", path, process.execPath, "-e", 'process.stdout.write("LOCKED\\n"); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));'], { stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => { /* failed lock acquisition is handled below */ });
  const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(storageError())); child.once("exit", () => reject(storageError()));
      child.stdout.once("data", data => String(data).startsWith("LOCKED") ? resolve() : reject(storageError()));
    });
    return await work();
  } finally { child.stdin.end(); await closed; }
}
export function aiSummary(ledger: Ledger, config: AIConfig, now = new Date()) {
  const month = aiMonth(now); const entries = ledger.entries.filter(e => e.month === month);
  const fresh = entries.filter(e => !e.reused);
  const cost = fresh.reduce((n, e) => n + e.costNanoUsd, 0);
  const knownCost = fresh.filter(e => e.usage).reduce((n, e) => n + e.costNanoUsd, 0);
  const input = fresh.reduce((n, e) => n + (e.usage?.input ?? 0), 0);
  const cachedInput = fresh.reduce((n, e) => n + (e.usage?.cached ?? 0), 0);
  const output = fresh.reduce((n, e) => n + (e.usage?.output ?? 0), 0);
  const percent = Math.max(cost / config.budgetNanoUsd, fresh.length / config.maxAnalyses) * 100;
  const reservation = usageCost({ input: MAX_AI_INPUT, cached: 0, output: MAX_AI_OUTPUT }, config.tariff);
  return { month, analyses: fresh.length, cacheHits: entries.filter(e => e.reused).length, inputTokens: input, cachedInputTokens: cachedInput, outputTokens: output, totalTokens: input + output, estimatedUsd: knownCost / 1e9, committedUsd: cost / 1e9, unknown: fresh.filter(e => !e.usage).length, budgetUsd: config.budgetNanoUsd / 1e9, maxAnalyses: config.maxAnalyses, percent, warning: percent >= 80, blocked: cost + reservation > config.budgetNanoUsd || fresh.length >= config.maxAnalyses };
}
export async function getAIUsage(config = aiConfiguration(), now = new Date(), userId?: string) {
  try {
    const ledger = await readLedger(config);
    if (userId) {
      if (!z.uuid().safeParse(userId).success) throw storageError();
      const global = aiSummary(ledger, config, now);
      return { ...aiSummary({ ...ledger, entries: ledger.entries.filter(e => e.userId === userId) }, config, now), blocked: global.blocked };
    }
    return aiSummary(ledger, config, now);
  } catch (error) { if (error instanceof AIControlError) throw error; throw storageError(); }
}
export type AIResponse = { receipt: unknown; usage: AIUsage | null; model: string; completed: boolean };
export function validateAICache(value: unknown, key: string) {
  const cache = z.object({ key: z.literal(key), userId: z.uuid().optional(), receipt: storedReceiptSchema() }).strict().parse(value);
  if (cache.receipt.status !== "receipt" || !cache.receipt.items.length) throw storageError();
  return cache;
}
export async function controlledAnalysis(image: Buffer, force: boolean, call: () => Promise<AIResponse>, config = aiConfiguration(), now = () => new Date(), userId?: string) {
  if ((process.env.SPESESMART_MULTIUSER === "true" && !userId) || (userId && !z.uuid().safeParse(userId).success)) throw new AIControlError("AI_ACCESS", "Accesso account richiesto.", 401);
  try { return await locked(config, async () => {
    const ledger = await readLedger(config);
    const imageHash = createHash("sha256").update(image).digest("hex");
    const key = createHash("sha256").update(JSON.stringify([...(userId ? [userId] : []), imageHash, config.model, INSTRUCTIONS_VERSION, effectiveReceiptInstructions(), zodTextFormat(effectiveReceiptSchema(), "receipt"), "high", MAX_AI_OUTPUT])).digest("hex");
    const cachePath = join(config.directory, `${key}.cache.json`);
    let cached: ReceiptAnalysis | undefined;
    if (!force) {
      try {
        await secure(cachePath, false);
        const raw = z.object({ key: z.literal(key), userId: userId ? z.literal(userId) : z.undefined().optional(), receipt: effectiveReceiptSchema() }).strict().parse(JSON.parse(await readFile(cachePath, "utf8")));
        const receipt = validateAnalysis(raw.receipt);
        if (receipt.status === "receipt" && receipt.items.length) cached = receipt;
      } catch (error) {
        // Corrupt/incompatible cache never reused; unsafe files block paid work.
        if (error instanceof AIControlError || (error as NodeJS.ErrnoException).code === "EACCES") throw storageError();
      }
    }
    const date = now(); const month = aiMonth(date);
    const base = { ...(userId ? { userId } : {}), id: randomUUID(), timestamp: date.toISOString(), month, model: config.model, imageHash, analysisKey: key, tariff: config.tariff };
    if (cached) {
      ledger.entries.push({ ...base, status: "completata", reused: true, usage: null, costNanoUsd: 0, reservationNanoUsd: 0 });
      await writePrivate(join(config.directory, "usage.json"), ledger);
      return { receipt: cached, reusedFromCache: true };
    }
    if (!force && ledger.entries.some(e => e.analysisKey === key && e.status === "consumo_sconosciuto")) throw new AIControlError("AI_UNKNOWN", "Una precedente analisi di questa foto ha consumo sconosciuto. Verifica i consumi; una nuova chiamata richiede Analizza nuovamente.", 409);
    const reservation = usageCost({ input: MAX_AI_INPUT, cached: 0, output: MAX_AI_OUTPUT }, config.tariff);
    const summary = aiSummary(ledger, config, date);
    if (summary.analyses >= config.maxAnalyses || Math.round(summary.committedUsd * 1e9) + reservation > config.budgetNanoUsd) throw new AIControlError("AI_LIMIT", "Limite AI mensile raggiunto o budget insufficiente per prenotare una nuova analisi. I risultati già in cache restano disponibili.", 429);
    const entry: Ledger["entries"][number] = { ...base, reused: false, status: "consumo_sconosciuto", usage: null, costNanoUsd: reservation, reservationNanoUsd: reservation };
    ledger.entries.push(entry);
    await writePrivate(join(config.directory, "usage.json"), ledger); // durable BEFORE paid work
    let response: AIResponse;
    try { response = await call(); } catch (error) { throw new ProviderFailure(error); }
    const usage = response.usage ? UsageSchema.safeParse(response.usage) : null;
    if (usage?.success && [AI_MODEL, "gpt-4.1-mini-2025-04-14"].includes(response.model)) {
      entry.usage = usage.data; entry.model = response.model;
      entry.costNanoUsd = usageCost(usage.data, entry.tariff); entry.status = "fallita";
    }
    let receipt: ReceiptAnalysis | undefined;
    let rejectedReceipt: ReceiptAnalysis | undefined;
    try {
      if (response.completed && usage?.success && entry.usage) {
        const valid = validateAnalysis(response.receipt);
        if (valid.status === "receipt" && valid.items.length) { receipt = valid; entry.status = "completata"; }
        else rejectedReceipt = valid;
      }
    } catch { /* charged invalid output; no cache */ }
    await writePrivate(join(config.directory, "usage.json"), ledger);
    if (rejectedReceipt) {
      const status = rejectedReceipt.status;
      throw new AIControlError(status === "receipt" ? "NO_ITEMS" : status, status === "not_receipt" ? "L’immagine non sembra contenere uno scontrino. Scegli un’altra foto." : status === "unreadable" ? "Lo scontrino è sfocato o illeggibile. Scatta una foto più nitida." : "Non sono state riconosciute voci. Prova una foto più nitida.", 422);
    }
    if (!receipt) throw new AIControlError("INVALID_AI", "Risposta AI incompleta o non valida. Il consumo è contabilizzato; le correzioni precedenti restano disponibili.", 502);
    await writePrivate(cachePath, { key, ...(userId ? { userId } : {}), receipt }); // separate private cache; no image/secret in ledger
    return { receipt, reusedFromCache: false };
  }); } catch (error) {
    if (error instanceof ProviderFailure) throw error.original; // full reservation remains on disk
    if (error instanceof AIControlError) throw error;
    // API errors are handled by the existing sanitization; filesystem errors never expose paths.
    if (/^E[A-Z]+$/.test((error as NodeJS.ErrnoException).code ?? "") || error instanceof z.ZodError || error instanceof SyntaxError) throw storageError();
    throw error;
  }
}
