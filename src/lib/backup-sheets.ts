import "server-only";
import { sheets, type sheets_v4 } from "@googleapis/sheets";
import { createHash } from "node:crypto";
import { createGoogleSheetsAuth } from "./google-sheets";
import { withoutImages } from "./image-free";
import { canonical, checkSchema, readSnapshot, TABLE_HEADERS, rowOwner, requireFinancialUser, chunks, type Cell, type SheetSnapshot, type TableName } from "./sheets-persistence-model";
import { verifyRecoverable, verifyRecoverableRows } from "./sheets-updates";
import { isDeletionJournal, type MutationJournal, type LegacyJournal } from "./sheets-update-store";

export class BackupError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export const backupDigest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const backupReview = () => new BackupError("REVIEW_REQUIRED", "Dati non conformi o ambigui: backup bloccato. Serve una decisione esplicita sui dati storici; nessuna correzione automatica.");

// Strict exclusion, never sanitize recovery journals or creation/version hashes.
export function assertOrdinaryBackupData(value: unknown) {
  const text = JSON.stringify(value);
  if (canonical(withoutImages(value)) !== canonical(value)
    || /data:image\/|(?:\/9j\/|iVBORw0KGgo|R0lGOD)[A-Za-z0-9+/=]{128,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/i.test(text)) throw backupReview();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v && typeof v === "object") for (const [key, item] of Object.entries(v)) {
      if (/^(password|private_key|client_secret|access_token|authorization|apiKey|openai_api_key|google_service_account_json|photoData|photoBytes|photographData|photographBase64)$/i.test(key) && item) throw backupReview();
      visit(item);
    }
  };
  visit(value);
}

export function financialSnapshot(raw: sheets_v4.Schema$Spreadsheet, legacy = false): SheetSnapshot {
  const snapshot = {} as SheetSnapshot;
  const all = raw.sheets;
  if (!all || new Set(all.map(s => s.properties?.sheetId)).size !== all.length
    || new Set(all.map(s => s.properties?.title)).size !== all.length) throw backupReview();
  for (const sheet of all) {
    const rows: Cell[][] = [];
    for (const grid of sheet.data ?? []) for (const [offset, source] of (grid.rowData ?? []).entries()) {
      const index = (grid.startRow ?? 0) + offset; rows[index] ??= [];
      for (const [column, cell] of (source.values ?? []).entries()) {
        const value = cell.effectiveValue ?? cell.userEnteredValue;
        rows[index][(grid.startColumn ?? 0) + column] = value?.stringValue ?? value?.numberValue ?? value?.boolValue ?? "";
        if (/\bIMAGE\s*\(/i.test(cell.userEnteredValue?.formulaValue ?? "")) throw backupReview();
      }
    }
    for (let i = 0; i < rows.length; i++) { rows[i] ??= []; for (let j = 0; j < rows[i].length; j++) rows[i][j] ??= ""; }
    // Check every sheet, including unknown future tabs and split technical JSON.
    assertOrdinaryBackupData({ rows });
    for (const [column, header] of (rows[0] ?? []).entries()) {
      if (/immagine|fotografia|base64|^(image|photo)(url|data|bytes)?$/i.test(String(header)) && !/hash/i.test(String(header))
        && rows.slice(1).some(row => row[column] !== undefined && row[column] !== "")) throw backupReview();
    }
    const name = sheet.properties?.title;
    if (name && Object.hasOwn(TABLE_HEADERS, name)) {
      if (!Number.isInteger(sheet.properties?.sheetId)) throw backupReview();
      snapshot[name as TableName] = { id: sheet.properties!.sheetId!, columns: sheet.properties?.gridProperties?.columnCount ?? 26,
        rowCapacity: sheet.properties?.gridProperties?.rowCount ?? 1000, rows };
    }
  }
  if (!all.some(s => s.properties?.title === "LEGGIMI")) throw backupReview();
  try {
    if (legacy) {
      for (const name of ['Movimenti', 'Prodotti', 'Documenti'] as const) {
        const expected = TABLE_HEADERS[name].slice(0, -1);
        if (expected.some((value, i) => snapshot[name].rows[0]?.[i] !== value)
          || snapshot[name].rows[0]?.includes('UtenteID')) throw backupReview();
      }
      if (TABLE_HEADERS.Categorie.some((value, i) => snapshot.Categorie.rows[0]?.[i] !== value)) throw backupReview();
    } else checkSchema(snapshot);
  } catch { throw backupReview(); }
  return snapshot;
}

// Ephemeral validation identity, never persisted or used by a repository/API.
const LEGACY_AUDIT_OWNER = '00000000-0000-4000-8000-000000000001';
function legacyRow(name: 'Movimenti' | 'Prodotti' | 'Documenti', row: Cell[], header = false): Cell[] {
  if (!row.some(value => value !== '')) return [];
  const size = TABLE_HEADERS[name].length - 1;
  if (header) return [...row.slice(0, size), 'UtenteID', ...row.slice(size)];
  const result = [...row.slice(0, size), LEGACY_AUDIT_OWNER, ...row.slice(size, size + 2)];
  if (row[size + 2]) result.push(...chunks({ ...JSON.parse(row.slice(size + 2).join('')), userId: LEGACY_AUDIT_OWNER }));
  return result;
}
export function validateFinancialBackup(raw: sheets_v4.Schema$Spreadsheet, scope: string, journals: (MutationJournal | LegacyJournal)[] = [], legacy = false) {
  if (!raw.spreadsheetId || backupDigest(raw.spreadsheetId) !== scope) throw backupReview();
  assertOrdinaryBackupData(raw);
  const snapshot = financialSnapshot(raw, legacy);
  const projected = structuredClone(snapshot);
  if (journals.some(j => (j.version === 1) !== legacy)) throw backupReview();
  const pending = journals.filter(j => j.state === "pending");
  try {
    for (const journal of pending) {
      const deletion = 'kind' in journal && journal.kind === 'delete';
      if (journal.version === 1) verifyRecoverableRows(snapshot, journal, deletion);
      else verifyRecoverable(snapshot, journal, isDeletionJournal(journal));
      // Validate recoverability on a copy only; export the untouched partial rows.
      for (const patch of [...journal.patches, journal.commit]) projected[patch.sheet].rows[patch.row] = [...patch.after];
    }
    if (legacy) for (const name of ['Movimenti', 'Prodotti', 'Documenti'] as const) projected[name].rows = projected[name].rows.map((row, i) => legacyRow(name, row, i === 0));
    const owners = new Set<string>();
    for (const name of ["Movimenti", "Prodotti", "Documenti"] as const) for (const row of projected[name].rows.slice(1).filter(r => r[0])) {
      const owner = String(rowOwner(name, row) ?? ""); requireFinancialUser({ id: owner }); owners.add(owner);
    }
    let deletedDocuments = 0;
    for (const owner of owners) {
      const loaded = readSnapshot(projected, owner);
      if (loaded.warnings.length) throw backupReview();
      deletedDocuments += loaded.deletedDocumentIds.length;
    }
    return { sheetCount: raw.sheets!.length, pending: pending.length, deletedDocuments };
  } catch { throw backupReview(); }
}

export function createFinancialBackupReader(env: NodeJS.ProcessEnv = process.env,
  makeApi = (auth: ReturnType<typeof createGoogleSheetsAuth>) => sheets({ version: "v4", auth })) {
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  if (!spreadsheetId || !/^[\w-]+$/.test(spreadsheetId)) throw new BackupError("CONFIGURATION", "Configurazione Sheets mancante.");
  return async () => {
    // Dedicated readonly client: no writer/append/batchUpdate surface is exposed.
    const api = makeApi(createGoogleSheetsAuth(env, false));
    const response = await api.spreadsheets.get({ spreadsheetId, includeGridData: true },
      { timeout: 30000, retry: false, signal: AbortSignal.timeout(30000) });
    if (response.data.spreadsheetId !== spreadsheetId) throw backupReview();
    return response.data;
  };
}
