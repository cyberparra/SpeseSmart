import './helpers/isolated-host-policy.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSheetsRepository } from "../src/lib/sheets-repository.ts";
import { TABLE_HEADERS, readSnapshot, canonical, operationRows, extraHeaders } from "../src/lib/sheets-persistence-model.ts";
import { categoryDefinitions } from "../src/lib/categories.ts";
import { createBackup, parseBackup, restoreBackup } from "../src/lib/archive.ts";
import { prepareConfirmation, createDraft } from "../src/lib/receipts/model.ts";
import { demoReceipt } from "../src/lib/receipts/demo.ts";
import { spendingSummary } from "../src/lib/spending.ts";
import { revisePurchase } from "../src/lib/purchase-edit.ts";
import { buildPurchases } from "../src/lib/purchases.ts";
import { GET, POST } from "../src/app/api/archive/route.ts";

function fixture() {
  const data = Object.fromEntries(Object.entries(TABLE_HEADERS).map(([name, headers], id) => [name, { id, columns: 26, rows: [[...headers]] }]));
  data.Categorie.rows.push(...categoryDefinitions.filter(c => c.name !== "Animali").map(c => [c.name, "Spese", "Sì", "Indicazioni precedenti"]), ["Stipendio", "Entrate", "Sì", "Storico"], ["Altre entrate", "Entrate", "Sì", "Storico"]);
  return data;
}
function fake(data = fixture()) {
  let calls = 0;
  const transport = {
    data, get calls() { return calls; },
    async read() { return structuredClone(data); },
    async write(changes) {
      calls++;
      const next = structuredClone(data);
      for (const change of changes) {
        if ("insertCategoryRow" in change) next.Categorie.rows.splice(change.insertCategoryRow, 0, []);
        else change.values.forEach((values, offset) => {
          const table = next[change.sheet];
          table.rows[change.row + offset] ??= [];
          values.forEach((v, i) => { table.rows[change.row + offset][change.column + i] = v; });
          table.columns = Math.max(table.columns, change.column + values.length);
        });
      }
      Object.assign(data, next);
    },
  };
  return transport;
}
const manual = () => ({ kind: "manual", operationId: "00000000-0000-4000-8000-000000000001", draft: { description: "Supermercato", date: "2026-10-12", notes: "Nota", items: [{ category: "Alimentari", amount: "45.90" }, { category: "Animali", amount: "23.50" }] } });
function receipt(imageSize = 8) {
  let i = 0;
  const image = "data:image/png;base64," + "a".repeat(imageSize);
  const imageHash = createHash("sha256").update(JSON.stringify(image)).digest("hex");
  return prepareConfirmation(createDraft(structuredClone(demoReceipt), () => `p-${++i}`), structuredClone(demoReceipt), image, false, () => `r-${++i}`, imageHash);
}
async function ready(transport) {
  const repo = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, transport, true);
  await repo.applySetup((await repo.previewSetup()).fingerprint);
  return repo;
}
test.beforeEach(() => { globalThis.spesesmartSheetsUncertain = false; });

test("persistenza: POST bloccato in produzione e Vercel; locale supera il gate senza scrivere richieste invalide", async () => {
  const keys = ["NODE_ENV", "VERCEL", "SPESESMART_SHEETS_WRITES_ENABLED", "SPESESMART_ACCESS_USER", "SPESESMART_ACCESS_PASSWORD"];
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.SPESESMART_SHEETS_WRITES_ENABLED = "true";
    process.env.SPESESMART_ACCESS_USER = "fixture"; process.env.SPESESMART_ACCESS_PASSWORD = "fixture";
    const headers = { origin: "http://localhost", authorization: "Basic " + Buffer.from("fixture:fixture").toString("base64") };
    for (const [mode, vercel, code] of [["production", undefined, "WRITES_DISABLED"], ["development", "1", "WRITES_DISABLED"], ["development", undefined, "INVALID"]]) {
      process.env.NODE_ENV = mode;
      if (vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = vercel;
      const response = await POST(new Request("http://localhost/api/archive", { method: "POST", headers, body: "not-json" }));
      assert.equal((await response.json()).code, code);
    }
  } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
});

test("persistenza: archivio in produzione protetto prima di qualsiasi richiesta Google", async () => {
  const keys = ["NODE_ENV", "SPESESMART_ACCESS_USER", "SPESESMART_ACCESS_PASSWORD"];
  const previous = keys.map(key => process.env[key]);
  try {
    process.env.NODE_ENV = "production";
    delete process.env.SPESESMART_ACCESS_USER; delete process.env.SPESESMART_ACCESS_PASSWORD;
    assert.equal((await GET(new Request("http://localhost/api/archive"))).status, 503);
    process.env.SPESESMART_ACCESS_USER = "fixture"; process.env.SPESESMART_ACCESS_PASSWORD = "fixture";
    assert.equal((await GET(new Request("http://localhost/api/archive"))).status, 401);
    const auth = "Basic " + Buffer.from("fixture:fixture").toString("base64");
    const denied = await POST(new Request("http://localhost/api/archive", { method: "POST", headers: { authorization: auth, origin: "http://other.invalid" }, body: "{}" }));
    assert.equal(denied.status, 403);
  } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
});

test("persistenza: reso resta Uscita, segno remoto positivo e totale locale negativo", async () => {
  const t = fake(); const repo = await ready(t);
  const analysis = structuredClone(demoReceipt); analysis.totalCents = -500;
  analysis.items = [{ ...analysis.items[0], category: "Animali", amountCents: -500, kind: "refund", description: "Reso accessorio", reason: "Reso verificato" }];
  let i = 0;
  const r = prepareConfirmation(createDraft(analysis, () => `refund-p-${++i}`), analysis, "data:image/png;base64,cmVmdW5k", false, () => `refund-r-${++i}`);
  await repo.save({ kind: "receipt", operationId: r.Documenti[0].id, receipt: r });
  assert.equal(t.data.Movimenti.rows[1][3], "Uscita");
  assert.equal(t.data.Movimenti.rows[1][7], 5);
  const stats = spendingSummary((await repo.load()).archive.expenses, r.Documenti[0].date.slice(0, 7), 10000);
  assert.equal(stats.totalCents, -500); assert.equal(stats.remainingCents, 10500);
});

test("persistenza: snapshot nel backup si ripristina senza perdita o duplicazione e mantiene compatibilità v1", () => {
  const original = { ...readSnapshot(fixture(), "11111111-1111-4111-8111-111111111111").archive, googleSheetsSnapshot: fixture() };
  const backup = createBackup(original);
  const restored = restoreBackup({ expenses: [], receipts: [] }, backup);
  assert.deepEqual(restored, original);
  assert.deepEqual(restoreBackup(restored, backup), restored);
  const other = structuredClone(original); other.googleSheetsSnapshot.Movimenti.rows.push(["dato storico"]);
  const merged = restoreBackup(restored, createBackup(other));
  assert.equal(merged.googleSheetsSnapshot.snapshots.length, 2);
  assert.deepEqual(restoreBackup(merged, createBackup(other)), merged);
  assert.deepEqual(restoreBackup({ expenses: [], receipts: [] }, createBackup({ expenses: [], receipts: [] })), { expenses: [], receipts: [] });
});

test("persistenza: stessa immagine con nuovi ID non viene aggiunta nuovamente", async () => {
  const t = fake(); const repo = await ready(t); const first = receipt();
  await repo.save({ kind: "receipt", operationId: first.Documenti[0].id, receipt: first });
  let i = 0;
  const second = prepareConfirmation(createDraft(structuredClone(demoReceipt), () => `new-p-${++i}`), structuredClone(demoReceipt), "", false, () => `new-r-${++i}`, first.Documenti[0].imageHash);
  const before = structuredClone(t.data);
  await assert.rejects(repo.save({ kind: "receipt", operationId: second.Documenti[0].id, receipt: second }), { code: "DUPLICATE_DOCUMENT" });
  assert.deepEqual(t.data, before);
});

test("persistenza: righe modificate fuori dall'app restano nel backup ma non producono totali incoerenti", async () => {
  const t = fake(); const repo = await ready(t); await repo.save(manual());
  t.data.Movimenti.rows[1][7] = -500;
  const loaded = await repo.load();
  assert.equal(loaded.archive.expenses.length, 0);
  assert.ok(loaded.warnings.length);
  assert.equal(loaded.archive.googleSheetsSnapshot, undefined);
  assert.equal(t.data.Movimenti.rows[1][7], -500);
});

test("persistenza: anteprima non scrive; default blocca setup e salvataggio prima di contattare il writer", async () => {
  const t = fake(); const repo = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, t);
  const plan = await repo.previewSetup();
  assert.ok(plan.changes.some(c => c.insertCategoryRow === 12));
  assert.equal(t.calls, 0);
  await assert.rejects(repo.applySetup(plan.fingerprint), { code: "WRITES_DISABLED" });
  await assert.rejects(repo.save(manual()), { code: "WRITES_DISABLED" });
  assert.equal(t.calls, 0);
});
test("persistenza: allineamento 13 categorie + tecnica preserva storico e transazioni, anteprima obsoleta bloccata", async () => {
  const t = fake(); t.data.Movimenti.rows.push(["historical", "", "2026-10-10", "Entrata", "", "", "Stipendio", 2000, "Manuale", "Confermato", "", ""]);
  const original = structuredClone(t.data.Movimenti.rows[1]);
  const repo = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, t, true); const plan = await repo.previewSetup();
  t.data.Categorie.rows[1][3] = "Modificato dopo anteprima";
  await assert.rejects(repo.applySetup(plan.fingerprint), { code: "STALE_PLAN" });
  await repo.applySetup((await repo.previewSetup()).fingerprint);
  assert.deepEqual(t.data.Categorie.rows.slice(1, 15).map(r => r[0]), categoryDefinitions.map(c => c.name));
  assert.equal(t.data.Categorie.rows[15][2], "No");
  assert.equal(t.data.Categorie.rows[16][2], "No");
  assert.deepEqual(t.data.Movimenti.rows[1], original);
  assert.equal((await repo.previewSetup()).changes.length, 0);
});
test("persistenza: manuale, conversione segno al confine, note e backup completi; retry e doppio invio senza duplicati", async () => {
  const t = fake(); const repo = await ready(t);
  const results = await Promise.all([repo.save(manual()), repo.save(manual())]);
  assert.equal(results[1].duplicate, true);
  assert.equal(t.data.Movimenti.rows.length, 3);
  assert.equal(t.data.Documenti.rows.length, 2);
  assert.equal(t.data.Movimenti.rows[1][7], -45.9);
  const loaded = await repo.load();
  const stats = spendingSummary(loaded.archive.expenses, "2026-10", 5000);
  assert.equal(stats.totalCents, 6940); assert.equal(stats.remainingCents, -1940);
  assert.equal(loaded.archive.expenses[0].notes, "Nota");
  assert.equal(buildPurchases(loaded.archive).length, 1);
  assert.equal(buildPurchases(loaded.archive)[0].totalCents, 6940);
  assert.deepEqual(parseBackup(JSON.stringify(createBackup(loaded.archive))).archive, loaded.archive);
});
test("persistenza: lo stesso ID con contenuto diverso è un conflitto e non sovrascrive", async () => {
  const t = fake(); const repo = await ready(t); await repo.save(manual());
  const before = structuredClone(t.data); const changed = manual(); changed.draft.notes = "Diverse";
  await assert.rejects(repo.save(changed), { code: "CONFLICT" });
  assert.deepEqual(t.data, before);
});
test("persistenza: foto grande esclusa, analisi originale, prodotti e subtotali ripristinabili", async () => {
  const t = fake(); const repo = await ready(t); const r = receipt(120000);
  await repo.save({ kind: "receipt", operationId: r.Documenti[0].id, receipt: r });
  assert.equal(t.data.Documenti.rows.length, 2);
  assert.equal(t.data.Prodotti.rows.length, r.Prodotti.length + 1);
  assert.equal(t.data.Movimenti.rows.length, r.Movimenti.length + 1);
  const loaded = await repo.load();
  assert.deepEqual(loaded.archive.receipts[0], r);
  assert.deepEqual(parseBackup(JSON.stringify(createBackup(loaded.archive))).archive.receipts[0], r);
  assert.equal(t.data.Documenti.rows[0].length, TABLE_HEADERS.Documenti.length + 3);
  assert.equal(JSON.stringify(t.data).includes("data:image/"), false);
});

test("persistenza: lettura storica con fotografia, backup senza copie nei frammenti e deduplicazione con nuovi ID", async () => {
  const t = fake(); const repo = await ready(t);
  const legacy = receipt(120000);
  legacy.Documenti[0].image = "data:image/png;base64," + "a".repeat(120000);
  delete legacy.Documenti[0].imageHash;
  const archive = { receipts: [legacy], expenses: legacy.Movimenti.map(m => ({ id: m.id, merchant: m.merchant, date: m.date, category: m.category, categoryId: m.categoryId, amount: m.amountCents / 100, source: m.source, documentId: m.documentId, demo: false })) };
  const rows = operationRows({ kind: "receipt", operationId: legacy.Documenti[0].id, archive }, "legacy-hash", undefined, "11111111-1111-4111-8111-111111111111");
  for (const name of ["Movimenti", "Prodotti", "Documenti"]) {
    t.data[name].rows.push(...rows[name]);
    t.data[name].rows[0] = [...TABLE_HEADERS[name], ...extraHeaders(rows[name][0].length - TABLE_HEADERS[name].length - 2)];
  }
  const before = structuredClone(t.data);
  const loaded = await repo.load();
  assert.deepEqual(loaded.archive.receipts[0], legacy);
  const backup = createBackup(loaded.archive);
  assert.equal(JSON.stringify(backup).includes("data:image/"), false);
  assert.equal(JSON.stringify(backup).includes("a".repeat(1000)), false);
  const restored = parseBackup(JSON.stringify(backup)).archive;
  assert.equal(restored.receipts[0].Documenti[0].image, "");
  assert.deepEqual(restored.receipts[0].Prodotti, legacy.Prodotti);
  assert.deepEqual(restoreBackup(loaded.archive, backup).receipts[0], legacy);
  assert.deepEqual(parseBackup(JSON.stringify({ ...backup, archive: loaded.archive })).archive.receipts[0], legacy);
  let i = 0;
  const second = receipt(120000);
  second.Documenti[0].id = "new-document";
  for (const row of [...second.Movimenti, ...second.Prodotti]) { row.documentId = "new-document"; row.id = `new-${++i}`; }
  await assert.rejects(repo.save({ kind: "receipt", operationId: "new-document", receipt: second }), { code: "DUPLICATE_DOCUMENT" });
  assert.deepEqual(t.data, before);
});

test("persistenza: vecchio client e immagini indirette vengono ripuliti prima del writer", async () => {
  const t = fake(); const repo = await ready(t); const r = receipt();
  r.Documenti[0].image = "data:image/png;base64,dGVzdA==";
  r.Documenti[0].metadata = { photoBase64: "dGVzdA==", nested: JSON.stringify({ image: r.Documenti[0].image, note: "conservata" }) };
  const saved = await repo.save({ kind: "receipt", operationId: r.Documenti[0].id, receipt: r });
  assert.equal(JSON.stringify(t.data).includes("dGVzdA=="), false);
  assert.equal(saved.archive.receipts[0].Documenti[0].image, "");
  assert.equal(saved.archive.receipts[0].Documenti[0].imageHash.length, 64);
  assert.equal(JSON.parse(saved.archive.receipts[0].Documenti[0].metadata.nested).note, "conservata");
  assert.equal((await repo.load()).archive.receipts.length, 1);
  assert.equal((await repo.save({ kind: "receipt", operationId: r.Documenti[0].id, receipt: r })).duplicate, true);
});
test("persistenza: demo, entrate manuali e quadratura alterata rifiutate prima del salvataggio", async () => {
  const t = fake(); const repo = await ready(t); const calls = t.calls;
  const demo = receipt(); demo.Documenti[0].demo = true;
  await assert.rejects(repo.save({ kind: "receipt", operationId: demo.Documenti[0].id, receipt: demo }), { code: "DEMO" });
  const income = manual(); income.draft.items[0].category = "Stipendio";
  await assert.rejects(repo.save(income));
  const bad = receipt(); bad.Documenti[0].totalCents += 1;
  await assert.rejects(repo.save({ kind: "receipt", operationId: bad.Documenti[0].id, receipt: bad }), { code: "QUADRATURA" });
  assert.equal(t.calls, calls);
});
test("persistenza: risposta persa dopo commit riconosciuta mediante rilettura, retry senza duplicati", async () => {
  const t = fake(); const repo = await ready(t); const write = t.write;
  t.write = async changes => { await write(changes); throw new Error("risposta persa"); };
  assert.equal((await repo.save(manual())).saved, true);
  assert.equal((await repo.save(manual())).duplicate, true);
  assert.equal(t.data.Movimenti.rows.length, 3);
});
test("persistenza: fallimento pre-commit conserva dati e blocca retry incerti", async () => {
  const t = fake(); const repo = await ready(t); const before = structuredClone(t.data);
  t.write = async () => { throw new Error("timeout"); };
  await assert.rejects(repo.save(manual()), { code: "UNCERTAIN" });
  assert.deepEqual(t.data, before);
  await assert.rejects(repo.save(manual()), { code: "UNCERTAIN" });
});
test("persistenza: riparazione parziale conserva righe già esistenti e completa soltanto quelle mancanti", async () => {
  const t = fake(); const repo = await ready(t); await repo.save(manual());
  t.data.Movimenti.rows.pop();
  assert.equal((await repo.load()).archive.expenses.length, 0);
  assert.ok((await repo.load()).warnings.length);
  await repo.save(manual());
  assert.equal(t.data.Movimenti.rows.length, 3);
  assert.equal((await repo.load()).archive.expenses.length, 2);
});
test("persistenza: lettura storico OUT negativo, reso positivo e IN preservato, senza demo", () => {
  const data = fixture();
  data.Movimenti.rows.push(
    ["real-1", "", "2026-10-01", "Uscita", "", "Negozio", "Alimentari", -10, "Manuale", "Confermato"],
    ["real-2", "", "2026-10-02", "Uscita", "", "Reso", "Alimentari", 2, "Manuale", "Confermato"],
    ["income", "", "2026-10-02", "Entrata", "", "Storico", "Stipendio", 2000, "Manuale", "Confermato"],
    ["demo", "", "2026-10-02", "Uscita", "", "Esempio", "Alimentari", -100, "Scontrino demo", "Confermato"],
  );
  for (const row of data.Movimenti.rows.slice(1)) { while (row.length < 12) row.push(""); row[12] = "11111111-1111-4111-8111-111111111111"; }
  const before = canonical(data); const loaded = readSnapshot(data, "11111111-1111-4111-8111-111111111111");
  assert.equal(spendingSummary(loaded.archive.expenses, "2026-10", 10000).totalCents, 800);
  assert.equal(loaded.archive.expenses.find(e => e.id === "income").amount, 2000);
  assert.equal(loaded.archive.googleSheetsSnapshot, undefined);
  assert.equal(data.Movimenti.rows.length, 5);
  assert.equal(canonical(data), before);
});
test("persistenza: POST reale bloccato per default, nessun contatto Google", async () => {
  const previous = process.env.SPESESMART_SHEETS_WRITES_ENABLED;
  delete process.env.SPESESMART_SHEETS_WRITES_ENABLED;
  try {
    const response = await POST(new Request("http://localhost/api/archive", { method: "POST", headers: { origin: "http://localhost" }, body: JSON.stringify(manual()) }));
    assert.equal(response.status, 403); assert.equal((await response.json()).code, "WRITES_DISABLED");
  } finally { if (previous !== undefined) process.env.SPESESMART_SHEETS_WRITES_ENABLED = previous; }
});

test("rinomina: documento nativo storico, backup e modifica conservano ID e analisi originale", async () => {
  const t = fake(); const repo = await ready(t);
  const analysis = structuredClone(demoReceipt);
  analysis.items.forEach(item => { item.category = "Utenze e Abbonamenti digitali"; });
  let i = 0;
  const receipt = prepareConfirmation(createDraft(analysis, () => `alias-p-${++i}`), analysis, "", false, () => `alias-r-${++i}`);
  const archive = { receipts: [receipt], expenses: receipt.Movimenti.map(m => ({ id: m.id, documentId: m.documentId, merchant: m.merchant, date: m.date, category: m.category, categoryId: m.categoryId, amount: m.amountCents / 100, source: m.source, demo: false })) };
  const legacy = JSON.parse(JSON.stringify(archive), (key, value) => key === "category" && value === "Utenze e Abbonamenti digitali" ? "Abbonamenti Digitali" : value);
  const rows = operationRows({ kind: "receipt", operationId: receipt.Documenti[0].id, archive: legacy }, "legacy-hash", undefined, "11111111-1111-4111-8111-111111111111");
  for (const name of ["Movimenti", "Prodotti", "Documenti"]) {
    t.data[name].rows.push(...rows[name]);
    t.data[name].rows[0] = [...TABLE_HEADERS[name], ...extraHeaders(rows[name][0].length - TABLE_HEADERS[name].length - 2)];
  }
  const before = structuredClone(t.data);
  const loaded = await repo.load();
  assert.deepEqual(loaded.archive.receipts[0], legacy.receipts[0]);
  assert.deepEqual(parseBackup(JSON.stringify(createBackup(loaded.archive))).archive.receipts[0], legacy.receipts[0]);
  const purchase = loaded.editablePurchases[receipt.Documenti[0].id];
  assert.ok(purchase.draft.items.every(item => item.category === "Utenze e Abbonamenti digitali"));
  assert.deepEqual(t.data, before);
  const updated = revisePurchase("receipt", legacy, purchase.draft).archive.receipts[0];
  assert.ok(updated.Prodotti.every(item => item.categoryId === "digital-subscriptions"));
  assert.deepEqual(updated.Documenti[0].originalAnalysis, legacy.receipts[0].Documenti[0].originalAnalysis);
});

test("categorie: anteprima e applicazione esplicita del vecchio catalogo senza toccare movimenti", async () => {
  const t = fake();
  t.data.Categorie.rows = [t.data.Categorie.rows[0], ...categoryDefinitions.filter(c => c.id !== "maintenance-renovations").map(c => [c.id === "digital-subscriptions" ? "Abbonamenti Digitali" : c.name, "Spese", "Sì", "Descrizione precedente"])];
  const before = structuredClone(t.data);
  const repo = createSheetsRepository({ id: "11111111-1111-4111-8111-111111111111" }, t, true);
  const plan = await repo.previewSetup();
  assert.deepEqual(t.data, before);
  await repo.applySetup(plan.fingerprint);
  assert.deepEqual(t.data.Categorie.rows.slice(1).map(r => r[0]), categoryDefinitions.map(c => c.name));
  for (const name of ["Movimenti", "Prodotti", "Documenti"]) assert.deepEqual(t.data[name].rows.slice(1), before[name].rows.slice(1));
  assert.equal((await repo.previewSetup()).changes.length, 0);
});
