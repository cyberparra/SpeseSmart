import "server-only";
import { createHash } from "node:crypto";
import { EditRequestSchema, editableDraft, revisePurchase, type EditablePurchases, type EditablePurchase, type EditRequest } from "./purchase-edit";
import { canonical, operationRows, prepareOperation, readSnapshot, rowCanonical, TABLE_HEADERS, PersistenceError, assertOperationOwner, assertPurchaseOwner, rowOwner, unavailablePurchase, rejectClientOwner, type DocumentRevision, type SheetSnapshot, type Cell } from "./sheets-persistence-model";
import { validateArchive, type Archive } from "./archive";
import { withoutImages } from "./image-free";
import { isHistoricalIncome } from "./spending";
import { journalStructure, isDeletionJournal, type UpdateJournal, type UpdatePatch, type UpdateStore } from "./sheets-update-store";
import type { SheetsTransport, Change } from "./sheets-repository";

const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const tables = ["Documenti", "Prodotti", "Movimenti"] as const;
type NativeDocument = { kind: "manual" | "receipt"; archive: Archive; revision?: DocumentRevision };
export function documentData(row: Cell[]): NativeDocument {
  try {
    const data = JSON.parse(row.slice(TABLE_HEADERS.Documenti.length + 2).join("")) as NativeDocument;
    if (!["manual", "receipt"].includes(data.kind)) throw new Error();
    validateArchive(data.archive);
    return data;
  } catch { throw new PersistenceError("NOT_EDITABLE", "Documento storico o incompleto: modifica non disponibile."); }
}
export function ownedRows(snapshot: SheetSnapshot, documentId: string) {
  return tables.flatMap(sheet => snapshot[sheet].rows.flatMap((values, row) => row > 0 && (sheet === "Documenti" ? values[0] === documentId : values[1] === documentId) ? [{ sheet, row, values }] : []));
}
export function documentVersion(snapshot: SheetSnapshot, documentId: string) {
  return hash(ownedRows(snapshot, documentId).map(r => ({ ...r, values: rowCanonical(r.values) })));
}
export function editablePurchases(snapshot: SheetSnapshot, userId: string, loaded = readSnapshot(snapshot, userId)): EditablePurchases {
  const result: EditablePurchases = {};
  for (const row of snapshot.Documenti.rows.slice(1)) {
    const id = String(row[0] ?? "");
    if (!loaded.persistedDocumentIds.includes(id) || !row[TABLE_HEADERS.Documenti.length + 2]) continue;
    // Old embedded photographs require a separate authorized cleanup, never copying into the journal.
    const originalRows = ownedRows(snapshot, id);
    if (/data:image\//i.test(JSON.stringify(originalRows)) || canonical(withoutImages(originalRows)) !== canonical(originalRows)) continue;
    try { const data = documentData(row); if (data.archive.expenses.some(isHistoricalIncome) || canonical(withoutImages(data.archive)) !== canonical(data.archive)) continue; result[id] = editableDraft(id, documentVersion(snapshot, id), data.kind, data.archive); }
    catch { /* remain consultable, explicitly not editable */ }
  }
  return result;
}
export type PendingPurchaseEdit = { editable: EditablePurchase; request: EditRequest };
export async function pendingPurchaseEdits(store: UpdateStore, userId: string): Promise<PendingPurchaseEdit[]> {
  return (await store.list()).filter((j): j is UpdateJournal => !isDeletionJournal(j) && j.userId === userId && j.state === "pending").map(j => {
    const data = documentData(j.marker.before);
    return { editable: editableDraft(j.documentId, j.request.expectedVersion, data.kind, data.archive), request: j.request };
  });
}
export async function assertNoPendingUpdates(store: UpdateStore, snapshot?: SheetSnapshot) {
  if ((await store.list()).some(j => j.state === "pending") || snapshot?.Documenti.rows.some(r => ["Aggiornamento in corso", "Eliminazione in corso"].includes(String(r[8])))) throw new PersistenceError("UPDATE_PENDING", "Operazioni temporaneamente non disponibili.");
}
export function planUpdate(snapshot: SheetSnapshot, rawInput: unknown, scope: string, userId: string): UpdateJournal {
  rejectClientOwner(rawInput);
  const parsed = EditRequestSchema.safeParse(rawInput);
  if (!parsed.success) throw new PersistenceError("INVALID", "Controlla i dati della modifica.");
  const input = parsed.data;
  if (/data:image\//i.test(JSON.stringify(input))) throw new PersistenceError("INVALID", "Le fotografie non possono essere salvate.");
  assertOperationOwner(snapshot, input.operationId, userId);
  assertPurchaseOwner(snapshot, input.documentId, userId);
  const editable = editablePurchases(snapshot, userId)[input.documentId];
  if (!editable) throw new PersistenceError("NOT_EDITABLE", "Documento non modificabile o incompleto. Ricarica l’archivio.");
  if (editable.version !== input.expectedVersion) throw new PersistenceError("EDIT_CONFLICT", "L’acquisto è cambiato dopo l’apertura. Ricarica l’archivio prima di modificarlo.");
  const documentRow = snapshot.Documenti.rows.findIndex(r => r[0] === input.documentId);
  const beforeDocument = snapshot.Documenti.rows[documentRow];
  const source = documentData(beforeDocument);
  const revised = revisePurchase(source.kind, source.archive, input.draft, source.revision);
  const archive = withoutImages(revised.archive);
  const creationId = String(beforeDocument[TABLE_HEADERS.Documenti.length + 1]);
  if (!creationId || (source.kind === "manual" && input.documentId !== `manual-${creationId}`) || (source.kind === "receipt" && input.documentId !== archive.receipts[0].Documenti[0].id)) throw new PersistenceError("NOT_EDITABLE", "Collegamenti del documento non coerenti.");
  if (source.kind === "receipt") prepareOperation({ kind: "receipt", operationId: input.documentId, receipt: archive.receipts[0] });
  validateArchive(archive);
  const revision: DocumentRevision = { editOperationId: input.operationId, previousVersion: input.expectedVersion, movementIds: revised.movementIds };
  const operation = { kind: source.kind, archive, operationId: creationId };
  const rows = operationRows(operation, hash({ ...operation, revision, userId }), revision, userId);
  const patches: UpdatePatch[] = [];
  for (const sheet of ["Prodotti", "Movimenti"] as const) {
    let nextRow = snapshot[sheet].rows.length;
    const owned = ownedRows(snapshot, input.documentId).filter(r => r.sheet === sheet);
    for (const desired of rows[sheet]) {
      const existing = owned.find(r => r.values[0] === desired[0]);
      if (!existing && snapshot[sheet].rows.some(r => r[0] === desired[0])) throw new PersistenceError("EDIT_CONFLICT", "Un ID appartiene a un altro documento. Nessuna modifica.");
      patches.push({ sheet, row: existing?.row ?? nextRow++, before: existing?.values ?? [], after: desired });
    }
    for (const old of owned.filter(r => !rows[sheet].some(row => row[0] === r.values[0]))) patches.push({ sheet, row: old.row, before: old.values, after: [] });
  }
  if (tables.some(sheet => rows[sheet].some(row => row.length > snapshot[sheet].rows[0].length))) throw new PersistenceError("EDIT_TOO_LARGE", "La modifica richiede ulteriori colonne tecniche. Nessun aggiornamento eseguito: occorre un allineamento separato.");
  const markerRow = [...beforeDocument]; markerRow[8] = "Aggiornamento in corso";
  const marker: UpdatePatch = { sheet: "Documenti", row: documentRow, before: beforeDocument, after: markerRow };
  return { version: 2, userId, scope, operationId: input.operationId, requestHash: hash({ userId, request: input }), request: input, documentId: input.documentId, state: "pending", marker, patches,
    commit: { sheet: "Documenti", row: documentRow, before: markerRow, after: rows.Documenti[0] }, ...journalStructure(snapshot), createdAt: new Date().toISOString() };
}
export function matches(row: Cell[] | undefined, expected: Cell[]) { return rowCanonical(row ?? []) === rowCanonical(expected); }
export function verifyRecoverable(snapshot: SheetSnapshot, journal: Pick<UpdateJournal, "headers" | "sheetIds" | "marker" | "patches" | "commit" | "documentId" | "userId">, cellRecovery = false) {
  assertPurchaseOwner(snapshot, journal.documentId, journal.userId);
  for (const patch of [journal.marker, ...journal.patches, journal.commit]) {
    const current = snapshot[patch.sheet].rows[patch.row];
    if (current?.some(cell => cell !== "") && rowOwner(patch.sheet, current) !== journal.userId) throw unavailablePurchase();
    if ([patch.before, patch.after].some(row => row.some(cell => cell !== "") && rowOwner(patch.sheet, row) !== journal.userId)) throw unavailablePurchase();
  }
  verifyRecoverableRows(snapshot, journal, cellRecovery);
}
// Structural recovery checks also serve offline v1 backup validation. Active
// writes must use verifyRecoverable above, which additionally enforces ownership.
export function verifyRecoverableRows(snapshot: SheetSnapshot, journal: Pick<UpdateJournal, 'headers' | 'sheetIds' | 'marker' | 'patches' | 'commit' | 'documentId'>, cellRecovery = false) {
  const permitted = (row: Cell[] | undefined, states: Cell[][]) => cellRecovery
    ? Array.from({ length: Math.max(row?.length ?? 0, ...states.map(s => s.length)) }, (_, column) => states.some(s => (s[column] ?? "") === (row?.[column] ?? ""))).every(Boolean)
    : states.some(s => matches(row, s));
  const structure = journalStructure(snapshot);
  if (canonical(structure.headers) !== canonical(journal.headers) || canonical(structure.sheetIds) !== canonical(journal.sheetIds)) throw new PersistenceError("UPDATE_CONFLICT", "La struttura è cambiata durante l’aggiornamento. Recupero bloccato, dati conservati.");
  for (const patch of journal.patches) {
    if (!permitted(snapshot[patch.sheet].rows[patch.row], [patch.before, patch.after])) throw new PersistenceError("UPDATE_CONFLICT", "Una riga è stata modificata fuori dall’operazione. Recupero bloccato per evitare sovrascritture.");
  }
  const row = snapshot.Documenti.rows[journal.marker.row];
  if (!permitted(row, [journal.marker.before, journal.marker.after, journal.commit.after])) throw new PersistenceError("UPDATE_CONFLICT", "Il documento contiene modifiche estranee. Recupero bloccato.");
  // No extra linked or duplicate rows may be silently accepted during recovery.
  const expectedCoordinates = new Set([journal.marker, ...journal.patches].map(p => `${p.sheet}:${p.row}`));
  if (ownedRows(snapshot, journal.documentId).some(r => !expectedCoordinates.has(`${r.sheet}:${r.row}`))) throw new PersistenceError("UPDATE_CONFLICT", "Righe collegate inattese: recupero bloccato.");
  for (const patch of [journal.commit, ...journal.patches]) if (patch.after[0]) {
    if (snapshot[patch.sheet].rows.some((r, index) => index !== patch.row && r[0] === patch.after[0])) throw new PersistenceError("UPDATE_CONFLICT", "ID duplicato durante il recupero.");
  }
}
function patchChange(patch: UpdatePatch): Change {
  const length = Math.max(patch.before.length, patch.after.length);
  return { sheet: patch.sheet, row: patch.row, column: 0, values: [[...patch.after, ...Array(length - patch.after.length).fill("")]] };
}
export async function performUpdate(transport: SheetsTransport, store: UpdateStore, rawInput: unknown, userId: string) {
  rejectClientOwner(rawInput);
  const parsed = EditRequestSchema.safeParse(rawInput);
  if (!parsed.success) throw new PersistenceError("INVALID", "Controlla i dati della modifica.");
  const input = parsed.data;
  const journals = await store.list();
  const existing = journals.find(j => j.operationId === input.operationId);
  if (existing && existing.userId !== userId) throw unavailablePurchase();
  if (existing && isDeletionJournal(existing)) throw new PersistenceError("EDIT_CONFLICT", "Identificativo già usato per un’eliminazione.");
  let journal = existing;
  if (journal && (journal.requestHash !== hash({ userId, request: input }) || journal.documentId !== input.documentId)) throw new PersistenceError("EDIT_CONFLICT", "Lo stesso invio contiene dati differenti. Nessuna sovrascrittura.");
  let snapshot = await transport.read();
  assertOperationOwner(snapshot, input.operationId, userId);
  assertPurchaseOwner(snapshot, input.documentId, userId);
  if (journals.some(j => j.state === "pending" && j.operationId !== input.operationId)) throw new PersistenceError("UPDATE_PENDING", "Operazioni temporaneamente non disponibili.");
  if (journal?.state === "complete") {
    const loaded = readSnapshot(snapshot, userId);
    return { ...loaded, editablePurchases: editablePurchases(snapshot, userId, loaded), updated: true, duplicate: true, documentId: journal.documentId, operationId: journal.operationId };
  }
  if (!journal) {
    await assertNoPendingUpdates(store, snapshot);
    journal = planUpdate(snapshot, input, store.scope, userId);
    await store.put(journal); // fsync + read-back BEFORE any remote mutation
  }
  verifyRecoverable(snapshot, journal);
  const writeChecked = async (patches: UpdatePatch[]) => {
    // Reread before every phase; foreign content blocks forward recovery.
    snapshot = await transport.read(); verifyRecoverable(snapshot, journal!);
    const changes = patches.filter(p => !matches(snapshot[p.sheet].rows[p.row], p.after)).map(patchChange);
    if (!changes.length) return;
    try { await transport.write(changes, snapshot); }
    catch { /* Never retry blindly: the following read determines the exact result. */ }
    snapshot = await transport.read().catch(() => { throw new PersistenceError("UPDATE_PENDING", "Esito non verificabile. L’operazione è registrata: riprendi lo stesso invio, senza cambiare i dati."); });
    verifyRecoverable(snapshot, journal!);
    if (patches.some(p => !matches(snapshot[p.sheet].rows[p.row], p.after))) throw new PersistenceError("UPDATE_PENDING", "Aggiornamento incompleto. Riprendi lo stesso invio per completarlo; nuove scritture sono bloccate.");
  };
  // A completed document plus incomplete children is a foreign state, never overwrite it.
  const committed = matches(snapshot.Documenti.rows[journal.marker.row], journal.commit.after);
  if (committed && journal.patches.some(p => !matches(snapshot[p.sheet].rows[p.row], p.after))) throw new PersistenceError("UPDATE_CONFLICT", "Documento finale con righe incoerenti: recupero bloccato.");
  if (!committed) {
    await writeChecked([journal.marker]);
    await writeChecked(journal.patches);
    await writeChecked([journal.commit]);
  }
  snapshot = await transport.read(); verifyRecoverable(snapshot, journal);
  if (!matches(snapshot.Documenti.rows[journal.commit.row], journal.commit.after) || journal.patches.some(p => !matches(snapshot[p.sheet].rows[p.row], p.after))) throw new PersistenceError("UPDATE_PENDING", "Rilettura finale incompleta: nessuna conferma di salvataggio.");
  const loaded = readSnapshot(snapshot, userId);
  if (!loaded.persistedDocumentIds.includes(journal.documentId)) throw new PersistenceError("UPDATE_PENDING", "Il documento non supera la verifica finale. Riprendi l’operazione.");
  await store.put({ ...journal, state: "complete" });
  return { ...loaded, editablePurchases: editablePurchases(snapshot, userId, loaded), updated: true, duplicate: false, documentId: journal.documentId, operationId: journal.operationId };
}
