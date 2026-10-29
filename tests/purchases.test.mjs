import test from "node:test";
import assert from "node:assert/strict";
import { buildPurchases, filterPurchases, emptyPurchaseFilters, purchaseFilterErrors } from "../src/lib/purchases.ts";
import { createDraft, prepareConfirmation } from "../src/lib/receipts/model.ts";
import { demoExpenses } from "../src/lib/demo.ts";
const filters = overrides => ({ ...emptyPurchaseFilters, ...overrides });
const movement = (id, values = {}) => ({ id, merchant: "Ferramenta", date: "2026-09-02", amount: 10.1, category: "Casa e Pulizia", source: "Manuale", demo: false, ...values });
function fixture() {
  const item = (description, amountCents, category, values = {}) => ({ description, originalText: description.toUpperCase(), quantity: 1, amountCents, category, kind: "product", confidence: 1, uncertain: false, ...values });
  const analysis = { status: "receipt", merchant: "Market Centrale", date: "2026-10-12", currency: "EUR", totalCents: 950, warnings: [], items: [item("Caffè", 250, "Alimentari", { quantity: 2 }), item("Pane integrale", 450, "Alimentari"), item("Detersivo", 300, "Casa e Pulizia"), item("Sconto fedeltà", -50, "Alimentari", { kind: "discount" })] };
  let n = 0;
  const receipt = prepareConfirmation(createDraft(analysis, () => `line-${++n}`), analysis, "", false, () => `receipt-${++n}`);
  receipt.Documenti[0].image = "data:image/png;base64,dGVzdA=="; // legacy input never exposed by the view
  const expenses = receipt.Movimenti.map(m => ({ id: m.id, merchant: m.merchant, date: m.date, category: m.category, amount: m.amountCents / 100, source: m.source, documentId: m.documentId, demo: false, notes: "Buono fedeltà" }));
  expenses.push(movement("manual-1", { sheetsDocumentId: "manual-doc", description: "Viti" }), movement("manual-2", { sheetsDocumentId: "manual-doc", amount: 2.2, description: "Guarnizione", category: "Trasporti" }), movement("single", { merchant: "Spesa da verificare", date: "2026-08-01", category: "Da classificare", amount: 1.01 }));
  return { expenses, receipts: [receipt] };
}

test("acquisti: un documento una volta, manuali suddivisi e movimenti senza documento", () => {
  const archive = fixture(); const before = structuredClone(archive); const purchases = buildPurchases(archive);
  assert.equal(purchases.length, 3);
  assert.equal(purchases.find(p => p.origin === "Scontrino").totalCents, 950);
  const manual = purchases.find(p => p.id === "document:manual-doc");
  assert.equal(manual.totalCents, 1230); assert.deepEqual(manual.products, []);
  assert.deepEqual(manual.descriptions, ["Viti", "Guarnizione"]);
  assert.equal(purchases.find(p => p.id === "movement:single").totalCents, 101);
  assert.deepEqual(archive, before);
});
test("acquisti: ricerca su negozio, descrizione, prodotti e testo originale, senza distinzione di accenti", () => {
  const purchases = buildPurchases(fixture());
  for (const query of ["MARKET", "caffe", "  centrale  pane ", "SCONTO FEDELTA"]) assert.equal(filterPurchases(purchases, filters({ query }))[0].origin, "Scontrino");
  assert.equal(filterPurchases(purchases, filters({ query: "guarnizione" }))[0].id, "document:manual-doc");
  assert.equal(filterPurchases(purchases, filters({ query: "inesistente" })).length, 0);
});
test("acquisti: filtri combinati inclusivi sull’intero acquisto e categoria tecnica", () => {
  const purchases = buildPurchases(fixture());
  const combined = filters({ query: "caffe", category: "Casa e Pulizia", from: "2026-10-12", to: "2026-10-12", min: "9,50", max: "9.50", origin: "Scontrino" });
  const found = filterPurchases(purchases, combined);
  assert.equal(found.length, 1); assert.equal(found[0].products.length, 4); assert.equal(found[0].totalCents, 950);
  assert.equal(filterPurchases(purchases, { ...combined, origin: "Manuale" }).length, 0);
  assert.equal(filterPurchases(purchases, filters({ category: "Da classificare" }))[0].id, "movement:single");
  assert.equal(filterPurchases(purchases, filters({ origin: "Manuale", category: "Trasporti", min: "12.30", max: "12.30" })).length, 1);
});
test("acquisti: date e importi ordinabili in entrambe le direzioni senza mutare i dati", () => {
  const purchases = buildPurchases(fixture()); const original = structuredClone(purchases);
  assert.deepEqual(filterPurchases(purchases, filters({ sort: "date-desc" })).map(p => p.totalCents), [950, 1230, 101]);
  assert.deepEqual(filterPurchases(purchases, filters({ sort: "date-asc" })).map(p => p.totalCents), [101, 1230, 950]);
  assert.deepEqual(filterPurchases(purchases, filters({ sort: "amount-asc" })).map(p => p.totalCents), [101, 950, 1230]);
  assert.deepEqual(filterPurchases(purchases, filters({ sort: "amount-desc" })).map(p => p.totalCents), [1230, 950, 101]);
  assert.deepEqual(purchases, original);
});
test("acquisti: dettagli strutturati, quantità informative, sconti, subtotali e note senza fotografie", () => {
  const purchase = buildPurchases(fixture()).find(p => p.origin === "Scontrino");
  assert.equal(purchase.date, "2026-10-12"); assert.equal(purchase.merchant, "Market Centrale");
  assert.deepEqual(purchase.notes, ["Buono fedeltà"]);
  assert.equal(purchase.products[0].quantity, 2); assert.equal(purchase.products[0].amountCents, 250);
  assert.equal(purchase.products[3].amountCents, -50);
  assert.deepEqual(purchase.subtotals, [{ category: "Alimentari", amountCents: 650 }, { category: "Casa e Pulizia", amountCents: 300 }]);
  assert.equal(JSON.stringify(purchase).includes("data:image"), false);
});
test("acquisti: storico di entrata e demo esclusi prima della normalizzazione", () => {
  const archive = fixture();
  archive.expenses.push(movement("income", { category: "Casa", type: "income" }), movement("demo", { demo: true }), movement("simulated", { source: "Screenshot demo" }), ...structuredClone(demoExpenses));
  assert.equal(buildPurchases(archive).length, 3);
  archive.receipts[0].Documenti[0].demo = true;
  assert.equal(buildPurchases(archive).length, 2);
});
test("acquisti: archivio vuoto, reset dei filtri e intervalli invalidi", () => {
  assert.deepEqual(buildPurchases({ expenses: [], receipts: [] }), []);
  assert.deepEqual(filterPurchases([], filters()), []);
  const purchases = buildPurchases(fixture());
  assert.equal(filterPurchases(purchases, filters({ query: "nessuno" })).length, 0);
  assert.equal(filterPurchases(purchases, { ...emptyPurchaseFilters }).length, 3);
  for (const bad of [{ min: "1.001" }, { min: "30", max: "10" }, { from: "2026-10-20", to: "2026-10-01" }]) {
    assert.ok(purchaseFilterErrors(filters(bad)).length); assert.deepEqual(filterPurchases(purchases, filters(bad)), []);
  }
});
test("acquisti: resi negativi e cambi a totale zero restano visibili anche senza movimenti", () => {
  const archive = fixture(); const receipt = structuredClone(archive.receipts[0]);
  receipt.Documenti[0].id = "exchange"; receipt.Documenti[0].totalCents = 0; receipt.Movimenti = [];
  receipt.Prodotti = [{ ...receipt.Prodotti[0], amountCents: 500 }, { ...receipt.Prodotti[1], amountCents: -500, kind: "refund" }];
  archive.receipts.push(receipt);
  archive.expenses.push(movement("refund", { amount: -2.15, merchant: "Reso", source: "Altro" }));
  const purchases = buildPurchases(archive);
  assert.equal(purchases.find(p => p.id === "document:exchange").totalCents, 0);
  assert.equal(filterPurchases(purchases, filters({ max: "-2.15", sort: "amount-asc" }))[0].totalCents, -215);
  assert.equal(filterPurchases(purchases, filters({ min: "0", max: "0" })).length, 1);
});
