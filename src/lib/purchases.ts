import { categoryDefinitions, normalizeHistoricalTransaction, type Category } from "./categories";
import { movementOrigin, type Archive } from "./archive";
import { expenseCents, isHistoricalIncome } from "./spending";
import { parseCents, type ConfirmedReceipt } from "./receipts/model";

export type PurchaseOrigin = "Scontrino" | "Manuale" | "Screenshot" | "Altro";
export const purchaseOrigins: PurchaseOrigin[] = ["Scontrino", "Manuale", "Screenshot", "Altro"];
export type PurchaseProduct = { id: string; description: string; originalText: string | null; quantity: number | null; amountCents: number | null; category: Category; kind: string; notes: string };
export type Purchase = {
  id: string; date: string; merchant: string; origin: PurchaseOrigin; totalCents: number;
  descriptions: string[]; notes: string[]; products: PurchaseProduct[];
  subtotals: { category: Category; amountCents: number }[];
};
export type PurchaseFilters = { query: string; category: string; from: string; to: string; min: string; max: string; origin: string; sort: "date-desc" | "date-asc" | "amount-desc" | "amount-asc" };
export const emptyPurchaseFilters: PurchaseFilters = { query: "", category: "", from: "", to: "", min: "", max: "", origin: "", sort: "date-desc" };
const text = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("it-IT");
const unique = (values: string[]) => [...new Set(values.filter(value => value.trim()))];

// Only pass the archive acknowledged by the server, never the local import/edit view.
export function buildPurchases(archive: Pick<Archive, "expenses" | "receipts">): Purchase[] {
  const receipts = archive.receipts.filter(r => !r.Documenti[0].demo && r.Movimenti.every(m => !isHistoricalIncome(m)
    && !archive.expenses.some(e => e.id === m.id && isHistoricalIncome(e))));
  const byMovement = new Map(receipts.flatMap(r => r.Movimenti.map(m => [m.id, r.Documenti[0].id] as const)));
  const receiptByDocument = new Map(receipts.map(r => [r.Documenti[0].id, r]));
  const excludedReceipts = archive.receipts.filter(r => !receiptByDocument.has(r.Documenti[0].id));
  const excludedDocuments = new Set(excludedReceipts.map(r => r.Documenti[0].id));
  const excludedMovements = new Set(excludedReceipts.flatMap(r => r.Movimenti.map(m => m.id)));
  const groups = new Map<string, ReturnType<typeof normalizeHistoricalTransaction<Archive["expenses"][number]>>[]>();
  for (const original of archive.expenses) {
    if (isHistoricalIncome(original) || excludedMovements.has(original.id) || excludedDocuments.has(original.documentId ?? original.sheetsDocumentId ?? "") || movementOrigin(original, archive.receipts) === "demo" || /demo|dimostrativ|simulat/i.test(original.source)) continue;
    const movement = normalizeHistoricalTransaction(original);
    const documentId = movement.documentId || movement.sheetsDocumentId || byMovement.get(movement.id);
    const key = documentId ? `document:${documentId}` : `movement:${movement.id}`;
    groups.set(key, [...(groups.get(key) ?? []), movement]);
  }
  // Confirmed zero-total exchanges can have products but no category movements.
  for (const documentId of receiptByDocument.keys()) if (!groups.has(`document:${documentId}`)) groups.set(`document:${documentId}`, []);
  return [...groups].map(([id, movements]) => {
    const receipt: ConfirmedReceipt | undefined = id.startsWith("document:") ? receiptByDocument.get(id.slice(9)) : undefined;
    const document = receipt?.Documenti[0];
    const products = receipt?.Prodotti.map(p => ({ id: p.id, description: p.description ?? "Descrizione non disponibile", originalText: p.originalText, quantity: p.quantity, amountCents: p.amountCents, category: normalizeHistoricalTransaction({ ...p, description: p.description ?? undefined }).category, kind: p.kind, notes: p.reason })) ?? [];
    const source = movements[0]?.source ?? "Scontrino";
    const origin: PurchaseOrigin = receipt || /scontrino/i.test(source) ? "Scontrino" : /manual/i.test(source) ? "Manuale" : /screenshot/i.test(source) ? "Screenshot" : "Altro";
    const subtotals = categoryDefinitions.flatMap(({ name: category }) => {
      const lines = products.filter(p => p.category === category);
      const entries = movements.filter(m => m.category === category);
      return lines.length || entries.length ? [{ category, amountCents: products.length ? lines.reduce((sum, p) => sum + (p.amountCents ?? 0), 0) : entries.reduce((sum, m) => sum + expenseCents(m), 0) }] : [];
    });
    const documentNotes = (document as { notes?: unknown } | undefined)?.notes;
    return { id, date: document?.date ?? movements[0].date, merchant: document?.merchant ?? movements[0].merchant,
      origin, totalCents: document?.totalCents ?? movements.reduce((sum, m) => sum + expenseCents(m), 0),
      products, subtotals, descriptions: unique(movements.map(m => m.description ?? m.merchant)),
      notes: unique([...movements.map(m => m.notes ?? ""), ...(typeof documentNotes === "string" ? [documentNotes] : [])]),
    };
  });
}

export function purchaseFilterErrors(filters: PurchaseFilters): string[] {
  const errors: string[] = [];
  if (filters.from && filters.to && filters.from > filters.to) errors.push("La data iniziale deve precedere quella finale.");
  const min = filters.min.trim() ? parseCents(filters.min) : null;
  const max = filters.max.trim() ? parseCents(filters.max) : null;
  if ((filters.min.trim() && min === null) || (filters.max.trim() && max === null)) errors.push("Inserisci importi validi con al massimo due decimali.");
  if (min !== null && max !== null && min > max) errors.push("L’importo minimo deve essere inferiore o uguale al massimo.");
  return errors;
}
export function filterPurchases(purchases: Purchase[], filters: PurchaseFilters): Purchase[] {
  if (purchaseFilterErrors(filters).length) return [];
  const words = text(filters.query).trim().split(/\s+/).filter(Boolean);
  const min = filters.min.trim() ? parseCents(filters.min) : null;
  const max = filters.max.trim() ? parseCents(filters.max) : null;
  const filtered = purchases.filter(p => {
    const searchable = text([p.merchant, ...p.descriptions, ...p.products.flatMap(product => [product.description, product.originalText ?? ""])].join(" "));
    return words.every(word => searchable.includes(word)) && (!filters.category || p.subtotals.some(s => s.category === filters.category))
      && (!filters.from || p.date >= filters.from) && (!filters.to || p.date <= filters.to)
      && (min === null || p.totalCents >= min) && (max === null || p.totalCents <= max)
      && (!filters.origin || p.origin === filters.origin);
  });
  return filtered.sort((a, b) => {
    const difference = filters.sort.startsWith("amount") ? a.totalCents - b.totalCents : a.date.localeCompare(b.date);
    return difference ? (filters.sort.endsWith("desc") ? -difference : difference) : a.id.localeCompare(b.id);
  });
}
