import test from "node:test";
import assert from "node:assert/strict";
import { zodTextFormat } from "openai/helpers/zod";
import { createRequire } from "node:module";
const OpenAI = createRequire(import.meta.url)("openai");
import { demoReceipt } from "../src/lib/receipts/demo.ts";
import { ReceiptSchema, validateAnalysis, createDraft, reconcile, prepareConfirmation, parseCents, receiptCategories, receiptInstructions } from "../src/lib/receipts/model.ts";
import { handleReceiptRequest, apiError, ReceiptError } from "../src/lib/receipts/analyze-server.ts";
import { MAX_IMAGE_BYTES, validateImageFile } from "../src/lib/receipts/upload.ts";
let counter = 0;
const id = () => `test-${++counter}`;
const clone = (value) => structuredClone(value);
const simple = () => ({ ...clone(demoReceipt), totalCents: 300, items: [clone(demoReceipt.items[0])] });
const draftOf = (receipt) => createDraft(validateAnalysis(receipt), id);
function upload(bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8N8AAAAASUVORK5CYII=", "base64"), type = "image/png") {
  const form = new FormData(); form.append("image", new File([bytes], "receipt.png", { type }));
  return new Request("http://localhost/api/receipts/analyze", { method: "POST", body: form });
}

test("1. scontrino alimentare semplice: conferma e dati Documenti/Prodotti/Movimenti", () => {
  const fixture = simple(); const draft = draftOf(fixture);
  assert.equal(reconcile(draft).valid, true);
  const saved = prepareConfirmation(draft, fixture, "data:image/png;base64,test", false, id);
  assert.equal(saved.Movimenti[0].amountCents, 300);
  assert.equal(saved.Movimenti[0].category, "Alimentari");
  assert.equal(saved.Prodotti[0].documentId, saved.Documenti[0].id);
  assert.equal(saved.Movimenti[0].documentId, saved.Documenti[0].id);
  assert.equal(saved.Documenti[0].syncStatus, "pending");
  assert.deepEqual(saved.Documenti[0].originalAnalysis, fixture);
  assert.equal(saved.Documenti[0].image, "");
  assert.equal(JSON.stringify(saved).includes("data:image/"), false);
});
test("2. scontrino misto: almeno tre categorie e subtotali", () => {
  const result = reconcile(draftOf(demoReceipt));
  assert.equal(result.valid, true);
  assert.deepEqual(result.subtotals.map((s) => s.amountCents), [300, 490, 600]);
});
test("3. quantità multiple: il prezzo di riga non si moltiplica di nuovo", () => {
  const draft = draftOf(simple());
  assert.equal(draft.items[0].quantity, 2);
  assert.equal(reconcile(draft).reconstructedCents, 300);
  draft.items[0].quantity = 3;
  assert.equal(reconcile(draft).reconstructedCents, 300);
});
test("4. sconto separato: importo negativo, subtotale netto", () => {
  const fixture = simple(); fixture.totalCents = 250;
  fixture.items.push({ ...fixture.items[0], description: "Sconto pasta", quantity: null, amountCents: -50, kind: "discount" });
  const draft = draftOf(fixture);
  assert.equal(reconcile(draft).valid, true);
  assert.equal(reconcile(draft).subtotals[0].amountCents, 250);
  draft.items[1].amountCents = 50;
  assert.equal(reconcile(draft).valid, false);
});
test("5. data illeggibile: null, nessuna data inventata, conferma bloccata", () => {
  const fixture = simple(); fixture.date = null;
  const draft = draftOf(fixture);
  assert.equal(draft.date, ""); assert.equal(reconcile(draft).valid, false);
  draft.date = "2026-02-30"; assert.equal(reconcile(draft).valid, false);
  draft.date = "2026-10-11"; assert.equal(reconcile(draft).valid, true);
});
test("6. prodotto ambiguo: Da classificare", () => {
  const fixture = simple(); fixture.items[0].uncertain = true;
  assert.equal(validateAnalysis(fixture).items[0].category, "Da classificare");
  fixture.items[0].uncertain = false; fixture.items[0].confidence = 0.5;
  assert.equal(validateAnalysis(fixture).items[0].category, "Da classificare");
});
test("7. totale incoerente: nessuna modifica automatica o conferma", () => {
  const fixture = simple(); fixture.totalCents = 350;
  const draft = draftOf(fixture);
  assert.equal(reconcile(draft).differenceCents, 50);
  assert.equal(draft.items[0].amountCents, 300);
  assert.throws(() => prepareConfirmation(draft, fixture, "", false, id));
});
test("8. modifica manuale dei prezzi: quadratura aggiornata in centesimi", () => {
  const fixture = simple(); fixture.totalCents = 350;
  const draft = draftOf(fixture);
  draft.items[0].amountCents = parseCents("3,50");
  assert.equal(reconcile(draft).valid, true);
  assert.equal(parseCents("0.10") + parseCents("0.20"), 30);
  for (const value of ["", "1.234", "abc", "1e3", "Infinity"]) assert.equal(parseCents(value), null);
});
test("9. risposta AI non valida: endpoint rifiuta dati fuori schema", async () => {
  const result = await handleReceiptRequest(upload(), "fixture-key", async () => ({ merchant: "Negozio" }));
  assert.equal(result.status, 502); assert.equal((await result.json()).code, "INVALID_AI");
  const fixture = simple(); fixture.items[0].category = "Stipendio";
  assert.throws(() => validateAnalysis(fixture));
});
test("10. chiave API mancante: nessuna chiamata e demo utilizzabile", async () => {
  let calls = 0;
  const response = await handleReceiptRequest(upload(), undefined, async () => { calls++; return simple(); });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "MISSING_API_KEY");
  assert.equal(calls, 0);
  assert.equal(reconcile(draftOf(demoReceipt)).valid, true);
});
test("rettifica: solo manuale, motivata e di importo coerente", () => {
  const fixture = simple(); fixture.totalCents = 350;
  const draft = draftOf(fixture);
  draft.items.push({ ...draft.items[0], id: id(), kind: "adjustment", description: "Rettifica", quantity: null, amountCents: 50, reason: "" });
  assert.equal(reconcile(draft).valid, false);
  draft.items[1].reason = "Sacchetto leggibile in foto ma omesso dall’analisi";
  assert.equal(reconcile(draft).valid, true);
  assert.equal(prepareConfirmation(draft, fixture, "", false, id).Prodotti[1].reason, draft.items[1].reason);
});
test("foto illeggibile e immagine senza scontrino: messaggi italiani", async () => {
  for (const status of ["unreadable", "not_receipt"]) {
    const response = await handleReceiptRequest(upload(), "fixture-key", async () => ({ ...simple(), status }));
    assert.equal(response.status, 422); assert.equal((await response.json()).code, status);
  }
});
test("formati, firma reale e limite 10 MB sul server", async () => {
  assert.ok(validateImageFile({ size: MAX_IMAGE_BYTES + 1, type: "image/png" }));
  assert.ok(validateImageFile({ size: 0, type: "image/png" }));
  assert.ok(validateImageFile({ size: 100, type: "application/pdf" }));
  let calls = 0; const fake = async () => { calls++; return simple(); };
  assert.equal((await handleReceiptRequest(upload(new Uint8Array([1, 2, 3])), "key", fake)).status, 415);
  assert.equal((await handleReceiptRequest(upload(new Uint8Array(MAX_IMAGE_BYTES + 1)), "key", fake)).status, 413);
  assert.equal((await handleReceiptRequest(upload(new Uint8Array([1]), "application/pdf"), "key", fake)).status, 415);
  assert.equal(calls, 0);
});
test("limite corpo senza Content-Length", async () => {
  const request = new Request("http://localhost/api/receipts/analyze", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: new Uint8Array(MAX_IMAGE_BYTES + 65537) });
  assert.equal((await handleReceiptRequest(request, "key", async () => simple())).status, 413);
});
test("endpoint valido: analizza fixture senza API a pagamento", async () => {
  const response = await handleReceiptRequest(upload(), "fixture-key", async (image, key) => {
    assert.ok(image.startsWith("data:image/png;base64,")); assert.equal(key, "fixture-key"); return simple();
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).receipt.totalCents, 300);
});
test("timeout e errori API", () => {
  assert.equal(apiError(new OpenAI.APIConnectionTimeoutError()).status, 504);
  assert.equal(apiError(new OpenAI.APIError(429, {}, "limit", new Headers())).status, 429);
  assert.equal(apiError(new OpenAI.APIError(401, {}, "key", new Headers())).code, "CONFIGURATION");
});
test("Structured Outputs: schema strict generabile dal helper ufficiale", () => {
  const format = zodTextFormat(ReceiptSchema, "receipt");
  assert.equal(format.strict, true); assert.equal(format.schema.additionalProperties, false);
  assert.ok(format.schema.required.includes("items"));
});
test("campi mancanti e valuta diversa: revisione obbligatoria", () => {
  const fixture = simple(); fixture.merchant = null; fixture.totalCents = null;
  fixture.items[0].amountCents = null; fixture.currency = null;
  const draft = draftOf(fixture);
  assert.equal(draft.merchant, ""); assert.equal(draft.currency, "");
  assert.equal(reconcile(draft).valid, false);
  draft.currency = "USD"; assert.equal(reconcile(draft).valid, false);
});

test("immagine con firma valida ma contenuto corrotto: nessuna chiamata AI", async () => {
  let calls = 0;
  const response = await handleReceiptRequest(upload(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])), "key", async () => { calls++; return simple(); });
  assert.equal(response.status, 422); assert.equal((await response.json()).code, "CORRUPT_IMAGE"); assert.equal(calls, 0);
});
test("risposta incompleta e timeout API vengono restituiti senza salvare", async () => {
  const incomplete = await handleReceiptRequest(upload(), "key", async () => { throw new ReceiptError(502, "INCOMPLETE", "Risposta incompleta"); });
  assert.equal(incomplete.status, 502); assert.equal((await incomplete.json()).code, "INCOMPLETE");
  const timeout = await handleReceiptRequest(upload(), "key", async () => { throw new OpenAI.APIConnectionTimeoutError(); });
  assert.equal(timeout.status, 504);
});

test("Animali: schema AI, revisione e dati Sheets per cibo e medicinali veterinari", () => {
  assert.ok(receiptCategories.includes("Animali"));
  assert.ok(receiptInstructions.includes("Crocchette per cani"));
  assert.ok(receiptInstructions.includes("antiparassitari veterinari appartengono ad Animali"));
  for (const description of ["Crocchette per cani", "Lettiera per gatti", "Antiparassitari veterinari", "Medicinali veterinari"]) {
    const fixture = simple(); fixture.items[0].description = description; fixture.items[0].category = "Animali";
    const analysis = validateAnalysis(fixture);
    const draft = createDraft(analysis, id);
    assert.equal(draft.items[0].category, "Animali");
    assert.equal(reconcile(draft).valid, true);
    const saved = prepareConfirmation(draft, analysis, "", false, id);
    assert.equal(saved.Prodotti[0].categoryId, "pets");
    assert.equal(saved.Movimenti[0].categoryId, "pets");
    assert.equal(saved.Movimenti[0].amountCents, 300);
  }
});

test("utenze e manutenzioni: prompt, schema AI, revisione e ID persistenti condivisi", () => {
  for (const [category, categoryId] of [["Utenze e Abbonamenti digitali", "digital-subscriptions"], ["Manutenzioni Ristrutturazioni", "maintenance-renovations"]]) {
    assert.ok(receiptInstructions.includes(category + ":"));
    const fixture = simple(); fixture.items[0].category = category;
    const analysis = validateAnalysis(fixture);
    const saved = prepareConfirmation(createDraft(analysis, id), analysis, "", false, id);
    assert.equal(saved.Prodotti[0].categoryId, categoryId);
    assert.equal(saved.Movimenti[0].categoryId, categoryId);
  }
});
