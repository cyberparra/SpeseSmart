import { z } from "zod";
import { categories, categoryIds, isCategory, currentCategoryName } from "./categories";
import type { Archive } from "./archive";
import { centsInput, parseCents, reconcile, validDate, type ConfirmedReceipt } from "./receipts/model";
import { isHistoricalIncome, prepareManualExpenses } from "./spending";
import { PersistenceError, type DocumentRevision } from "./sheets-persistence-model";

const ItemSchema = z.object({ id: z.string().min(1).max(200), description: z.string().trim().min(1).max(300), amount: z.string().max(30), category: z.string().refine(isCategory), quantity: z.number().positive().max(1_000_000).nullable(), reason: z.string().max(1000) }).strict();
export const EditDraftSchema = z.object({ merchant: z.string().trim().min(1).max(100), date: z.string(), notes: z.string().max(1000), items: z.array(ItemSchema).min(1).max(1000) }).strict();
export const EditRequestSchema = z.object({ documentId: z.string().min(1).max(200), operationId: z.uuid(), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), draft: EditDraftSchema }).strict();
export type EditDraft = z.infer<typeof EditDraftSchema>;
export type EditRequest = z.infer<typeof EditRequestSchema>;
export type EditablePurchase = { documentId: string; version: string; kind: "manual" | "receipt"; draft: EditDraft; originalAmounts: Record<string, number>; lineKinds: Record<string, string> };
export type EditablePurchases = Record<string, EditablePurchase>;

export function editableDraft(documentId: string, version: string, kind: "manual" | "receipt", archive: Archive): EditablePurchase {
  const receipt = archive.receipts[0];
  const document = receipt?.Documenti[0];
  const notes = (document as { notes?: string } | undefined)?.notes ?? archive.expenses[0]?.notes ?? "";
  const items = kind === "manual" ? archive.expenses.map(e => ({ id: e.id, description: e.description ?? e.merchant, amount: centsInput(Math.round(e.amount * 100)), category: currentCategoryName(e.category), quantity: null, reason: "" }))
    : receipt.Prodotti.map(p => ({ id: p.id, description: p.description ?? "", amount: centsInput(p.amountCents), category: currentCategoryName(p.category), quantity: p.quantity, reason: p.reason }));
  return { documentId, version, kind, draft: { merchant: document?.merchant ?? archive.expenses[0]?.merchant ?? "", date: document?.date ?? archive.expenses[0]?.date ?? "", notes, items },
    originalAmounts: Object.fromEntries(items.map(i => [i.id, parseCents(i.amount) ?? 0])), lineKinds: Object.fromEntries(items.map(i => [i.id, kind === "manual" ? "manual" : receipt.Prodotti.find(p => p.id === i.id)!.kind])) };
}
export function editDraftErrors(draft: EditDraft, editable: EditablePurchase): string[] {
  const parsed = EditDraftSchema.safeParse(draft);
  if (!parsed.success) return ["Controlla descrizioni, categorie, quantità e note."];
  const errors: string[] = [];
  try { if (!validDate(draft.date)) errors.push("Inserisci una data valida (2000–2099)."); } catch { errors.push("Inserisci una data valida (2000–2099)."); }
  if (draft.items.some(i => parseCents(i.amount) === null || (editable.kind === "manual" && parseCents(i.amount)! <= 0))) errors.push("Controlla gli importi: massimo due decimali e spese manuali positive.");
  if (draft.items.some(i => editable.kind === "receipt" && parseCents(i.amount) !== editable.originalAmounts[i.id] && !i.reason.trim())) errors.push("Motiva ogni prezzo dello scontrino modificato.");
  return errors;
}

// Start from server data. Clients can change only the explicitly editable fields.
export function revisePurchase(kind: "manual" | "receipt", source: Archive, draft: EditDraft, previousRevision?: DocumentRevision) {
  const copy = structuredClone(source);
  const base = editableDraft("", "", kind, copy);
  const errors = editDraftErrors(draft, base);
  if (errors.length) throw new PersistenceError("INVALID", errors.join(" "));
  const currentIds = new Set(base.draft.items.map(i => i.id));
  if (new Set(draft.items.map(i => i.id)).size !== currentIds.size || draft.items.length !== currentIds.size || draft.items.some(i => !currentIds.has(i.id))) throw new PersistenceError("INVALID", "Puoi correggere le righe esistenti; aggiunta e rimozione non sono abilitate.");
  if (copy.expenses.some(isHistoricalIncome) || copy.receipts.some(r => r.Documenti[0].demo)) throw new PersistenceError("INVALID", "Questo documento non è una spesa modificabile.");
  const movementIds = { ...previousRevision?.movementIds };
  if (kind === "manual") {
    prepareManualExpenses({ description: draft.merchant, date: draft.date, notes: draft.notes, source: "Manuale", items: draft.items }, () => "validation");
    copy.expenses = copy.expenses.map(e => {
      const item = draft.items.find(i => i.id === e.id)!;
      if (item.quantity !== null || item.reason) throw new PersistenceError("INVALID", "Campi manuali non coerenti.");
      return { ...e, merchant: draft.merchant.trim(), description: item.description.trim(), date: draft.date, amount: parseCents(item.amount)! / 100, category: item.category as typeof categories[number], categoryId: categoryIds[item.category as typeof categories[number]], notes: draft.notes.trim() };
    });
  } else {
    const receipt = copy.receipts[0];
    const document = receipt.Documenti[0];
    for (const m of receipt.Movimenti) movementIds[m.categoryId] = m.id;
    receipt.Prodotti = receipt.Prodotti.map(p => {
      const item = draft.items.find(i => i.id === p.id)!;
      return { ...p, description: item.description.trim(), quantity: item.quantity, amountCents: parseCents(item.amount), category: item.category as typeof categories[number], categoryId: categoryIds[item.category as typeof categories[number]], reason: item.reason.trim() };
    });
    const totalCents = receipt.Prodotti.reduce((sum, p) => sum + (p.amountCents ?? 0), 0);
    const result = reconcile({ merchant: draft.merchant, date: draft.date, currency: "EUR", totalCents, items: receipt.Prodotti });
    if (!result.valid) throw new PersistenceError("QUADRATURA", result.errors.join(" "));
    const updatedDocument = { ...document, merchant: draft.merchant.trim(), date: draft.date, totalCents, notes: draft.notes.trim(), image: "" };
    receipt.Documenti = [updatedDocument];
    receipt.Movimenti = result.subtotals.filter(s => s.amountCents !== 0).map(s => {
      const categoryId = categoryIds[s.category];
      const existing = receipt.Movimenti.find(m => m.categoryId === categoryId);
      movementIds[categoryId] ??= `${document.id}-category-${categoryId}`;
      return { ...existing, id: movementIds[categoryId], documentId: document.id, merchant: updatedDocument.merchant, date: updatedDocument.date, category: s.category, categoryId, amountCents: s.amountCents, currency: "EUR", source: "Scontrino", syncStatus: "pending" as const };
    }) as ConfirmedReceipt["Movimenti"];
    copy.expenses = receipt.Movimenti.map(m => ({ ...copy.expenses.find(e => e.id === m.id), id: m.id, documentId: document.id, merchant: m.merchant, date: m.date, category: m.category, categoryId: m.categoryId, amount: m.amountCents / 100, source: m.source, notes: draft.notes.trim(), demo: false }));
  }
  // No snapshot or images may enter the technical update journal or new payload.
  delete copy.googleSheetsSnapshot;
  return { archive: copy, movementIds };
}
