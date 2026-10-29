import "server-only";
import { createHash } from "node:crypto";
import { createBackup } from "./archive";
import { DeleteRequestSchema, type PendingPurchaseDeletion } from "./purchase-delete";
import { editableDraft } from "./purchase-edit";
import { canonical, deletionRows, readSnapshot, PersistenceError, assertOperationOwner, assertPurchaseOwner, unavailablePurchase, rejectClientOwner } from "./sheets-persistence-model";
import { documentData, editablePurchases, ownedRows, matches, verifyRecoverable, assertNoPendingUpdates } from "./sheets-updates";
import { isDeletionJournal, journalStructure, type DeletionJournal, type UpdatePatch, type UpdateStore } from "./sheets-update-store";
import type { SheetsTransport, Change } from "./sheets-repository";

const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
// Write only changed status/JSON cells, preserving formulas and all financial columns.
export function deletionChanges(patches: UpdatePatch[]): Change[] {
  return patches.flatMap(p => Array.from({ length: Math.max(p.before.length, p.after.length) }, (_, column) => ({ column, before: p.before[column] ?? "", after: p.after[column] ?? "" }))
    .filter(cell => cell.before !== cell.after)
    .map(cell => ({ sheet: p.sheet, row: p.row, column: cell.column, values: [[cell.after]] })));
}
export async function pendingPurchaseDeletions(store: UpdateStore, userId: string): Promise<PendingPurchaseDeletion[]> {
  return (await store.list()).filter((j): j is DeletionJournal => isDeletionJournal(j) && j.userId === userId && j.state === "pending").map(j => {
    const data = documentData(j.marker.before);
    return { editable: editableDraft(j.documentId, j.request.expectedVersion, data.kind, data.archive), request: j.request };
  });
}
export async function performDeletion(transport: SheetsTransport, store: UpdateStore, rawInput: unknown, userId: string) {
  rejectClientOwner(rawInput);
  const parsed = DeleteRequestSchema.safeParse(rawInput);
  if (!parsed.success) throw new PersistenceError("INVALID", "Conferma esplicitamente l’eliminazione di un acquisto valido.");
  const input = parsed.data;
  const journals = await store.list();
  const existing = journals.find(j => j.operationId === input.operationId);
  if (existing && existing.userId !== userId) throw unavailablePurchase();
  if (existing && (!isDeletionJournal(existing) || existing.requestHash !== hash({ userId, request: input }) || existing.documentId !== input.documentId)) throw new PersistenceError("EDIT_CONFLICT", "Identificativo già utilizzato con dati differenti. Nessuna eliminazione.");
  let snapshot = await transport.read();
  assertOperationOwner(snapshot, input.operationId, userId);
  assertPurchaseOwner(snapshot, input.documentId, userId);
  if (journals.some(j => j.state === "pending" && j.operationId !== input.operationId)) throw new PersistenceError("UPDATE_PENDING", "Operazioni temporaneamente non disponibili.");
  let journal = existing as DeletionJournal | undefined;
  if (!journal) {
    await assertNoPendingUpdates(store, snapshot);
    const editable = editablePurchases(snapshot, userId)[input.documentId];
    if (!editable) throw new PersistenceError("NOT_EDITABLE", "Eliminazione non disponibile per un documento storico, incompleto o già eliminato.");
    if (editable.version !== input.expectedVersion) throw new PersistenceError("EDIT_CONFLICT", "L’acquisto è cambiato. Ricarica l’archivio e controllalo prima di eliminarlo.");
    const owned = ownedRows(snapshot, input.documentId);
    const originalDocument = owned.find(r => r.sheet === "Documenti")!;
    const source = documentData(originalDocument.values);
    const rows = { Documenti: [originalDocument.values], Prodotti: owned.filter(r => r.sheet === "Prodotti").map(r => r.values), Movimenti: owned.filter(r => r.sheet === "Movimenti").map(r => r.values) };
    const createdAt = new Date().toISOString();
    const desired = deletionRows(rows, { operationId: input.operationId, previousVersion: input.expectedVersion, deletedAt: createdAt });
    if (owned.some(r => desired[r.sheet].some(row => row.length > snapshot[r.sheet].rows[0].length))) throw new PersistenceError("EDIT_TOO_LARGE", "Il marcatore richiede altre colonne tecniche. Eliminazione bloccata: nessun cambiamento di schema.");
    const marked = [...originalDocument.values]; marked[8] = "Eliminazione in corso";
    const marker: UpdatePatch = { sheet: "Documenti", row: originalDocument.row, before: originalDocument.values, after: marked };
    const patches = owned.filter(r => r.sheet !== "Documenti").map(r => ({ sheet: r.sheet, row: r.row, before: r.values, after: desired[r.sheet].find(row => row[0] === r.values[0])! }));
    journal = { kind: "delete", version: 2, userId, scope: store.scope, operationId: input.operationId, requestHash: hash({ userId, request: input }), request: input, documentId: input.documentId, state: "pending", createdAt,
      marker, patches, commit: { sheet: "Documenti", row: originalDocument.row, before: marked, after: desired.Documenti[0] },
      backup: createBackup(source.archive), ...journalStructure(snapshot) };
    if (!transport.guardDeletion) throw new PersistenceError("UPDATE_STORAGE", "Verifica delle formule non disponibile: eliminazione bloccata.");
    await store.put(journal); // private backup + before/after rows, fsync, checksum, read-back BEFORE Google
    // Preserve the exact attempt even if the readonly formula preflight fails (e.g. HTTP 403).
    await transport.guardDeletion(deletionChanges([marker, ...patches, journal.commit]), snapshot);
  }
  verifyRecoverable(snapshot, journal, true);
  const committed = matches(snapshot.Documenti.rows[journal.commit.row], journal.commit.after);
  if (committed && journal.patches.some(p => !matches(snapshot[p.sheet].rows[p.row], p.after))) throw new PersistenceError("UPDATE_CONFLICT", "Documento eliminato con righe incoerenti. Recupero bloccato.");
  if (journal.state === "complete" && !committed) throw new PersistenceError("UPDATE_CONFLICT", "L’acquisto eliminato contiene modifiche esterne. Nessuna nuova cancellazione.");
  const writeChecked = async (patches: UpdatePatch[]) => {
    snapshot = await transport.read(); verifyRecoverable(snapshot, journal!, true);
    const changes = deletionChanges(patches.filter(p => !matches(snapshot[p.sheet].rows[p.row], p.after)));
    if (!changes.length) return;
    if (!transport.guardDeletion) throw new PersistenceError("UPDATE_STORAGE", "Verifica delle formule non disponibile.");
    await transport.guardDeletion(changes, snapshot);
    try { await transport.write(changes, snapshot); } catch { /* determine result by rereading, never retry blindly */ }
    snapshot = await transport.read().catch(() => { throw new PersistenceError("UPDATE_PENDING", "Eliminazione non verificabile. Il backup è conservato: riprendi lo stesso tentativo."); });
    verifyRecoverable(snapshot, journal!, true);
    if (patches.some(p => !matches(snapshot[p.sheet].rows[p.row], p.after))) throw new PersistenceError("UPDATE_PENDING", "Eliminazione incompleta. Riprendi lo stesso tentativo; le altre scritture sono bloccate.");
  };
  if (!committed) { await writeChecked([journal.marker]); await writeChecked(journal.patches); await writeChecked([journal.commit]); }
  snapshot = await transport.read(); verifyRecoverable(snapshot, journal, true);
  const loaded = readSnapshot(snapshot, userId);
  if (!loaded.deletedDocumentIds.includes(input.documentId)) throw new PersistenceError("UPDATE_PENDING", "Eliminazione non confermata dalla rilettura delle tre raccolte.");
  if (journal.state !== "complete") await store.put({ ...journal, state: "complete" });
  return { ...loaded, editablePurchases: editablePurchases(snapshot, userId, loaded), pendingEdits: [], pendingDeletions: [], deleted: true, duplicate: journal.state === "complete", documentId: input.documentId, operationId: input.operationId };
}
