import test from "node:test";
import assert from "node:assert/strict";
import { categories, expenseCategories } from "../src/lib/categories.ts";
import { demoExpenses } from "../src/lib/demo.ts";
import { isHistoricalIncome, prepareManualExpenses, spendingMovements, spendingSummary, monthlySpending } from "../src/lib/spending.ts";
import { BUDGET_KEY, DEFAULT_BUDGET_CENTS, monthlyBudget, saveMonthlyBudget } from "../src/lib/budget.ts";
import { createBackup, parseBackup, restoreBackup, resetArchive, planReset, resetConfirmation, initialExpenses } from "../src/lib/archive.ts";
import { demoReceipt } from "../src/lib/receipts/demo.ts";
import { createDraft, prepareConfirmation, reconcile, validateAnalysis } from "../src/lib/receipts/model.ts";

const clone = value => structuredClone(value);
const expense = { id: "expense", merchant: "Spesa", date: "2026-10-11", category: "Alimentari", amount: 45.9, source: "Manuale" };
const historical = [
  { ...expense, id: "salary", category: "Stipendio", amount: 2200, notes: "Da conservare" },
  { ...expense, id: "other", category: "Altre entrate", amount: 100 },
  { ...expense, id: "typed", tipo: "Entrata", amount: 300, custom: { original: true } },
];
function storage() {
  const data = new Map([["unrelated", "untouched"]]);
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}
function manual(patch = {}) {
  return { description: "  Acquisto  ", date: "2026-10-11", notes: "  Nota  ", source: "Manuale", items: [{ category: "Alimentari", amount: "45,90" }], ...patch };
}

test("manuale: tutte le 13 categorie, importo positivo esatto, data, descrizione e note", () => {
  for (const category of expenseCategories) {
    const [saved] = prepareManualExpenses(manual({ items: [{ category: category.name, amount: "45,90" }] }), () => "new");
    assert.deepEqual(saved, { id: "new", merchant: "Acquisto", date: "2026-10-11", notes: "Nota", category: category.name, amount: 45.9, source: "Manuale", type: "expense", demo: false });
  }
  assert.equal(categories.length, 14);
  assert.equal(prepareManualExpenses(manual({ items: [{ category: "Da classificare", amount: "0.01" }] }), () => "new")[0].amount, 0.01);
});

test("manuale: rifiuta categorie di entrata, valori nulli/negativi, frazioni di centesimo e date impossibili", () => {
  for (const category of ["Stipendio", "Altre entrate", "Inventata"]) {
    assert.throws(() => prepareManualExpenses(manual({ items: [{ category, amount: "10" }] }), () => "new"));
  }
  for (const amount of ["0", "-1", "NaN", "Infinity", "0.001", "1e2", "1000000", ""]) {
    assert.throws(() => prepareManualExpenses(manual({ items: [{ category: "Animali", amount }] }), () => "new"));
  }
  for (const patch of [{ date: "2026-02-30" }, { date: "2026-99-99" }, { description: " " }, { items: [] }]) {
    assert.throws(() => prepareManualExpenses(manual(patch), () => "new"));
  }
});

test("riconoscimento storico tramite categoria, ID e metadati; mai dal solo segno", () => {
  for (const movement of historical) assert.equal(isHistoricalIncome(movement), true);
  for (const marker of [{ originalCategory: "Stipendio" }, { categoryId: "salary" }, { direction: " IN " }, { type: "income" }, { kind: "Entrata" }]) {
    assert.equal(isHistoricalIncome({ ...expense, ...marker }), true);
  }
  assert.equal(isHistoricalIncome({ ...expense, amount: -25 }), false);
  assert.equal(isHistoricalIncome({ ...expense, amount: 2500, merchant: "Stipendio" }), false);
});

test("totale mensile e categorie includono solo spese, con aggregazioni esatte in centesimi", () => {
  const movements = [expense, { ...expense, id: "pets", amount: 23.5, category: "Animali" }, ...historical];
  const before = clone(movements);
  const summary = spendingSummary(movements, "2026-10", 10000);
  assert.equal(summary.totalCents, 6940);
  assert.equal(summary.remainingCents, 3060);
  assert.equal(summary.averageCents, 3470);
  assert.equal(summary.selected.length, 2);
  assert.equal(summary.distribution.length, 13);
  assert.equal(summary.distribution.find(row => row.category === "Alimentari").value, 45.9);
  assert.equal(summary.distribution.find(row => row.category === "Animali").value, 23.5);
  assert.deepEqual(movements, before);
  assert.equal(spendingSummary([{ ...expense, amount: 0.1 }, { ...expense, amount: 0.2 }], "2026-10", 0).totalCents, 30);
});

test("budget residuo negativo quando superato, media per movimento e stato vuoto coerenti", () => {
  assert.equal(spendingSummary([expense], "2026-10", 1000).remainingCents, -3590);
  const empty = spendingSummary(historical, "2026-10", 200000);
  assert.equal(empty.totalCents, 0); assert.equal(empty.averageCents, 0); assert.equal(empty.remainingCents, 200000);
  assert.equal(empty.selected.length, 0); assert.ok(empty.distribution.every(row => row.value === 0));
});

test("rettifiche negative riducono le spese senza invertire i segni storici", () => {
  const movements = [expense, { ...expense, id: "refund", amount: -5.9 }];
  const before = clone(movements);
  const summary = spendingSummary(movements, "2026-10", 10000);
  assert.equal(summary.totalCents, 4000); assert.equal(summary.remainingCents, 6000);
  assert.equal(summary.distribution[0].value, 40);
  assert.deepEqual(movements, before);
  assert.equal(spendingSummary([{ ...expense, amount: -5 }], "2026-10", 0).totalCents, -500);
});

test("Da classificare resta tecnica: spesa inclusa nel totale e visibile separatamente", () => {
  const summary = spendingSummary([{ ...expense, category: "Da classificare" }], "2026-10", 0);
  assert.equal(summary.totalCents, 4590); assert.equal(summary.unclassified.length, 1);
  assert.equal(summary.distribution.length, 13); assert.ok(summary.distribution.every(row => row.value === 0));
});

test("confronto mensile: sei mesi consecutivi, mesi vuoti a zero e nessuna entrata", () => {
  const movements = [expense, { ...expense, date: "2026-08-01", amount: 10 }, { ...expense, date: "2026-11-01", amount: 15 }, ...historical.map(row => ({ ...row, date: "2026-09-01" }))];
  assert.deepEqual(monthlySpending(movements, "2026-10"), ["05", "06", "07", "08", "09", "10"].map(m => ({ month: `2026-${m}`, totalCents: m === "08" ? 1000 : m === "10" ? 4590 : 0 })));
  assert.ok(monthlySpending(historical, "2026-10").every(row => row.totalCents === 0));
});

test("budget mensile persistente, indipendente per mese, zero ammesso e chiavi estranee intatte", () => {
  const store = storage();
  assert.equal(monthlyBudget(null, "2026-10"), DEFAULT_BUDGET_CENTS);
  saveMonthlyBudget(store, "2026-10", "80,50"); saveMonthlyBudget(store, "2026-11", "0");
  assert.equal(monthlyBudget(store.getItem(BUDGET_KEY), "2026-10"), 8050);
  assert.equal(monthlyBudget(store.getItem(BUDGET_KEY), "2026-11"), 0);
  assert.equal(monthlyBudget(store.getItem(BUDGET_KEY), "2026-12"), 200000);
  assert.equal(store.getItem("unrelated"), "untouched");
  for (const value of ["-1", "1.001", "no", "1000000"]) assert.throws(() => saveMonthlyBudget(store, "2026-10", value));
  assert.equal(monthlyBudget(store.getItem(BUDGET_KEY), "2026-10"), 8050);
});

test("budget: configurazione corrotta o storage bloccato non vengono sovrascritti", () => {
  const store = storage(); store.setItem(BUDGET_KEY, "corrupted");
  assert.throws(() => saveMonthlyBudget(store, "2026-10", "10"));
  assert.equal(store.getItem(BUDGET_KEY), "corrupted");
  assert.throws(() => saveMonthlyBudget({ getItem: () => null, setItem: () => { throw new Error("blocked"); } }, "2026-10", "10"));
});

test("vecchio backup versione 1: entrate e metadati recuperabili, nessuna migrazione implicita", () => {
  const archive = { expenses: [expense, ...historical], receipts: [] };
  const old = createBackup(archive);
  old.categories.push({ id: "salary", order: 14, name: "Stipendio", kind: "income" });
  const backup = parseBackup(JSON.stringify(old));
  assert.deepEqual(backup.archive, archive);
  assert.equal(backup.categories.at(-1).name, "Stipendio");
  const restored = restoreBackup({ expenses: [], receipts: [] }, backup);
  assert.deepEqual(restored, archive);
  assert.deepEqual(restoreBackup(restored, backup), archive);
  assert.equal(spendingMovements(restored.expenses).length, 1);
});

test("reset demo e totale delle spese preservano tutte le entrate storiche e il budget", () => {
  const legacyDemo = { ...historical[0], demo: true };
  const archive = { expenses: [...clone(demoExpenses), ...historical, { ...legacyDemo, id: "legacy-demo" }], receipts: [] };
  const backup = createBackup(archive); const before = clone(archive);
  for (const scope of ["demo", "all"]) {
    const store = storage(); saveMonthlyBudget(store, "2026-10", "987,65");
    const plan = planReset(archive, scope);
    assert.equal(plan.movements, 15);
    const reset = resetArchive(archive, backup, scope, resetConfirmation(plan.movements), store);
    assert.deepEqual(reset.expenses, [...historical, { ...legacyDemo, id: "legacy-demo" }]);
    assert.equal(monthlyBudget(store.getItem(BUDGET_KEY), "2026-10"), 98765);
    assert.deepEqual(initialExpenses(store), []);
    assert.deepEqual(parseBackup(JSON.stringify(createBackup(reset))).archive, reset);
  }
  assert.deepEqual(archive, before);
});

test("demo esistenti già esclusivamente spese: quantità e importi invariati", () => {
  assert.equal(demoExpenses.filter(isHistoricalIncome).length, 0);
  assert.equal(spendingMovements(demoExpenses).length, 15);
  assert.equal(spendingSummary(demoExpenses, "2026-10", 200000).totalCents, 114828);
  assert.equal(spendingSummary(demoExpenses, "2026-09", 200000).totalCents, 146000);
});

test("reso AI: rettifica di spesa negativa, quadratura e backup completi", () => {
  const analysis = validateAnalysis({ ...clone(demoReceipt), totalCents: -300, items: [{ ...clone(demoReceipt.items[0]), kind: "refund", description: "Reso pasta", amountCents: -300 }] });
  let counter = 0; const id = () => `refund-${++counter}`;
  const draft = createDraft(analysis, id);
  assert.equal(reconcile(draft).valid, true);
  const receipt = prepareConfirmation(draft, analysis, "", false, id);
  assert.equal(receipt.Movimenti[0].amountCents, -300);
  assert.equal(receipt.Movimenti[0].category, "Alimentari");
  assert.equal(isHistoricalIncome(receipt.Movimenti[0]), false);
  const archive = { receipts: [receipt], expenses: receipt.Movimenti.map(m => ({ ...expense, id: m.id, documentId: m.documentId, category: m.category, amount: m.amountCents / 100 })) };
  assert.deepEqual(parseBackup(JSON.stringify(createBackup(archive))).archive, archive);
  assert.equal(spendingSummary(archive.expenses, draft.date.slice(0, 7), 10000).remainingCents, 10300);
});

test("scontrino misto con reso e cambio a costo zero: non genera entrate", () => {
  const base = clone(demoReceipt.items[0]);
  for (const totalCents of [0, 300]) {
    const analysis = validateAnalysis({ ...clone(demoReceipt), totalCents, items: [{ ...base, amountCents: 300 + totalCents }, { ...base, kind: "refund", amountCents: -300 }] });
    let next = 0; const id = () => `mixed-${++next}`;
    const draft = createDraft(analysis, id);
    assert.equal(reconcile(draft).valid, true);
    const receipt = prepareConfirmation(draft, analysis, "", true, id);
    assert.equal(receipt.Movimenti.reduce((sum, m) => sum + m.amountCents, 0), totalCents);
    assert.ok(receipt.Movimenti.every(m => !isHistoricalIncome(m)));
  }
});

test("resi incoerenti e sconti eccessivi restano bloccati dalla quadratura", () => {
  const analysis = { ...clone(demoReceipt), totalCents: -300, items: [{ ...clone(demoReceipt.items[0]), kind: "refund", amountCents: 300 }] };
  const draft = createDraft(analysis, () => "bad");
  assert.equal(reconcile(draft).valid, false);
  draft.items[0].amountCents = -300; draft.totalCents = -200;
  assert.equal(reconcile(draft).valid, false);
  draft.items[0].kind = "discount"; draft.totalCents = -300;
  assert.equal(reconcile(draft).valid, false);
});
