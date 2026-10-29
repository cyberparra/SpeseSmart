import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, stat, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSheetsRepository } from "../src/lib/sheets-repository.ts";
import { createUpdateStore } from "../src/lib/sheets-update-store.ts";
import { editablePurchases } from "../src/lib/sheets-updates.ts";
import { TABLE_HEADERS, extraHeaders, canonical } from "../src/lib/sheets-persistence-model.ts";
import { categoryDefinitions } from "../src/lib/categories.ts";
import { createDraft, prepareConfirmation } from "../src/lib/receipts/model.ts";
import { demoReceipt } from "../src/lib/receipts/demo.ts";
import { spendingSummary } from "../src/lib/spending.ts";
import { buildPurchases } from "../src/lib/purchases.ts";
import { PATCH } from "../src/app/api/archive/route.ts";
import { spawn } from "node:child_process";

function fake() {
  const data = Object.fromEntries(Object.entries(TABLE_HEADERS).map(([name, headers], id) => [name, { id, columns: 50, rows: [[...headers, ...(name === "Categorie" ? [] : extraHeaders(1))]] }]));
  data.Categorie.rows.push(...categoryDefinitions.map(c => [c.name, "Spese", "Sì", c.description]));
  const transport = { data, writes: [],
    async read() { return structuredClone(data); },
    async write(changes) {
      this.writes.push(structuredClone(changes));
      for (const c of changes) {
        assert.ok("sheet" in c); assert.notEqual(c.sheet, "Categorie");
        for (let n = 0; n < c.values.length; n++) {
          data[c.sheet].rows[c.row + n] ??= [];
          c.values[n].forEach((v, i) => { data[c.sheet].rows[c.row + n][c.column + i] = v; });
          while (data[c.sheet].rows[c.row + n].at(-1) === "") data[c.sheet].rows[c.row + n].pop(); // Google truncates trailing blanks
        }
      }
    },
  };
  return transport;
}
const manual = () => ({ kind: "manual", operationId: randomUUID(), draft: { description: "Ferramenta", date: "2026-10-12", notes: "Originale", items: [{ amount: "10.10", category: "Casa e Pulizia" }, { amount: "2.20", category: "Trasporti" }] } });
function receipt() {
  let n = 0; const analysis = structuredClone(demoReceipt);
  return prepareConfirmation(createDraft(analysis, () => `product-${++n}`), analysis, "", false, () => `receipt-${++n}`, "a".repeat(64));
}
async function fixture(work, kind = "manual") {
  const directory = await mkdtemp(join(tmpdir(), "spesesmart-updates-test-")); await chmod(directory, 0o700);
  const env = { NODE_ENV: "test", SPESESMART_SHEETS_UPDATE_DIR: directory, GOOGLE_SHEETS_SPREADSHEET_ID: "fixture-spreadsheet" };
  const store = createUpdateStore(env); const transport = fake(); const repo = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, store);
  let documentId;
  if (kind === "manual") { const input = manual(); await repo.save(input); documentId = `manual-${input.operationId}`; }
  else { const value = receipt(); await repo.save({ kind: "receipt", operationId: value.Documenti[0].id, receipt: value }); documentId = value.Documenti[0].id; }
  const editable = (await repo.load()).editablePurchases[documentId];
  const request = { documentId, operationId: randomUUID(), expectedVersion: editable.version, draft: structuredClone(editable.draft) };
  try { await work({ env, store, transport, repo, directory, documentId, editable, request }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("modifica manuale: campi, centesimi, segni remoti, ID e categoria coerenti in tutte le schede", async () => fixture(async ({ repo, transport, request, documentId }) => {
  const originalIds = transport.data.Movimenti.rows.slice(1).map(r => r[0]); const categories = structuredClone(transport.data.Categorie);
  request.draft.merchant = "Ferramenta corretta"; request.draft.date = "2026-09-20"; request.draft.notes = "Note corrette";
  request.draft.items[0] = { ...request.draft.items[0], amount: "15,35", category: "Animali", description: "Accessori" };
  const result = await repo.update(request);
  assert.equal(result.updated, true); assert.equal(result.duplicate, false);
  assert.deepEqual(transport.data.Movimenti.rows.slice(1).map(r => r[0]), originalIds);
  assert.equal(transport.data.Movimenti.rows[1][4], "Accessori"); assert.equal(transport.data.Movimenti.rows[1][7], -15.35);
  assert.equal(transport.data.Documenti.rows[1][4], 17.55); assert.equal(transport.data.Prodotti.rows.length, 1);
  const purchase = buildPurchases(result.archive)[0]; assert.equal(purchase.totalCents, 1755); assert.equal(purchase.date, "2026-09-20");
  assert.deepEqual(purchase.notes, ["Note corrette"]); assert.ok(purchase.subtotals.some(s => s.category === "Animali"));
  assert.deepEqual(transport.data.Categorie, categories); assert.ok(result.editablePurchases[documentId].version !== request.expectedVersion);
  assert.equal(spendingSummary(result.archive.expenses, "2026-09", 200000).remainingCents, 198245);
}));

test("modifica scontrino: prodotti, quantità, prezzi motivati, subtotali, negozio, note e analisi originale", async () => fixture(async ({ repo, transport, request }) => {
  const original = (await repo.load()).archive.receipts[0]; const productIds = original.Prodotti.map(p => p.id);
  request.draft.merchant = "Negozio corretto"; request.draft.date = "2026-09-15"; request.draft.notes = "Nota del documento";
  request.draft.items[0] = { ...request.draft.items[0], description: "Prodotto corretto", quantity: 3, amount: "4.55", reason: "Prezzo corretto dal documento", category: "Animali" };
  const result = await repo.update(request); const saved = result.archive.receipts[0];
  assert.deepEqual(saved.Prodotti.map(p => p.id), productIds); assert.deepEqual(saved.Documenti[0].originalAnalysis, original.Documenti[0].originalAnalysis);
  assert.equal(saved.Documenti[0].totalCents, original.Documenti[0].totalCents + 155); assert.equal(saved.Documenti[0].image, "");
  assert.equal(saved.Prodotti[0].quantity, 3); assert.equal(saved.Prodotti[0].amountCents, 455); assert.equal(saved.Prodotti[0].category, "Animali");
  assert.ok(saved.Movimenti.some(m => m.category === "Animali" && m.amountCents === 455));
  assert.equal(saved.Movimenti.reduce((s, m) => s + m.amountCents, 0), saved.Documenti[0].totalCents);
  assert.equal(buildPurchases(result.archive).length, 1); assert.deepEqual(buildPurchases(result.archive)[0].notes, ["Nota del documento"]);
  assert.equal(JSON.stringify(transport.data).includes("data:image"), false);
}, "receipt"));

test("modifica: categoria rimossa e ripristinata riusa l’ID originario, nessun acquisto o prodotto eliminato", async () => fixture(async ({ repo, transport, request, documentId }) => {
  const initial = (await repo.load()).archive.receipts[0]; const category = initial.Prodotti[0].category; const oldId = initial.Movimenti.find(m => m.category === category).id;
  request.draft.items[0].category = "Animali"; await repo.update(request);
  let current = (await repo.load()).editablePurchases[documentId];
  const next = { documentId, operationId: randomUUID(), expectedVersion: current.version, draft: structuredClone(current.draft) };
  next.draft.items[0].category = category; const result = await repo.update(next);
  assert.equal(result.archive.receipts[0].Movimenti.find(m => m.category === category).id, oldId);
  assert.equal(transport.data.Documenti.rows.filter(r => r[0] === documentId).length, 1);
  assert.equal(result.archive.receipts[0].Prodotti.length, initial.Prodotti.length);
  const nonempty = transport.data.Movimenti.rows.slice(1).filter(r => r[0]); assert.equal(new Set(nonempty.map(r => r[0])).size, nonempty.length);
}, "receipt"));

test("modifica: invii simultanei identici e retry non riscrivono o duplicano righe", async () => fixture(async ({ repo, transport, request }) => {
  request.draft.notes = "Modifica unica";
  const results = await Promise.all([repo.update(request), repo.update(request)]);
  assert.equal(results[0].duplicate, false); assert.equal(results[1].duplicate, true);
  const calls = transport.writes.length; assert.equal((await repo.update(request)).duplicate, true); assert.equal(transport.writes.length, calls);
  const different = structuredClone(request); different.draft.notes = "Diversa";
  await assert.rejects(repo.update(different), { code: "EDIT_CONFLICT" }); assert.equal(transport.writes.length, calls);
}));

test("modifica: versione obsoleta e due modifiche concorrenti diverse, nessuna sovrascrittura", async () => fixture(async ({ repo, transport, request }) => {
  const second = structuredClone(request); second.operationId = randomUUID(); second.draft.notes = "Secondo editor";
  request.draft.notes = "Primo editor"; const results = await Promise.allSettled([repo.update(request), repo.update(second)]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].reason.code, "EDIT_CONFLICT");
  const before = canonical(transport.data); await assert.rejects(repo.update(second), { code: "EDIT_CONFLICT" }); assert.equal(canonical(transport.data), before);
}));

test("modifica: aggiornamento parziale, nuove scritture bloccate, recupero dal registro dopo riavvio", async () => fixture(async ({ repo, store, env, transport, request, documentId }) => {
  request.draft.notes = "Da recuperare"; request.draft.items[0].amount = "20.00";
  const write = transport.write.bind(transport); let phase = 0;
  transport.write = async changes => { if (++phase === 2) { await write(changes.slice(0, 1)); throw Error("timeout dopo una riga"); } await write(changes); };
  await assert.rejects(repo.update(request), { code: "UPDATE_PENDING" });
  const loaded = await repo.load(); assert.equal(loaded.archive.expenses.length, 0); assert.equal(loaded.pendingEdits.length, 1);
  assert.deepEqual(loaded.pendingEdits[0].request, request); assert.equal(transport.data.Documenti.rows[1][8], "Aggiornamento in corso");
  await assert.rejects(repo.save(manual()), { code: "UPDATE_PENDING" });
  const other = structuredClone(request); other.operationId = randomUUID(); await assert.rejects(repo.update(other), { code: "UPDATE_PENDING" });
  transport.write = write;
  const restarted = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, createUpdateStore(env)); const recovered = await restarted.update(loaded.pendingEdits[0].request);
  assert.equal(recovered.updated, true); assert.equal(recovered.archive.expenses.length, 2); assert.equal(transport.data.Documenti.rows[1][8], "Confermato");
  assert.equal((await store.list())[0].state, "complete"); assert.equal((await restarted.load()).pendingEdits.length, 0);
  assert.ok(editablePurchases(transport.data, "11111111-1111-4111-8111-111111111111")[documentId]);
}));

test("modifica: risposte perse dopo ciascuna fase riconosciute mediante rilettura", async () => fixture(async ({ repo, transport, request }) => {
  request.draft.notes = "Risposte perse"; const write = transport.write.bind(transport);
  transport.write = async changes => { await write(changes); throw Error("risposta persa"); };
  const result = await repo.update(request); assert.equal(result.updated, true); assert.equal(result.archive.expenses[0].notes, "Risposte perse");
}));

test("modifica: righe estranee durante recupero non vengono sovrascritte", async () => fixture(async ({ repo, transport, request }) => {
  request.draft.notes = "Nuova nota"; const write = transport.write.bind(transport); let phase = 0;
  transport.write = async changes => { if (++phase === 2) throw Error("interruzione"); await write(changes); };
  await assert.rejects(repo.update(request), { code: "UPDATE_PENDING" });
  transport.data.Movimenti.rows[1][4] = "Modifica esterna"; const before = canonical(transport.data); transport.write = write;
  await assert.rejects(repo.update(request), { code: "UPDATE_CONFLICT" }); assert.equal(canonical(transport.data), before);
}));

test("modifica: validazioni impediscono prezzi non motivati, ID alterati, entrate, immagini e importi invalidi", async () => fixture(async ({ repo, transport, request }) => {
  const mutations = [r => { r.draft.items[0].amount = "7.001"; }, r => { r.draft.items[0].category = "Stipendio"; }, r => { r.draft.date = "2026-02-30"; }, r => { r.draft.items.pop(); }, r => { r.draft.items[0].quantity = 0; }, r => { r.draft.items[0].amount = "9.99"; }, r => { r.draft.notes = "data:image/png;base64,dGVzdA=="; }];
  const before = canonical(transport.data);
  for (const mutate of mutations) { const bad = structuredClone(request); bad.operationId = randomUUID(); mutate(bad); await assert.rejects(repo.update(bad)); assert.equal(canonical(transport.data), before); }
}, "receipt"));

test("modifica: permessi privati e checksum del registro, corruzione blocca prima del writer", async () => fixture(async ({ repo, store, directory, transport, request }) => {
  request.draft.notes = "Completata"; await repo.update(request);
  const scoped = join(directory, store.scope); assert.equal((await stat(scoped)).mode & 0o777, 0o700);
  const files = (await readdir(scoped)).filter(n => n.endsWith(".json")); const path = join(scoped, files[0]);
  assert.equal((await stat(path)).mode & 0o777, 0o600); const text = await readFile(path, "utf8");
  assert.equal(text.includes("data:image"), false); assert.equal(text.includes("OPENAI_API_KEY"), false);
  const changed = JSON.parse(text); changed.journal.request.draft.notes = "Alterata"; await writeFile(path, JSON.stringify(changed));
  const before = canonical(transport.data); await assert.rejects(repo.update(request), { code: "UPDATE_STORAGE" }); assert.equal(canonical(transport.data), before);
}));

test("modifica: scritture disabilitate e registro assente bloccano prima di mutare dati", async () => fixture(async ({ transport, request }) => {
  const before = canonical(transport.data);
  await assert.rejects(createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport).update(request), { code: "WRITES_DISABLED" });
  await assert.rejects(createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true).update(request), { code: "UPDATE_STORAGE" });
  assert.equal(canonical(transport.data), before);
}));

test("modifica: journal non scrivibile blocca prima del marker remoto", async () => fixture(async ({ repo, store, transport, request }) => {
  const put = store.put; store.put = async () => { throw Object.assign(Error("Registro non scrivibile"), { code: "UPDATE_STORAGE" }); };
  const before = canonical(transport.data); await assert.rejects(repo.update(request), { code: "UPDATE_STORAGE" });
  assert.equal(canonical(transport.data), before); store.put = put;
}));

test("modifica: crash prima di completare il journal dopo commit, retry senza riscrivere Google", async () => fixture(async ({ repo, store, env, transport, request }) => {
  request.draft.notes = "Commit avvenuto"; const put = store.put.bind(store);
  store.put = async journal => { if (journal.state === "complete") throw Object.assign(Error("Crash prima conferma durabile"), { code: "UPDATE_STORAGE" }); await put(journal); };
  await assert.rejects(repo.update(request), { code: "UPDATE_STORAGE" });
  assert.equal(transport.data.Documenti.rows[1][8], "Confermato"); const writes = transport.writes.length;
  const restarted = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true, createUpdateStore(env));
  const recovered = await restarted.update(request); assert.equal(recovered.updated, true); assert.equal(transport.writes.length, writes);
  assert.equal((await restarted.load()).pendingEdits.length, 0);
}));

test("modifica: retry di una modifica precedente restituisce lo stato corrente e non ripristina dati vecchi", async () => fixture(async ({ repo, request, documentId, transport }) => {
  request.draft.notes = "Prima"; await repo.update(request);
  const editable = (await repo.load()).editablePurchases[documentId];
  const next = { documentId, operationId: randomUUID(), expectedVersion: editable.version, draft: structuredClone(editable.draft) }; next.draft.notes = "Seconda";
  await repo.update(next); const writes = transport.writes.length;
  const repeated = await repo.update(request); assert.equal(repeated.duplicate, true); assert.equal(repeated.archive.expenses[0].notes, "Seconda"); assert.equal(transport.writes.length, writes);
}));

test("modifica: registro inizializzato scomparso non viene ricreato, permessi pubblici bloccano", async () => fixture(async ({ repo, store, directory, request, transport }) => {
  const scoped = join(directory, store.scope); const before = canonical(transport.data);
  await chmod(scoped, 0o755); await assert.rejects(repo.update(request), { code: "UPDATE_STORAGE" }); assert.equal(canonical(transport.data), before);
  await chmod(scoped, 0o700); await rm(scoped, { recursive: true });
  await assert.rejects(repo.update(request), { code: "UPDATE_STORAGE" }); assert.equal(canonical(transport.data), before);
}));

test("modifica: lock comune serializza processi Node distinti sullo stesso disco", async () => fixture(async ({ directory }) => {
  const moduleUrl = new URL("../src/lib/sheets-update-store.ts", import.meta.url).href;
  const trace = join(directory, "process-trace.jsonl");
  const code = `import {createUpdateStore} from ${JSON.stringify(moduleUrl)};import {appendFile} from 'node:fs/promises';const store=createUpdateStore({NODE_ENV:'test',SPESESMART_SHEETS_UPDATE_DIR:process.argv[1],GOOGLE_SHEETS_SPREADSHEET_ID:'fixture-spreadsheet'});await store.lock(async()=>{await appendFile(process.argv[2],JSON.stringify({event:'enter',pid:process.pid})+'\\n',{mode:0o600});await new Promise(r=>setTimeout(r,50));await appendFile(process.argv[2],JSON.stringify({event:'leave',pid:process.pid})+'\\n');});`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", code, directory, trace]);
    let output = ""; child.stderr.on("data", chunk => { output += chunk; }); child.on("error", reject); child.on("close", status => status === 0 ? resolve() : reject(Error(output)));
  });
  await Promise.all([run(), run()]);
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map(e => e.event), ["enter", "leave", "enter", "leave"]);
  assert.equal(events[0].pid, events[1].pid); assert.equal(events[2].pid, events[3].pid); assert.notEqual(events[0].pid, events[2].pid);
}));

test("PATCH: produzione, Vercel, CSRF e default readonly bloccano senza contattare Google", async () => {
  const keys = ["NODE_ENV", "VERCEL", "SPESESMART_SHEETS_WRITES_ENABLED", "SPESESMART_ACCESS_USER", "SPESESMART_ACCESS_PASSWORD"];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    process.env.NODE_ENV = "development"; delete process.env.SPESESMART_SHEETS_WRITES_ENABLED;
    assert.equal((await PATCH(new Request("http://localhost/api/archive", { method: "PATCH", headers: { origin: "http://localhost" }, body: "{}" }))).status, 403);
    process.env.SPESESMART_SHEETS_WRITES_ENABLED = "true"; process.env.VERCEL = "1";
    assert.equal((await PATCH(new Request("http://localhost/api/archive", { method: "PATCH", headers: { origin: "http://localhost" }, body: "{}" }))).status, 403);
    delete process.env.VERCEL;
    assert.equal((await PATCH(new Request("http://localhost/api/archive", { method: "PATCH", headers: { origin: "https://outside.example" }, body: "{}" }))).status, 403);
    process.env.NODE_ENV = "production"; delete process.env.SPESESMART_ACCESS_USER; delete process.env.SPESESMART_ACCESS_PASSWORD;
    assert.equal((await PATCH(new Request("http://localhost/api/archive", { method: "PATCH", body: "{}" }))).status, 503);
  } finally { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
