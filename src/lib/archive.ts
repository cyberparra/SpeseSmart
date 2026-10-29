import { z } from "zod";
import { categories, categoryDefinitions, legacyIncomeCategories, currentCategoryName } from "./categories";
import { demoExpenses, type Expense } from "./demo";
import { ReceiptSchema, storedReceiptSchema, type ConfirmedReceipt } from "./receipts/model";
import { isHistoricalIncome } from "./spending";
import { withoutImages } from "./image-free";

export type Archive = { expenses: Expense[]; receipts: ConfirmedReceipt[]; googleSheetsSnapshot?: unknown };
export function archiveForView(archive: Archive, compact = false): Archive {
  const copy = withoutImages(archive);
  if (compact) delete copy.googleSheetsSnapshot;
  return copy;
}
export type ResetScope = "demo" | "all";
export const DEMO_DISABLED_KEY = "spesesmart:demo-disabled:v1";
export type ResetStorage = Pick<Storage, "getItem" | "setItem">;

// This browser preference is independent of the archive persisted on Sheets.
export function initialExpenses(storage: Pick<Storage, "getItem">): Expense[] {
  return storage.getItem(DEMO_DISABLED_KEY) === "true" ? [] : demoExpenses;
}

export function movementOrigin(expense: Expense, receipts: ConfirmedReceipt[]) {
  const linked = receipts.filter((receipt) => receipt.Movimenti.some((movement) => movement.id === expense.id)
    || receipt.Documenti.some((document) => document.id === expense.documentId));
  // A real document or explicit provenance takes precedence over legacy labels.
  if (expense.demo === false || linked.some((receipt) => receipt.Documenti.some((document) => !document.demo))) return "possible-real";
  if (expense.demo === true || (linked.length > 0 && linked.every((receipt) => receipt.Documenti.every((document) => document.demo)))) return "demo";
  const fixture = demoExpenses.find((demo) => demo.id === expense.id);
  if (fixture && fixture.merchant === expense.merchant && fixture.date === expense.date
    && fixture.amount === expense.amount && fixture.source === expense.source
    && fixture.category === (expense.originalCategory ?? expense.category)) return "demo";
  // The existing screenshot workflow has always produced simulated data.
  if (["Scontrino demo", "Screenshot", "Screenshot demo"].includes(expense.source)) return "demo";
  return "possible-real";
}

export function inspectArchive(archive: Archive) {
  const demo = archive.expenses.filter((expense) => movementOrigin(expense, archive.receipts) === "demo").length;
  return {
    movements: archive.expenses.length,
    demo,
    possibleReal: archive.expenses.length - demo,
    documents: archive.receipts.reduce((sum, receipt) => sum + receipt.Documenti.length, 0),
    products: archive.receipts.reduce((sum, receipt) => sum + receipt.Prodotti.length, 0),
  };
}

export function planReset(archive: Archive, scope: ResetScope) {
  const candidates = archive.expenses.filter((expense) => !isHistoricalIncome(expense)
    && (scope === "all" || movementOrigin(expense, archive.receipts) === "demo"));
  const ids = new Set(candidates.map((expense) => expense.id));
  const receipts = archive.receipts.filter((receipt) => (
    (scope === "all" || receipt.Documenti.every((document) => document.demo))
    && receipt.Movimenti.every((movement) => !isHistoricalIncome(movement)
      && (!archive.expenses.some((expense) => expense.id === movement.id) || ids.has(movement.id)))
    && archive.expenses.filter((expense) => receipt.Documenti.some((document) => document.id === expense.documentId)).every((expense) => ids.has(expense.id))
  ));
  // Preserve a whole receipt if any of its movements must remain.
  const keptReceipts = archive.receipts.filter((receipt) => !receipts.includes(receipt));
  const removed = candidates.filter((expense) => !keptReceipts.some((receipt) =>
    receipt.Movimenti.some((movement) => movement.id === expense.id)
    || receipt.Documenti.some((document) => document.id === expense.documentId)));
  return {
    movements: removed.length,
    possibleReal: removed.filter((expense) => movementOrigin(expense, archive.receipts) === "possible-real").length,
    documents: receipts.reduce((sum, receipt) => sum + receipt.Documenti.length, 0),
    products: receipts.reduce((sum, receipt) => sum + receipt.Prodotti.length, 0),
    remaining: archive.expenses.length - removed.length,
    expenseIds: removed.map((expense) => expense.id),
    documentIds: receipts.flatMap((receipt) => receipt.Documenti.map((document) => document.id)),
  };
}

export function createBackup(archive: Archive, exportedAt = new Date().toISOString()) {
  return backupEnvelope(withoutImages(archive), exportedAt);
}
function backupEnvelope(archive: Archive, exportedAt = new Date().toISOString()) {
  return structuredClone({
    application: "SpeseSmart" as const,
    version: 1 as const,
    exportedAt,
    storage: "session-memory" as const,
    units: { expenses: "EUR", receiptAmounts: "integer-cents" } as const,
    categories: categoryDefinitions,
    counts: inspectArchive(archive),
    archive,
  });
}
export type ArchiveBackup = ReturnType<typeof createBackup>;

const category = z.string().refine(value => [...categories, "Shopping", "Casa", "Svago", "Salute", ...legacyIncomeCategories].includes(currentCategoryName(value)));
const id = z.string().min(1);
const date = z.iso.date();
const expenseSchema = z.object({
  id, merchant: z.string(), date, category, amount: z.number().finite(), source: z.string(),
  originalCategory: z.string().optional(), documentId: id.optional(), demo: z.boolean().optional(),
  notes: z.string().optional(), type: z.string().optional(), tipo: z.string().optional(),
  direction: z.string().optional(), kind: z.string().optional(), categoryId: z.string().optional(),
}).passthrough();
const receiptSchema = z.object({
  Documenti: z.array(z.object({
    id, merchant: z.string(), date, totalCents: z.number().int(), currency: z.literal("EUR"),
    image: z.string().refine((value) => value === "" || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/.test(value)),
    imageHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    originalAnalysis: z.lazy(() => storedReceiptSchema()), demo: z.boolean(), syncStatus: z.literal("pending"),
  }).passthrough()).length(1),
  Prodotti: z.array(ReceiptSchema.shape.items.element.extend({
    category,
    id, documentId: id, categoryId: id, kind: z.enum(["product", "discount", "extra", "adjustment", "refund"]), reason: z.string(),
  }).passthrough()),
  Movimenti: z.array(z.object({
    id, documentId: id, merchant: z.string(), date, category, categoryId: id,
    amountCents: z.number().int(), currency: z.literal("EUR"), source: z.string(), syncStatus: z.literal("pending"),
  }).passthrough()),
}).passthrough();
const backupSchema = z.object({
  application: z.literal("SpeseSmart"), version: z.literal(1), exportedAt: z.iso.datetime(),
  storage: z.literal("session-memory"),
  units: z.object({ expenses: z.literal("EUR"), receiptAmounts: z.literal("integer-cents") }),
  categories: z.array(z.unknown()), counts: z.object({
    movements: z.number().int(), demo: z.number().int(), possibleReal: z.number().int(),
    documents: z.number().int(), products: z.number().int(),
  }),
  archive: z.object({ expenses: z.array(expenseSchema), receipts: z.array(receiptSchema) }),
});

export function parseBackup(text: string): ArchiveBackup {
  const raw: unknown = JSON.parse(text);
  // Validate without normalizing or stripping original fields from the export.
  backupSchema.parse(raw);
  const backup = raw as ArchiveBackup;
  const { expenses, receipts } = backup.archive;
  function unique(ids: string[]) {
    if (new Set(ids).size !== ids.length) throw new Error("Il backup contiene identificativi duplicati.");
  }
  unique(expenses.map((expense) => expense.id));
  unique(receipts.flatMap((receipt) => receipt.Documenti.map((document) => document.id)));
  unique(receipts.flatMap((receipt) => receipt.Movimenti.map((movement) => movement.id)));
  unique(receipts.flatMap((receipt) => receipt.Prodotti.map((product) => product.id)));
  for (const receipt of receipts) {
    const document = receipt.Documenti[0];
    for (const item of [...receipt.Prodotti, ...receipt.Movimenti]) {
      if (item.documentId !== document.id) throw new Error("Collegamenti allo scontrino non validi.");
    }
    for (const movement of receipt.Movimenti) {
      const expense = expenses.find((item) => item.id === movement.id);
      if (!expense || Math.round(expense.amount * 100) !== movement.amountCents
        || (expense.documentId && expense.documentId !== document.id)) throw new Error("Movimenti dello scontrino incompleti o incoerenti.");
    }
  }
  for (const expense of expenses) {
    if (expense.documentId && !receipts.some((receipt) => receipt.Documenti.some((document) => document.id === expense.documentId)
      && receipt.Movimenti.some((movement) => movement.id === expense.id))) throw new Error("Documento del movimento mancante.");
  }
  const counts = inspectArchive(backup.archive);
  if (Object.keys(counts).some((key) => counts[key as keyof typeof counts] !== backup.counts[key as keyof typeof counts])) throw new Error("Conteggi del backup non coerenti.");
  return backup;
}

export function sameArchive(first: Archive, second: Archive) {
  return JSON.stringify(withoutImages(first)) === JSON.stringify(withoutImages(second));
}

export function validateArchive(archive: Archive): Archive {
  return parseBackup(JSON.stringify(backupEnvelope(archive))).archive;
}

export function resetConfirmation(count: number) {
  return `ELIMINA ${count} MOVIMENTI`;
}

export function resetArchive(current: Archive, backup: ArchiveBackup, scope: ResetScope, confirmation: string, storage: ResetStorage): Archive {
  const checked = parseBackup(JSON.stringify(backup));
  if (!sameArchive(current, checked.archive)) throw new Error("L’archivio è cambiato: esporta un nuovo backup prima del reset.");
  const plan = planReset(current, scope);
  if (confirmation !== resetConfirmation(plan.movements)) throw new Error("Digita la conferma esatta prima di eliminare i movimenti.");
  const next = {
    ...current,
    expenses: current.expenses.filter((expense) => !plan.expenseIds.includes(expense.id)),
    receipts: current.receipts.filter((receipt) => !receipt.Documenti.some((document) => plan.documentIds.includes(document.id))),
  };
  // Persist and verify before touching session state; never clear unrelated storage.
  storage.setItem(DEMO_DISABLED_KEY, "true");
  if (storage.getItem(DEMO_DISABLED_KEY) !== "true") throw new Error("Impossibile memorizzare il reset: nessun movimento eliminato.");
  return next;
}

// Restore by merging IDs: never overwrite current movements or duplicate a receipt.
export function restoreBackup(current: Archive, backup: ArchiveBackup): Archive {
  const checked = parseBackup(JSON.stringify(backup));
  function merge<T>(existing: T[], incoming: T[], key: (item: T) => string): T[] {
    const result = [...existing];
    for (const item of incoming) {
      const previous = result.find((entry) => key(entry) === key(item));
      if (previous && JSON.stringify(withoutImages(previous)) !== JSON.stringify(withoutImages(item))) throw new Error("Un identificativo esiste già con dati diversi. Nessun dato è stato sovrascritto.");
      if (!previous) result.push(structuredClone(item));
    }
    return result;
  }
  const merged = {
    ...current,
    ...(checked.archive.googleSheetsSnapshot === undefined ? {} : {
      googleSheetsSnapshot: mergeSnapshots(current.googleSheetsSnapshot, checked.archive.googleSheetsSnapshot),
    }),
    expenses: merge(current.expenses, checked.archive.expenses, (expense) => expense.id),
    receipts: merge(current.receipts, checked.archive.receipts, (receipt) => receipt.Documenti[0].id),
  };
  parseBackup(JSON.stringify(createBackup(merged)));
  return merged;
}

function mergeSnapshots(current: unknown, incoming: unknown): unknown {
  if (current === undefined) return structuredClone(incoming);
  if (JSON.stringify(withoutImages(current)) === JSON.stringify(withoutImages(incoming))) return current;
  const unpack = (value: unknown): unknown[] => value !== null && typeof value === "object" && "snapshots" in value && Array.isArray(value.snapshots) ? value.snapshots : [value];
  const snapshots = [...unpack(current)];
  for (const snapshot of unpack(incoming)) {
    if (!snapshots.some(existing => JSON.stringify(withoutImages(existing)) === JSON.stringify(withoutImages(snapshot)))) snapshots.push(structuredClone(snapshot));
  }
  return snapshots.length === unpack(current).length ? current : { snapshots };
}
