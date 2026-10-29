import test from "node:test";
import assert from "node:assert/strict";
import {
  createBackup, parseBackup, inspectArchive, movementOrigin, planReset,
  resetArchive, resetConfirmation, restoreBackup, initialExpenses, DEMO_DISABLED_KEY,
} from "../src/lib/archive.ts";
import { demoExpenses } from "../src/lib/demo.ts";
import { categoryDefinitions, expenseCategories } from "../src/lib/categories.ts";
import { demoReceipt } from "../src/lib/receipts/demo.ts";
import { createDraft, prepareConfirmation } from "../src/lib/receipts/model.ts";

const clone = (value) => structuredClone(value);
const baseline = () => ({ expenses: clone(demoExpenses), receipts: [] });
const manual = { id: "manual-real", merchant: "Prova supermercato", date: "2026-08-02", amount: 25.37, category: "Alimentari", source: "Manuale" };
function memoryStorage() {
  const data = new Map([["settings", '{"budget":2000}'], ["credentials", "untouched-test-placeholder"]]);
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}
function receiptArchive(demo, prefix = "receipt") {
  let nextId = 0;
  const id = () => `${prefix}-${++nextId}`;
  const analysis = clone(demoReceipt);
  const draft = createDraft(analysis, id);
  const receipt = prepareConfirmation(draft, analysis, demo ? "" : "data:image/png;base64,dGVzdA==", demo, id);
  return {
    receipts: [receipt],
    expenses: receipt.Movimenti.map((movement) => ({
      id: movement.id, documentId: movement.documentId, merchant: movement.merchant, date: movement.date,
      category: movement.category, source: movement.source, amount: movement.amountCents / 100, demo,
    })),
  };
}
function mixed() {
  const demo = receiptArchive(true, "demo");
  const real = receiptArchive(false, "real");
  return { expenses: [...clone(demoExpenses), clone(manual), ...demo.expenses, ...real.expenses], receipts: [...demo.receipts, ...real.receipts] };
}

test("inventario: 15 demo iniziali per 2608,28 euro, su tutti i mesi; nessuna mutazione", () => {
  const archive = baseline(); const before = clone(archive);
  assert.deepEqual(inspectArchive(archive), { movements: 15, demo: 15, possibleReal: 0, documents: 0, products: 0 });
  assert.equal(archive.expenses.reduce((sum, expense) => sum + Math.round(expense.amount * 100), 0), 260828);
  assert.equal(planReset(archive, "demo").movements, 15);
  assert.deepEqual(archive, before);
});

test("classificazione conservativa: ID, descrizione e importo da soli non dimostrano una demo", () => {
  assert.equal(movementOrigin(manual, []), "possible-real");
  assert.equal(movementOrigin({ ...manual, id: "1" }, []), "possible-real");
  assert.equal(movementOrigin({ ...demoExpenses[0], id: "real-copy" }, []), "possible-real");
  assert.equal(movementOrigin({ ...demoExpenses[0], demo: false }, []), "possible-real");
  assert.equal(movementOrigin({ ...demoExpenses[5], category: "Casa e Pulizia", originalCategory: "Casa" }, []), "demo");
  assert.equal(movementOrigin({ ...manual, source: "Screenshot" }, []), "demo");
  assert.equal(movementOrigin({ ...manual, source: "Screenshot demo", demo: false }, []), "possible-real");
});

test("backup JSON indipendente senza foto: campi storici, centesimi, righe, analisi e metadati", () => {
  const archive = mixed();
  archive.expenses[5].originalCategory = "Casa";
  archive.expenses[5].category = "Casa e Pulizia";
  archive.expenses[0].extraLegacyField = { untouched: true };
  archive.receipts[0].Prodotti[0].reason = "Motivo originale da preservare";
  const backup = createBackup(archive);
  const restored = parseBackup(JSON.stringify(backup));
  assert.deepEqual(restored.archive, archive);
  assert.deepEqual(restored.categories, categoryDefinitions);
  assert.equal(restored.units.receiptAmounts, "integer-cents");
  assert.equal(restored.archive.receipts[1].Documenti[0].image, "");
  assert.deepEqual(restored.archive.receipts[1].Documenti[0].originalAnalysis, demoReceipt);
  archive.expenses[0].amount = 999;
  assert.equal(backup.archive.expenses[0].amount, 64.8);
});

test("backup storico con foto: reset e ripristino senza conflitti, copie indirette escluse", () => {
  const archive = receiptArchive(false);
  const photo = "data:image/png;base64,dGVzdA==";
  archive.receipts[0].Documenti[0].image = photo;
  archive.receipts[0].Documenti[0].extra = { imageBytes: [1, 2, 3], photoBase64: "dGVzdA==", note: "nota strutturata" };
  archive.googleSheetsSnapshot = { snapshots: [{ Documenti: { rows: [["ID documento", "SpeseSmart JSON 1", "SpeseSmart JSON 2"], ["receipt", '{"image":"data:im', 'age/png;base64,dGVzdA==","note":"nota"}']] } }] };
  const before = clone(archive);
  const backup = createBackup(archive);
  assert.equal(JSON.stringify(backup).includes("dGVzdA=="), false);
  assert.deepEqual(archive, before);
  assert.equal(backup.archive.receipts[0].Documenti[0].extra.note, "nota strutturata");
  assert.equal(JSON.parse(backup.archive.googleSheetsSnapshot.snapshots[0].Documenti.rows[1].slice(1).join("")).note, "nota");
  assert.deepEqual(restoreBackup(archive, backup), archive);
  const storage = memoryStorage();
  assert.equal(resetArchive(archive, backup, "all", resetConfirmation(archive.expenses.length), storage).receipts.length, 0);
  archive.receipts[0].Prodotti[0].reason = "cambiata dopo backup";
  assert.throws(() => resetArchive(archive, backup, "all", resetConfirmation(archive.expenses.length), storage), /cambiato/);
});

test("backup blocca fotografie in JSON tecnico troncato; preserva righe ambigue senza immagini", () => {
  const archive = { expenses: [], receipts: [], googleSheetsSnapshot: { Documenti: { rows: [["ID", "SpeseSmart JSON 1"], ["doc", '{"image":"data:image/png;base64,dGVzdA==']] } } };
  assert.throws(() => createBackup(archive), /incompleto/);
  archive.googleSheetsSnapshot.Documenti.rows[1][1] = '{"unknown":';
  assert.deepEqual(createBackup(archive).archive, archive);
});

test("nessun reset senza conferma esatta, anche con backup disponibile", () => {
  const archive = mixed(); const before = clone(archive); const storage = memoryStorage();
  for (const confirmation of ["", "sì", "ELIMINA 1 MOVIMENTI"]) {
    assert.throws(() => resetArchive(archive, createBackup(archive), "all", confirmation, storage), /conferma/);
  }
  assert.deepEqual(archive, before);
  assert.equal(storage.getItem(DEMO_DISABLED_KEY), null);
});

test("backup obsoleto: blocca anche se cambia solo un campo a parità di conteggio", () => {
  const archive = mixed(); const backup = createBackup(archive); const storage = memoryStorage();
  archive.expenses[0].amount += 1;
  assert.throws(() => resetArchive(archive, backup, "all", resetConfirmation(archive.expenses.length), storage), /cambiato/);
  assert.equal(storage.getItem(DEMO_DISABLED_KEY), null);
});

test("reset demo selettivo: conserva manuali e scontrini reali completi", () => {
  const archive = mixed(); const before = clone(archive); const storage = memoryStorage();
  const plan = planReset(archive, "demo");
  assert.equal(plan.movements, 18); assert.equal(plan.documents, 1); assert.equal(plan.possibleReal, 0);
  const reset = resetArchive(archive, createBackup(archive), "demo", resetConfirmation(plan.movements), storage);
  assert.deepEqual(reset.expenses, [manual, ...receiptArchive(false, "real").expenses]);
  assert.deepEqual(reset.receipts, receiptArchive(false, "real").receipts);
  assert.deepEqual(archive, before);
  assert.doesNotThrow(() => parseBackup(JSON.stringify(createBackup(reset))));
});

test("un documento con provenienze discordanti viene conservato interamente", () => {
  const archive = receiptArchive(true);
  archive.expenses[0].demo = false;
  const plan = planReset(archive, "demo");
  assert.equal(plan.movements, 0); assert.equal(plan.documents, 0);
  assert.equal(plan.remaining, archive.expenses.length);
});

test("reset totale: importi zero, nessun collegamento orfano e categorie/configurazioni intatte", () => {
  const archive = mixed(); const storage = memoryStorage(); const categoriesBefore = clone(categoryDefinitions);
  const before = clone(archive); const backup = createBackup(archive);
  const reset = resetArchive(archive, backup, "all", resetConfirmation(archive.expenses.length), storage);
  assert.deepEqual(reset, { expenses: [], receipts: [] });
  assert.deepEqual(inspectArchive(reset), { movements: 0, demo: 0, possibleReal: 0, documents: 0, products: 0 });
  assert.equal(reset.expenses.reduce((sum, expense) => sum + expense.amount, 0), 0);
  assert.equal(expenseCategories.length, 13); assert.deepEqual(categoryDefinitions, categoriesBefore);
  assert.equal(storage.getItem("settings"), '{"budget":2000}');
  assert.equal(storage.getItem("credentials"), "untouched-test-placeholder");
  assert.equal(storage.data.size, 3);
  assert.deepEqual(archive, before); assert.deepEqual(backup.archive, before);
});

test("ricaricamento dopo reset: nessun ripopolamento delle demo", () => {
  const storage = memoryStorage();
  assert.deepEqual(initialExpenses(storage), demoExpenses);
  const archive = baseline();
  resetArchive(archive, createBackup(archive), "all", "ELIMINA 15 MOVIMENTI", storage);
  assert.deepEqual(initialExpenses(storage), []);
  assert.deepEqual(initialExpenses(storage), []);
});

test("storage non disponibile: reset fallisce prima di cambiare i movimenti", () => {
  const archive = mixed(); const before = clone(archive);
  for (const storage of [
    { getItem() { return null; }, setItem() { throw new Error("Quota superata"); } },
    { getItem() { return null; }, setItem() {} },
  ]) {
    assert.throws(() => resetArchive(archive, createBackup(archive), "all", resetConfirmation(archive.expenses.length), storage));
    assert.deepEqual(archive, before);
  }
});

test("ripristino completo dopo reset, ripetibile senza duplicati e senza riattivare il seed", () => {
  const archive = mixed(); const backup = parseBackup(JSON.stringify(createBackup(archive))); const storage = memoryStorage();
  const reset = resetArchive(archive, backup, "all", resetConfirmation(archive.expenses.length), storage);
  const restored = restoreBackup(reset, backup);
  assert.deepEqual(restored, archive);
  assert.deepEqual(restoreBackup(restored, backup), archive);
  assert.deepEqual(initialExpenses(storage), []);
});

test("ripristino non sovrascrive movimenti già esistenti, e preserva quelli nuovi", () => {
  const archive = baseline(); const backup = createBackup(archive);
  const withNew = { expenses: [clone(manual)], receipts: [] };
  assert.equal(restoreBackup(withNew, backup).expenses.length, 16);
  archive.expenses[0].amount = 1;
  assert.throws(() => restoreBackup(archive, backup), /dati diversi/);
  assert.equal(archive.expenses[0].amount, 1);
});

test("import rifiuta JSON troncato, versione ignota, duplicati e collegamenti incompleti", () => {
  assert.throws(() => parseBackup('{"application":'));
  const good = createBackup(mixed());
  for (const mutate of [
    (backup) => { backup.version = 99; },
    (backup) => { backup.archive.expenses.push(clone(backup.archive.expenses[0])); },
    (backup) => { backup.archive.receipts[0].Prodotti[0].documentId = "missing"; },
    (backup) => { backup.archive.expenses.pop(); },
    (backup) => { backup.archive.receipts[0].Documenti[0].image = "blob:missing-image"; },
    (backup) => { backup.counts.movements = 0; },
  ]) {
    const invalid = clone(good); mutate(invalid);
    assert.throws(() => parseBackup(JSON.stringify(invalid)));
  }
});
