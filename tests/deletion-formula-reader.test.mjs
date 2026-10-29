import test from "node:test";
import assert from "node:assert/strict";
import { createSheetsTransport } from "../src/lib/sheets-repository.ts";
import { SHEETS_READONLY_SCOPE, safeGoogleSheetsError } from "../src/lib/google-sheets.ts";

const env = { GOOGLE_SHEETS_SPREADSHEET_ID: "fixture-spreadsheet" };
const snapshot = { Documenti: { id: 20 }, Movimenti: { id: 30 }, Prodotti: { id: 40 }, Categorie: { id: 50 } };
const changes = [{ sheet: "Documenti", row: 2, column: 8, values: [["Eliminazione in corso"]] }, { sheet: "Movimenti", row: 1, column: 14, values: [["json"]] }, { sheet: "Prodotti", row: 8, column: 26, values: [["a", "b"]] }];

test("controllo formule: GET con scope readonly, intervalli A1 precisi e nessuna richiesta getByDataFilter o writer", async () => {
  const requests = [];
  const transport = createSheetsTransport(env, auth => {
    assert.deepEqual(auth.scopes, [SHEETS_READONLY_SCOPE]);
    return { spreadsheets: {
      async get(params, options) { requests.push(params); assert.equal(options.retry, false); assert.equal(options.timeout, 20000); return { data: { spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID } }; },
      getByDataFilter() { assert.fail("getByDataFilter non accetta lo scope readonly"); },
      batchUpdate() { assert.fail("Non deve scrivere"); },
    } };
  });
  await transport.guardDeletion(changes, snapshot);
  assert.deepEqual(requests, [{ spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID, ranges: ["'Documenti'!I3:I3", "'Movimenti'!O2:O2", "'Prodotti'!AA9:AB9"], includeGridData: true, fields: "spreadsheetId,sheets.data.rowData.values.userEnteredValue.formulaValue" }]);
});

test("controllo formule: formule, foglio differente e intervalli invalidi bloccano senza scrivere", async () => {
  for (const data of [{ spreadsheetId: "other" }, { spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID, sheets: [{ data: [{ rowData: [{ values: [{ userEnteredValue: { formulaValue: '=IF(TRUE,"Confermato","")' } }] }] }] }] }]) {
    const transport = createSheetsTransport(env, () => ({ spreadsheets: { async get() { return { data }; }, batchUpdate() { assert.fail("writer"); } } }));
    await assert.rejects(transport.guardDeletion(changes, snapshot), { code: "UPDATE_CONFLICT" });
  }
  const transport = createSheetsTransport(env, () => ({ spreadsheets: { get() { assert.fail("intervallo invalido non va inviato"); } } }));
  for (const change of [{ ...changes[0], row: 0 }, { ...changes[0], column: -1 }, { ...changes[0], values: [] }, { ...changes[0], sheet: "Categorie" }]) await assert.rejects(transport.guardDeletion([change], snapshot), { code: "UPDATE_CONFLICT" });
});

test("403 scope insufficiente distinto da autorizzazione reale, nessun dettaglio sensibile esposto", () => {
  const raw = { message: "secret-token", response: { status: 403, data: { error: { message: "private-account", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", metadata: { credential: "secret-token" } }] } } } };
  const safe = safeGoogleSheetsError(raw);
  assert.equal(safe.code, "AUTH_SCOPE"); assert.equal(/secret-token|private-account/.test(JSON.stringify(safe)), false);
  assert.equal(safe.cause, undefined);
  assert.equal(safeGoogleSheetsError({ response: { status: 403 } }).code, "AUTHORIZATION");
});
