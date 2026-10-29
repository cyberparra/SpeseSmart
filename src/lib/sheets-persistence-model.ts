import { z } from "zod";
import { categoryDefinitions, isCategory, normalizeHistoricalTransaction } from "./categories";
import { createBackup, parseBackup, validateArchive, movementOrigin, type Archive } from "./archive";
import { prepareManualExpenses, isHistoricalIncome } from "./spending";
import type { Expense } from "./demo";
import { reconcile, type ConfirmedReceipt } from "./receipts/model";

export const TABLE_HEADERS = {
  Movimenti: ["ID movimento", "ID documento", "Data", "Tipo", "Descrizione", "Esercente", "Categoria", "Importo EUR", "Origine", "Stato", "Note", "Creato il", "UtenteID"],
  Prodotti: ["ID riga", "ID documento", "Descrizione originale", "Prodotto normalizzato", "Quantità", "Prezzo totale EUR", "Categoria proposta", "Categoria confermata", "Confidenza", "Note", "UtenteID"],
  Documenti: ["ID documento", "Tipo documento", "Data acquisto", "Esercente", "Totale EUR", "Totale categorizzato EUR", "Differenza EUR", "URL immagine", "Stato", "Testo estratto", "Creato il", "UtenteID"],
  Categorie: ["Categoria", "Macrocategoria", "Attiva", "Indicazioni per AI"],
} as const;
export type TableName = keyof typeof TABLE_HEADERS;
export type Cell = string | number | boolean;
export type SheetTable = { id: number; columns: number; rowCapacity?: number; rows: Cell[][] };
export type SheetSnapshot = Record<TableName, SheetTable>;
export const EXTRA_HEADERS = ["SpeseSmart hash", "SpeseSmart operazione", "SpeseSmart JSON 1"];
export const CHUNK_SIZE = 40_000;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function rowCanonical(row: Cell[]) {
  let length = row.length;
  while (length && (row[length - 1] === "" || row[length - 1] === undefined)) length--;
  return canonical(row.slice(0, length));
}
export type DocumentRevision = { editOperationId: string; previousVersion: string; movementIds: Record<string, string> };
export const DocumentDeletionSchema = z.object({ operationId: z.uuid(), previousVersion: z.string().regex(/^[a-f0-9]{64}$/), deletedAt: z.iso.datetime() }).strict();
export type DocumentDeletion = z.infer<typeof DocumentDeletionSchema>;
// A tombstone preserves IDs, amounts and creation hashes. Only status and technical JSON change.
export function deletionRows(rows: ReturnType<typeof operationRows>, deletion: DocumentDeletion) {
  return Object.fromEntries((["Movimenti", "Prodotti", "Documenti"] as const).map(sheet => [sheet, rows[sheet].map(original => {
    const start = TABLE_HEADERS[sheet].length;
    const base = original.slice(0, start + 2);
    if (sheet === "Movimenti") base[9] = "Eliminato";
    if (sheet === "Documenti") base[8] = "Eliminato";
    return [...base, ...chunks({ ...payload(original, start), deletion })];
  })])) as ReturnType<typeof operationRows>;
}
export class PersistenceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export type FinancialUser = Readonly<{ id: string }>;
export function requireFinancialUser(user: FinancialUser): string {
  if (!user || !z.uuid().safeParse(user.id).success) throw new PersistenceError("AUTH_REQUIRED", "Accesso account richiesto.");
  return user.id;
}
export const rowOwner = (sheet: "Movimenti" | "Prodotti" | "Documenti", row: Cell[]) => row[TABLE_HEADERS[sheet].length - 1];
export const unavailablePurchase = () => new PersistenceError("NOT_FOUND", "Acquisto o tentativo non disponibile.");
export function rejectClientOwner(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(utenteid|userid|ownerid|owner)$/i.test(key)) throw new PersistenceError("INVALID", "Il proprietario è assegnato esclusivamente dal server.");
    rejectClientOwner(child);
  }
}
// Preserve physical row coordinates for update/recovery. Never mutate this view
// into a compact table before building a plan against the original snapshot.
export function snapshotForUser(snapshot: SheetSnapshot, userId: string): SheetSnapshot {
  requireFinancialUser({ id: userId }); checkSchema(snapshot);
  const result = structuredClone(snapshot);
  for (const name of ["Movimenti", "Prodotti", "Documenti"] as const) {
    for (const row of snapshot[name].rows.slice(1).filter(r => r[0] && rowOwner(name, r) === userId)) {
      if (snapshot[name].rows.slice(1).some(other => other[0] === row[0] && rowOwner(name, other) !== userId)) throw unavailablePurchase();
      if (name !== "Documenti" && row[1]) {
        const documents = snapshot.Documenti.rows.slice(1).filter(r => r[0] === row[1]);
        if (documents.length !== 1 || documents.some(r => rowOwner("Documenti", r) !== userId)) throw unavailablePurchase();
      }
      if (name === "Documenti" && (["Movimenti", "Prodotti"] as const).some(sheet => snapshot[sheet].rows.slice(1).some(r => r[0] && r[1] === row[0] && rowOwner(sheet, r) !== userId))) throw unavailablePurchase();
    }
    result[name].rows = snapshot[name].rows.map((row, i) => i === 0 || rowOwner(name, row) === userId ? structuredClone(row) : []);
  }
  return result;
}
export function assertPurchaseOwner(snapshot: SheetSnapshot, documentId: string, userId: string) {
  const rows = snapshot.Documenti.rows.slice(1).filter(r => r[0] === documentId);
  if (rows.length !== 1 || rowOwner("Documenti", rows[0]) !== userId) throw unavailablePurchase();
  snapshotForUser(snapshot, userId);
}
export function assertOperationOwner(snapshot: SheetSnapshot, operationId: string, userId: string, creation = false) {
  for (const name of ["Movimenti", "Prodotti", "Documenti"] as const) {
    if (snapshot[name].rows.slice(1).some(row => row[TABLE_HEADERS[name].length + 1] === operationId && (!creation || rowOwner(name, row) !== userId))) throw unavailablePurchase();
  }
}
export function checkSchema(snapshot: SheetSnapshot) {
  for (const name of Object.keys(TABLE_HEADERS) as TableName[]) {
    const headers = snapshot[name].rows[0] ?? [];
    if (TABLE_HEADERS[name].some((h, i) => headers[i] !== h)) throw new PersistenceError("SCHEMA", `Intestazioni ${name} diverse da quelle verificate: nessuna scrittura consentita.`);
  }
}
export function extraHeaders(chunks: number) {
  return [EXTRA_HEADERS[0], EXTRA_HEADERS[1], ...Array.from({ length: chunks }, (_, i) => `SpeseSmart JSON ${i + 1}`)];
}
export function chunks(value: unknown) {
  const text = canonical(value);
  const result: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) result.push(text.slice(i, i + CHUNK_SIZE));
  return result;
}
function payload(row: Cell[], start: number) {
  if (!row[start + 2]) return null;
  try { return JSON.parse(row.slice(start + 2).join("")); }
  catch { throw new PersistenceError("CORRUPT", "Un record SpeseSmart è incompleto. Lettura bloccata, dati conservati."); }
}
const ManualSchema = z.object({ kind: z.literal("manual"), operationId: z.uuid(), draft: z.object({
  description: z.string(), date: z.string(), notes: z.string(),
  items: z.array(z.object({ category: z.string(), amount: z.string() })).min(1).max(100),
}) });
export type SaveInput = z.infer<typeof ManualSchema> | { kind: "receipt"; operationId: string; receipt: ConfirmedReceipt };
export function prepareOperation(input: unknown): { operationId: string; archive: Archive; kind: "manual" | "receipt" } {
  if (typeof input !== "object" || input === null) throw new PersistenceError("INVALID", "Richiesta di salvataggio non valida.");
  if ((input as { kind?: unknown }).kind === "manual") {
    const parsed = ManualSchema.parse(input);
    let index = 0;
    const expenses = prepareManualExpenses({ ...parsed.draft, source: "Manuale" }, () => `${parsed.operationId}-${++index}`);
    return { kind: "manual", operationId: parsed.operationId, archive: { expenses, receipts: [] } };
  }
  const data = z.object({ kind: z.literal("receipt"), operationId: z.string().min(1).max(100), receipt: z.unknown() }).parse(input);
  const receipt = data.receipt as ConfirmedReceipt;
  if (!receipt?.Documenti?.[0] || data.operationId !== receipt.Documenti[0].id) throw new PersistenceError("INVALID", "Identificativo dello scontrino non coerente.");
  const expenses = receipt.Movimenti.map(m => ({ id: m.id, merchant: m.merchant, date: m.date, category: m.category, categoryId: m.categoryId, amount: m.amountCents / 100, source: m.source, documentId: m.documentId, demo: receipt.Documenti[0].demo }));
  const archive = parseBackup(JSON.stringify(createBackup({ expenses, receipts: [receipt] }))).archive;
  if (archive.receipts[0].Documenti[0].demo || archive.expenses.some(e => movementOrigin(e, archive.receipts) === "demo" || /demo|dimostrativ|simulat/i.test(e.source) || isHistoricalIncome(e) || !isCategory(e.category))) throw new PersistenceError("DEMO", "Le demo e i record di entrata non possono essere salvati.");
  const document = receipt.Documenti[0];
  if (!reconcile({ merchant: document.merchant, date: document.date, currency: document.currency, totalCents: document.totalCents, items: receipt.Prodotti }).valid) throw new PersistenceError("QUADRATURA", "Revisione dello scontrino non valida: nessuna scrittura.");
  const totals = new Map<string, number>();
  for (const p of receipt.Prodotti) {
    if (!isCategory(p.category) || p.categoryId !== categoryDefinitions.find(c => c.name === p.category)?.id || p.amountCents === null) throw new PersistenceError("INVALID", "Prodotto non valido.");
    totals.set(p.category, (totals.get(p.category) ?? 0) + p.amountCents);
  }
  const expected = [...totals].filter(([, amount]) => amount !== 0);
  if (expected.length !== receipt.Movimenti.length || new Set(receipt.Movimenti.map(m => m.category)).size !== receipt.Movimenti.length || receipt.Movimenti.some(m => totals.get(m.category) !== m.amountCents || m.categoryId !== categoryDefinitions.find(c => c.name === m.category)?.id) || [...totals.values()].reduce((a, b) => a + b, 0) !== document.totalCents) throw new PersistenceError("QUADRATURA", "Subtotali e documento non quadrano: nessun salvataggio.");
  return { kind: "receipt", operationId: data.operationId, archive };
}
export function operationRows(op: ReturnType<typeof prepareOperation>, hash: string, revision: DocumentRevision | undefined, userId: string) {
  requireFinancialUser({ id: userId });
  const { archive, operationId } = op;
  const documentId = op.kind === "manual" ? `manual-${operationId}` : archive.receipts[0].Documenti[0].id;
  const receipt = archive.receipts[0];
  const total = archive.expenses.reduce((n, e) => n + Math.round(e.amount * 100), 0) / 100;
  const encode = (base: Cell[], data: object) => [...base, userId, hash, operationId, ...chunks({ ...data, userId })];
  return {
    Movimenti: archive.expenses.map(e => encode([e.id, documentId, e.date, "Uscita", e.description ?? e.merchant, e.merchant, e.category, -e.amount, e.source, "Confermato", e.notes ?? "", ""], e)),
    Prodotti: receipt?.Prodotti.map(p => encode([p.id, documentId, p.originalText ?? "", p.description ?? "", p.quantity ?? "", (p.amountCents ?? 0) / 100, receipt.Documenti[0].originalAnalysis.items.find(i => i.originalText === p.originalText)?.category ?? p.category, p.category, p.confidence, p.reason], p)) ?? [],
    Documenti: [encode([documentId, op.kind === "manual" ? "Manuale" : "Scontrino", archive.expenses[0]?.date ?? receipt.Documenti[0].date, archive.expenses[0]?.merchant ?? receipt.Documenti[0].merchant, total, total, 0, "", "Confermato", "", ""], { kind: op.kind, archive, ...(revision ? { revision } : {}) })],
  };
}
export function readSnapshot(source: SheetSnapshot, userId: string): { archive: Archive; warnings: string[]; persistedIds: string[]; persistedDocumentIds: string[]; deletedDocumentIds: string[] } {
  const snapshot = snapshotForUser(source, userId);
  for (const name of ["Movimenti", "Prodotti", "Documenti"] as const) {
    const ids = snapshot[name].rows.slice(1).filter(r => r[0]).map(r => String(r[0]));
    if (new Set(ids).size !== ids.length) throw new PersistenceError("DUPLICATE", `Identificativi duplicati in ${name}: lettura bloccata, righe conservate.`);
  }
  const archive: Archive = { expenses: [], receipts: [], googleSheetsSnapshot: structuredClone(snapshot) };
  const warnings: string[] = [];
  const ids = new Set<string>();
  const nativeDocumentIds = new Set<string>();
  const nativeMovementIds = new Set<string>();
  const deletedDocumentIds = new Set<string>();
  for (const row of snapshot.Documenti.rows.slice(1).filter(r => r.some(v => v !== ""))) {
    if (row[8] === "Eliminazione in corso") { warnings.push("Un’eliminazione incompleta è esclusa dalle statistiche e richiede recupero."); continue; }
    let data: { kind: string; archive: Archive; revision?: DocumentRevision; deletion?: DocumentDeletion } | null;
    try { data = payload(row, TABLE_HEADERS.Documenti.length); }
    catch (error) {
      if (row[8] !== "Eliminato") throw error;
      warnings.push("Un’eliminazione incompleta è esclusa dalle statistiche e richiede recupero."); continue;
    }
    if (!data) continue;
    const checked = validateArchive(data.archive);
    // Escludere dalle statistiche un documento parziale: le sue righe restano nello snapshot del backup.
    const original = operationRows({ kind: data.kind as "manual" | "receipt", operationId: String(row[TABLE_HEADERS.Documenti.length + 1]), archive: checked }, String(row[TABLE_HEADERS.Documenti.length]), data.revision, userId);
    for (const name of ["Movimenti", "Prodotti", "Documenti"] as const) {
      if (original[name].some(expectedRow => source[name].rows.slice(1).some(r => r[0] === expectedRow[0] && rowOwner(name, r) !== userId))) throw unavailablePurchase();
    }
    const expected = data.deletion ? deletionRows(original, DocumentDeletionSchema.parse(data.deletion)) : original;
    const complete = (["Movimenti", "Prodotti", "Documenti"] as const).every(name => expected[name].every(value => snapshot[name].rows.slice(1).some(r => rowCanonical(r) === rowCanonical(value))))
      && (["Movimenti", "Prodotti"] as const).every(name => snapshot[name].rows.slice(1).filter(r => r[1] === row[0] && r[0]).length === expected[name].length);
    if (!complete) { warnings.push("Un documento parziale è conservato nel backup ed escluso dalle statistiche."); continue; }
    if (data.deletion) { deletedDocumentIds.add(String(row[0])); continue; }
    if (checked.receipts.some(r => r.Documenti[0].demo) || checked.expenses.some(e => movementOrigin(e, checked.receipts) === "demo" || /demo|dimostrativ|simulat/i.test(e.source))) { warnings.push("Dati demo esclusi dalla dashboard."); continue; }
    if (nativeDocumentIds.has(String(row[0]))) throw new PersistenceError("DUPLICATE", "ID documento duplicato nel foglio: lettura bloccata.");
    nativeDocumentIds.add(String(row[0]));
    for (const e of checked.expenses) { if (ids.has(e.id)) throw new PersistenceError("DUPLICATE", "ID movimento duplicato."); ids.add(e.id); nativeMovementIds.add(e.id); archive.expenses.push(data.kind === "manual" ? { ...e, sheetsDocumentId: String(row[0]) } : e); }
    archive.receipts.push(...checked.receipts);
  }
  for (const row of snapshot.Movimenti.rows.slice(1).filter(r => r.some(v => v !== ""))) {
    if (nativeMovementIds.has(String(row[0])) || deletedDocumentIds.has(String(row[1]))) continue;
    if (row[TABLE_HEADERS.Movimenti.length + 1]) { warnings.push("Movimento incompleto conservato nel backup, escluso dalla dashboard."); continue; }
    const historicalIncome = /^(entrata|entrate|in|income)$/i.test(String(row[3]));
    if (!historicalIncome && !/^(uscita|uscite|out|expense)$/i.test(String(row[3]))) { warnings.push("Movimento di tipo ambiguo conservato nel backup e non aggregato."); continue; }
    if (String(row[9]).toLowerCase() !== "confermato") { warnings.push("Movimento non confermato escluso dalla dashboard."); continue; }
    const amount = typeof row[7] === "number" ? row[7] : Number(String(row[7]).replace(",", "."));
    if (row[7] === "" || row[7] === undefined || !Number.isFinite(amount) || !row[0] || !/^\d{4}-\d{2}-\d{2}$/.test(String(row[2]))) { warnings.push("Riga storica non interpretabile conservata nel backup."); continue; }
    const e = { id: String(row[0]), merchant: String(row[5] || row[4]), description: String(row[4] ?? ""), date: String(row[2]), category: String(row[6]), amount: historicalIncome ? amount : -amount, source: String(row[8]), notes: String(row[10] ?? ""), type: historicalIncome ? "income" : "expense", originalCategory: String(row[6]), sheetsDocumentId: row[1], sheetsOriginalRow: row } as Expense;
    if (movementOrigin(e, []) === "demo" || /demo|dimostrativ|simulat/i.test(e.source)) continue;
    if (ids.has(e.id)) throw new PersistenceError("DUPLICATE", "ID storico duplicato: nessun dato modificato.");
    ids.add(e.id); archive.expenses.push(isHistoricalIncome(e) ? e : normalizeHistoricalTransaction(e));
  }
  // Raw row positions/capacities and technical JSON are never part of a personal response.
  delete archive.googleSheetsSnapshot;
  return { archive, warnings: [...new Set(warnings)], persistedIds: archive.expenses.filter(e => !isHistoricalIncome(e)).map(e => e.id), persistedDocumentIds: [...nativeDocumentIds], deletedDocumentIds: [...deletedDocumentIds] };
}
