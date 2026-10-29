import './helpers/isolated-host-policy.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createGoogleSheetsAuth, createGoogleSheetsClient, safeGoogleSheetsError,
  REQUIRED_SHEETS, SHEETS_READONLY_SCOPE, METADATA_FIELDS,
  googleSheetsWritesEnabled,
} from "../src/lib/google-sheets.ts";

const env = { GOOGLE_SHEETS_SPREADSHEET_ID: "fixture-spreadsheet" };
const metadata = (titles = REQUIRED_SHEETS) => ({
  spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
  sheets: titles.map((title, index) => ({ properties: { sheetId: index, title, index } })),
});

test("Sheets: scritture solo development autorizzato; produzione, test e Vercel bloccati anche con flag true", () => {
  const enabled = { NODE_ENV: "development", SPESESMART_SHEETS_WRITES_ENABLED: "true" };
  assert.equal(googleSheetsWritesEnabled(enabled), true);
  assert.deepEqual(createGoogleSheetsAuth(enabled, true).scopes, ["https://www.googleapis.com/auth/spreadsheets"]);
  assert.deepEqual(createGoogleSheetsAuth(enabled).scopes, [SHEETS_READONLY_SCOPE]);
  for (const blocked of [{}, { ...enabled, NODE_ENV: "production" }, { ...enabled, NODE_ENV: "test" }, { ...enabled, NODE_ENV: undefined }, { ...enabled, VERCEL: "1" }, { ...enabled, SPESESMART_SHEETS_WRITES_ENABLED: "false" }]) {
    assert.equal(googleSheetsWritesEnabled(blocked), false);
    assert.throws(() => createGoogleSheetsAuth(blocked, true), { code: "WRITES_DISABLED" });
  }
});

test("Sheets: solo spreadsheets.get con maschera metadati, timeout e nessuna scrittura", async () => {
  const calls = [];
  const client = createGoogleSheetsClient(env, async (...args) => { calls.push(args); return metadata(); });
  const result = await client.verifyConnection();
  assert.deepEqual(Object.keys(client), ["verifyConnection"]);
  assert.deepEqual(result, { connected: true, ready: true, readOnly: true, sheets: [...REQUIRED_SHEETS], missingSheets: [] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], { spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID, includeGridData: false, fields: METADATA_FIELDS });
  assert.equal(calls[0][1].retry, false);
  assert.equal(calls[0][1].timeout, 20000);
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  assert.equal(METADATA_FIELDS.includes("data"), false);
});

test("Sheets: scope ADC esclusivamente readonly, senza percorso o chiave nel codice", () => {
  const auth = createGoogleSheetsAuth({});
  assert.deepEqual(auth.scopes, [SHEETS_READONLY_SCOPE]);
});

test("Sheets: credenziali secret JSON validate, readonly e newline normalizzate", async () => {
  const auth = createGoogleSheetsAuth({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: "service_account", client_email: "fixture@example.iam.gserviceaccount.com", private_key: "fixture\\nkey",
  }) });
  const jwt = await auth.getClient();
  assert.deepEqual(jwt.scopes, [SHEETS_READONLY_SCOPE]);
  assert.equal(jwt.key, "fixture\nkey");
});

test("Sheets: configurazione invalida bloccata prima della lettura", () => {
  for (const bad of [{}, { GOOGLE_SHEETS_SPREADSHEET_ID: "https://invalid.example" }]) {
    assert.throws(() => createGoogleSheetsClient(bad, async () => { assert.fail("non deve leggere"); }), { code: "CONFIGURATION" });
  }
  for (const json of ["not-json", "{}", '{"type":"external_account"}']) {
    assert.throws(() => createGoogleSheetsAuth({ GOOGLE_SERVICE_ACCOUNT_JSON: json }), { code: "CONFIGURATION" });
  }
});

test("Sheets: scheda mancante distinta dalla connessione riuscita; nessuna modifica", async () => {
  const data = metadata(["Movimenti", "Categorie"]);
  const before = structuredClone(data);
  const result = await createGoogleSheetsClient(env, async () => data).verifyConnection();
  assert.equal(result.connected, true);
  assert.equal(result.ready, false);
  assert.deepEqual(result.missingSheets, ["Prodotti", "Documenti", "LEGGIMI"]);
  assert.deepEqual(data, before);
});

test("Sheets: mantiene i nomi rilevati, ordina per indice e ignora dati non richiesti", async () => {
  const data = metadata();
  data.sheets.reverse();
  data.sheets[0].data = [{ secretCell: "not-returned" }];
  const result = await createGoogleSheetsClient(env, async () => data).verifyConnection();
  assert.deepEqual(result.sheets, [...REQUIRED_SHEETS]);
  assert.equal(JSON.stringify(result).includes("secretCell"), false);
});

test("Sheets: risposta malformata o foglio differente non dichiarati riusciti", async () => {
  for (const data of [null, {}, { ...metadata(), spreadsheetId: "another-file" }, metadata(["Movimenti", "Movimenti"])]) {
    await assert.rejects(createGoogleSheetsClient(env, async () => data).verifyConnection(), { code: "INVALID_RESPONSE" });
  }
});

test("Sheets: errori di accesso, rete, timeout e credenziali senza dettagli sensibili", async () => {
  const cases = [
    [{ response: { status: 401 } }, "AUTHORIZATION"],
    [{ response: { status: 403 } }, "AUTHORIZATION"],
    [{ response: { status: 404 } }, "NOT_FOUND"],
    [{ response: { status: 429 } }, "RATE_LIMIT"],
    [{ code: "ENOENT" }, "CONFIGURATION"],
    [{ code: "EACCES" }, "CONFIGURATION"],
    [{ message: "Could not load the default credentials" }, "CONFIGURATION"],
    [{ name: "TimeoutError" }, "TIMEOUT"],
    [{ code: "ETIMEDOUT" }, "TIMEOUT"],
    [{ code: "ENOTFOUND" }, "CONNECTION"],
    [{ response: { status: 500 } }, "CONNECTION"],
  ];
  for (const [details, code] of cases) {
    const raw = { message: "SENSITIVE_VALUE /private/path token-secret", ...details, config: { authorization: "token-secret" } };
    await assert.rejects(createGoogleSheetsClient(env, async () => { throw raw; }).verifyConnection(), error => {
      assert.equal(error.code, code);
      assert.equal(error.cause, undefined);
      assert.equal(/SENSITIVE|private\/path|token-secret/.test(error.stack), false);
      assert.equal(JSON.stringify(error).includes("token-secret"), false);
      return true;
    });
  }
  assert.equal(safeGoogleSheetsError(null).code, "CONNECTION");
});

test("Sheets: importazione Node senza condizione server rifiutata", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./src/lib/google-sheets.ts")'], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be imported from a Client Component module/);
});
