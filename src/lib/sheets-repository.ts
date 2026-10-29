import "server-only";
import { createHash } from "node:crypto";
import { sheets, type sheets_v4 } from "@googleapis/sheets";
import { categoryDefinitions, currentCategoryName } from "./categories";
import { createGoogleSheetsAuth, googleSheetsWritesEnabled } from "./google-sheets";
import { canonical, rowCanonical, checkSchema, extraHeaders, operationRows, prepareOperation, readSnapshot, TABLE_HEADERS, PersistenceError, snapshotForUser, requireFinancialUser, rejectClientOwner, rowOwner, unavailablePurchase, assertOperationOwner, type FinancialUser, type Cell, type SheetSnapshot, type TableName } from "./sheets-persistence-model";
import { createUpdateStore, type UpdateStore } from "./sheets-update-store";
import { assertNoPendingUpdates, editablePurchases, pendingPurchaseEdits, performUpdate } from "./sheets-updates";
import { pendingPurchaseDeletions, performDeletion } from "./sheets-deletions";

export type Change = { sheet: TableName; row: number; column: number; values: Cell[][] } | { insertCategoryRow: number };
export type Plan = { changes: Change[]; fingerprint: string };
export interface SheetsTransport {
  read(): Promise<SheetSnapshot>;
  write(changes: Change[], snapshot: SheetSnapshot): Promise<void>;
  guardDeletion?(changes: Change[], snapshot: SheetSnapshot): Promise<void>;
}
const hash = (data: unknown) => createHash("sha256").update(canonical(data)).digest("hex");
export function createSheetsTransport(env: NodeJS.ProcessEnv = process.env, makeApi = (auth: ReturnType<typeof createGoogleSheetsAuth>) => sheets({ version: "v4", auth })): SheetsTransport {
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  if (!spreadsheetId || !/^[\w-]+$/.test(spreadsheetId)) throw new PersistenceError("CONFIGURATION", "Identificativo Google Sheets mancante o non valido.");
  const options = () => ({ timeout: 20_000, retry: false as const, signal: AbortSignal.timeout(20_000) });
  return {
    async guardDeletion(changes, snapshot) {
      const api = makeApi(createGoogleSheetsAuth(env));
      const columnName = (index: number): string => {
        let name = "";
        for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
        return name;
      };
      const ranges = changes.flatMap(c => {
        if (!("sheet" in c) || c.row < 1 || c.sheet === "Categorie" || !snapshot[c.sheet] || snapshot[c.sheet].id == null) throw new PersistenceError("UPDATE_CONFLICT", "Intervallo di eliminazione non consentito.");
        if (!Number.isInteger(c.column) || c.column < 0 || !Number.isInteger(c.row) || !c.values.length || c.values.some(r => !r.length)) throw new PersistenceError("UPDATE_CONFLICT", "Intervallo di eliminazione non valido.");
        return [`'${c.sheet}'!${columnName(c.column)}${c.row + 1}:${columnName(c.column + Math.max(...c.values.map(r => r.length)) - 1)}${c.row + c.values.length}`];
      });
      if (!ranges.length) return;
      // getByDataFilter requires broader OAuth scopes even though it reads data. GET supports readonly.
      const result = await api.spreadsheets.get({ spreadsheetId, ranges, includeGridData: true, fields: "spreadsheetId,sheets.data.rowData.values.userEnteredValue.formulaValue" }, options());
      if (result.data.spreadsheetId !== spreadsheetId || result.data.sheets?.some(s => s.data?.some(d => d.rowData?.some(r => r.values?.some(v => v.userEnteredValue?.formulaValue))))) throw new PersistenceError("UPDATE_CONFLICT", "Una cella da aggiornare contiene una formula o il foglio non corrisponde. Eliminazione bloccata per conservarla.");
    },
    async read() {
      const api = makeApi(createGoogleSheetsAuth(env));
      const metadata = await api.spreadsheets.get({ spreadsheetId, includeGridData: false, fields: "spreadsheetId,sheets.properties(sheetId,title,gridProperties(columnCount,rowCount))" }, options());
      if (metadata.data.spreadsheetId !== spreadsheetId) throw new PersistenceError("SCHEMA", "Spreadsheet diverso dalla configurazione: nessuna operazione consentita.");
      const names = Object.keys(TABLE_HEADERS) as TableName[];
      const values = await api.spreadsheets.values.batchGet({ spreadsheetId, ranges: names.map(n => `'${n}'`), valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" }, options());
      const snapshot = {} as SheetSnapshot;
      names.forEach((name, index) => {
        const props = metadata.data.sheets?.find(s => s.properties?.title === name)?.properties;
        if (props?.sheetId == null) throw new PersistenceError("SCHEMA", `Scheda ${name} mancante.`);
        snapshot[name] = { id: props.sheetId, columns: props.gridProperties?.columnCount ?? 26, rowCapacity: props.gridProperties?.rowCount ?? 1000, rows: values.data.valueRanges?.[index].values ?? [] };
      });
      return snapshot;
    },
    async write(changes, snapshot) {
      // Questo controllo è ripetuto nel trasporto: anche un chiamante interno non può eluderlo.
      const api = makeApi(createGoogleSheetsAuth(env, true));
      const requests: sheets_v4.Schema$Request[] = [];
      const widths = new Map<TableName, number>();
      const heights = new Map<TableName, number>();
      for (const change of changes) if ("sheet" in change) heights.set(change.sheet, Math.max(heights.get(change.sheet) ?? 0, change.row + change.values.length));
      for (const [name, height] of heights) if (height > (snapshot[name].rowCapacity ?? 1000)) requests.push({ appendDimension: { sheetId: snapshot[name].id, dimension: "ROWS", length: height - (snapshot[name].rowCapacity ?? 1000) } });
      for (const change of changes) if ("sheet" in change) widths.set(change.sheet, Math.max(widths.get(change.sheet) ?? 0, change.column + Math.max(...change.values.map(r => r.length))));
      for (const [name, width] of widths) if (width > snapshot[name].columns) requests.push({ appendDimension: { sheetId: snapshot[name].id, dimension: "COLUMNS", length: width - snapshot[name].columns } });
      for (const change of changes) {
        if ("insertCategoryRow" in change) requests.push({ insertDimension: { range: { sheetId: snapshot.Categorie.id, dimension: "ROWS", startIndex: change.insertCategoryRow, endIndex: change.insertCategoryRow + 1 }, inheritFromBefore: true } });
        else requests.push({ updateCells: {
          start: { sheetId: snapshot[change.sheet].id, rowIndex: change.row, columnIndex: change.column },
          rows: change.values.map(row => ({ values: row.map(value => ({ userEnteredValue: typeof value === "number" ? { numberValue: value } : typeof value === "boolean" ? { boolValue: value } : { stringValue: value } })) })),
          fields: "userEnteredValue",
        } });
      }
      if (requests.length) await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }, options());
    },
  };
}

export function setupPlan(snapshot: SheetSnapshot): Plan {
  checkSchema(snapshot);
  const changes: Change[] = [];
  for (const name of ["Movimenti", "Prodotti", "Documenti"] as const) {
    const size = TABLE_HEADERS[name].length;
    const extra = snapshot[name].rows[0].slice(size);
    if (extra.length && extra.some((h, i) => h !== extraHeaders(Math.max(1, extra.length - 2))[i])) throw new PersistenceError("SCHEMA", `Colonne aggiuntive ${name} non riconosciute: nessuna sovrascrittura.`);
    if (!extra.length) changes.push({ sheet: name, row: 0, column: size, values: [extraHeaders(1)] });
  }
  const rows = structuredClone(snapshot.Categorie.rows);
  const official = categoryDefinitions.filter(c => !c.id.startsWith("custom-"));
  const subscriptions = official.find(c => c.id === "digital-subscriptions")!;
  if (rows[subscriptions.order]?.[0] !== subscriptions.name && currentCategoryName(String(rows[subscriptions.order]?.[0])) === subscriptions.name) {
    rows[subscriptions.order][0] = subscriptions.name;
    changes.push({ sheet: "Categorie", row: subscriptions.order, column: 0, values: [[subscriptions.name]] });
  }
  for (const id of ["pets", "maintenance-renovations"]) {
    const category = official.find(c => c.id === id)!;
    if (rows.some(r => r[0] === category.name)) continue;
    const position = category.order;
    if (official.slice(0, position - 1).some((c, i) => rows[i + 1]?.[0] !== c.name)
      || ![official[position]?.name, "Da classificare"].includes(String(rows[position]?.[0]))) throw new PersistenceError("SCHEMA", "Ordine Categorie inatteso: occorre una proposta manuale.");
    changes.push({ insertCategoryRow: position });
    rows.splice(position, 0, [category.name, "Spese", "Sì", category.description]);
    changes.push({ sheet: "Categorie", row: position, column: 0, values: [rows[position]] });
  }
  for (const category of categoryDefinitions.filter(c => !c.id.startsWith("custom-"))) {
    const indexes = rows.flatMap((r, i) => r[0] === category.name ? [i] : []);
    if (indexes.length !== 1) throw new PersistenceError("SCHEMA", "Categoria ufficiale mancante o duplicata.");
    const i = indexes[0];
    if (i !== category.order) throw new PersistenceError("SCHEMA", "Categorie ufficiali fuori ordine: nessuna modifica automatica.");
    if (rows[i][2] !== "Sì") changes.push({ sheet: "Categorie", row: i, column: 2, values: [["Sì"]] });
    if (rows[i][3] !== category.description) changes.push({ sheet: "Categorie", row: i, column: 3, values: [[category.description]] });
  }
  rows.forEach((row, i) => {
    if (["Stipendio", "Altre entrate"].includes(String(row[0])) && row[2] !== "No") changes.push({ sheet: "Categorie", row: i, column: 2, values: [["No"]] });
  });
  return { changes, fingerprint: hash({ snapshot, changes }) };
}

// Serializza il singolo processo Node. Non promette esclusione distribuita: Vercel è bloccato.
const state = globalThis as typeof globalThis & { spesesmartSheetsQueue?: Promise<unknown>; spesesmartSheetsUncertain?: boolean };
async function serial<T>(work: () => Promise<T>) {
  const previous = state.spesesmartSheetsQueue ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  state.spesesmartSheetsQueue = next.catch(() => {});
  return next;
}
export function createSheetsRepository(user: FinancialUser, transport: SheetsTransport, writable = false, updateStore?: UpdateStore) {
  const userId = requireFinancialUser(user);
  const coordinated = <T>(work: () => Promise<T>) => updateStore ? serial(() => updateStore.lock(work)) : serial(work);
  return {
    async load() {
      const snapshot = await transport.read(); const loaded = readSnapshot(snapshot, userId);
      return { ...loaded, editablePurchases: editablePurchases(snapshot, userId, loaded), pendingEdits: updateStore ? await pendingPurchaseEdits(updateStore, userId) : [], pendingDeletions: updateStore ? await pendingPurchaseDeletions(updateStore, userId) : [] };
    },
    async previewSetup() { return setupPlan(await transport.read()); },
    async applySetup(fingerprint: string) {
      if (!writable) throw new PersistenceError("WRITES_DISABLED", "Prima scrittura non autorizzata.");
      return coordinated(async () => {
        const snapshot = await transport.read(); const plan = setupPlan(snapshot);
        if (updateStore) await assertNoPendingUpdates(updateStore, snapshot);
        if (plan.fingerprint !== fingerprint) throw new PersistenceError("STALE_PLAN", "Il foglio è cambiato: prepara e approva una nuova anteprima.");
        await transport.write(plan.changes, snapshot);
        return { applied: plan.changes.length };
      });
    },
    async save(input: unknown) {
      rejectClientOwner(input);
      const operation = prepareOperation(input);
      // Compatibility for older clients: derive a fingerprint before discarding bytes.
      if (operation.kind === "receipt") {
        const legacy = (input as { receipt: typeof operation.archive.receipts[number] }).receipt.Documenti[0];
        const document = operation.archive.receipts[0].Documenti[0];
        if (legacy.image) document.imageHash = hash(legacy.image);
      }
      if (!writable) throw new PersistenceError("WRITES_DISABLED", "Salvataggio remoto disabilitato fino all’approvazione della prima scrittura. La revisione è conservata.");
      return coordinated(async () => {
        const snapshot = await transport.read();
        if (updateStore) await assertNoPendingUpdates(updateStore, snapshot);
        if (setupPlan(snapshot).changes.length) throw new PersistenceError("SETUP_REQUIRED", "Approva prima l’allineamento di categorie e colonne tecniche.");
        snapshotForUser(snapshot, userId);
        const fingerprint = hash({ operation, userId });
        assertOperationOwner(snapshot, operation.operationId, userId, true);
        if (updateStore && (await updateStore.list()).some(j => j.operationId === operation.operationId)) throw unavailablePurchase();
        if (operation.kind === "receipt") {
          const deletedIds = new Set(readSnapshot(snapshot, userId).deletedDocumentIds);
          const incoming = operation.archive.receipts[0].Documenti[0];
          if (incoming.imageHash) for (const row of snapshot.Documenti.rows.slice(1).filter(r => rowOwner("Documenti", r) === userId)) {
            if (deletedIds.has(String(row[0]))) continue;
            const json = row.slice(TABLE_HEADERS.Documenti.length + 2).join("");
            if (!json) continue;
            let stored: { archive?: { receipts?: typeof operation.archive.receipts } };
            try { stored = JSON.parse(json); } catch { throw new PersistenceError("CORRUPT", "Documento remoto incompleto."); }
            const original = stored.archive?.receipts?.[0]?.Documenti[0];
            const originalHash = original?.imageHash || (original?.image ? hash(original.image) : undefined);
            if (original && original.id !== incoming.id && original.date === incoming.date && original.merchant === incoming.merchant && original.totalCents === incoming.totalCents && originalHash === incoming.imageHash) throw new PersistenceError("DUPLICATE_DOCUMENT", "La stessa immagine risulta già salvata per data, esercente e totale. Nessun duplicato aggiunto.");
          }
        }
        const desired = operationRows(operation, fingerprint, undefined, userId);
        const changes: Change[] = [];
        for (const name of ["Documenti", "Prodotti", "Movimenti"] as const) {
          const size = TABLE_HEADERS[name].length;
          const rows = snapshot[name].rows;
          const needed = desired[name];
          const maxWidth = Math.max(rows[0].length, ...needed.map(r => r.length));
          if (maxWidth > rows[0].length) changes.push({ sheet: name, row: 0, column: size, values: [extraHeaders(maxWidth - size - 2)] });
          let nextRow = rows.length;
          for (const row of needed) {
            const existing = rows.slice(1).filter(r => r[0] === row[0]);
            if (existing.some(r => rowOwner(name, r) !== userId)) throw unavailablePurchase();
            if (existing.length > 1 || (existing.length === 1 && rowCanonical(existing[0]) !== rowCanonical(row))) throw new PersistenceError("CONFLICT", "Un ID esiste con dati diversi: nessuna sovrascrittura.");
            if (!existing.length) changes.push({ sheet: name, row: nextRow++, column: 0, values: [row] });
          }
        }
        if (!changes.some(c => "sheet" in c && c.row > 0)) return { saved: true, duplicate: true, operationId: operation.operationId, archive: operation.archive };
        if (state.spesesmartSheetsUncertain) throw new PersistenceError("UNCERTAIN", "Un precedente invio ha esito incerto. Verifica il foglio prima di riattivare il writer: nessun retry automatico.");
        try { await transport.write(changes, snapshot); }
        catch {
          // Esito incerto: leggere nuovamente per riconoscere un commit con risposta persa.
          const after = await transport.read().catch(() => null);
          const complete = after && (["Documenti", "Prodotti", "Movimenti"] as const).every(name => desired[name].every(row => after[name].rows.slice(1).some(r => rowCanonical(r) === rowCanonical(row))));
          if (!complete) { state.spesesmartSheetsUncertain = true; throw new PersistenceError("UNCERTAIN", "Esito del salvataggio incerto. Dati di revisione conservati: nessun nuovo invio automatico."); }
        }
        return { saved: true, duplicate: false, operationId: operation.operationId, archive: operation.archive };
      });
    },
    async update(input: unknown) {
      rejectClientOwner(input);
      if (!writable) throw new PersistenceError("WRITES_DISABLED", "Modifiche disponibili soltanto nello sviluppo locale autorizzato.");
      if (state.spesesmartSheetsUncertain) throw new PersistenceError("UNCERTAIN", "Un inserimento precedente ha esito incerto. Verifica il foglio prima di nuove modifiche.");
      if (!updateStore) throw new PersistenceError("UPDATE_STORAGE", "Registro durabile aggiornamenti non configurato: modifica bloccata.");
      return coordinated(async () => {
        const snapshot = await transport.read();
        if (setupPlan(snapshot).changes.length) throw new PersistenceError("SETUP_REQUIRED", "Allineamento strutturale necessario: nessuna modifica.");
        return performUpdate(transport, updateStore, input, userId);
      });
    },
    async delete(input: unknown) {
      rejectClientOwner(input);
      if (!writable) throw new PersistenceError("WRITES_DISABLED", "Eliminazioni disponibili soltanto nello sviluppo locale autorizzato.");
      if (state.spesesmartSheetsUncertain) throw new PersistenceError("UNCERTAIN", "Un inserimento ha esito incerto: verifica prima il foglio.");
      if (!updateStore) throw new PersistenceError("UPDATE_STORAGE", "Backup e registro durabile non disponibili: eliminazione bloccata.");
      return coordinated(async () => {
        if (setupPlan(await transport.read()).changes.length) throw new PersistenceError("SETUP_REQUIRED", "Allineamento necessario: nessuna eliminazione.");
        return performDeletion(transport, updateStore, input, userId);
      });
    },
  };
}
export function googleSheetsRepository(user: FinancialUser) {
  requireFinancialUser(user);
  const writable = googleSheetsWritesEnabled();
  return createSheetsRepository(user, createSheetsTransport(), writable, writable ? createUpdateStore() : undefined);
}
