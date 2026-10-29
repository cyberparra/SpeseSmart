import test from "node:test";
import assert from "node:assert/strict";
import {
  categories, categoryDefinitions, expenseCategories, normalizeHistoricalTransaction, categoryIds, categoriesSheetRows,
  isCategory, resolveAIClassification, classificationInstructions,
  colors, categoryIcon,
} from "../src/lib/categories.ts";
import { demoExpenses } from "../src/lib/demo.ts";
import { isHistoricalIncome, spendingMovements, spendingSummary } from "../src/lib/spending.ts";

const official = [
  "Alimentari", "Casa e Pulizia", "Salute e Benessere", "Trasporti",
  "Cura della Persona", "Tempo Libero e Socialità", "Hobby e Intrattenimento",
  "Shopping e Abbigliamento", "Utenze e Abbonamenti digitali", "Viaggi e Vacanze",
  "Regali e Donazioni", "Animali", "Manutenzioni Ristrutturazioni",
];
test("categorie ufficiali e speciali nell’ordine richiesto", () => {
  assert.deepEqual(expenseCategories.map((c) => c.name), official);
  assert.deepEqual(categories, [...official, "Da classificare"]);
  assert.equal(new Set(categories).size, 14);
  for (const c of categoryDefinitions) {
    assert.ok(c.description);
    assert.ok(colors[c.name]);
    assert.ok(categoryIcon[c.name]);
    assert.ok(classificationInstructions.includes(`${c.name}: ${c.description}`));
  }
});
test("storico intatto: compatibilità conserva tutti i dati economici senza categorie obsolete", () => {
  assert.deepEqual(demoExpenses.map((e) => e.category), [
    "Alimentari", "Shopping", "Svago", "Trasporti", "Svago", "Casa", "Alimentari",
    "Salute", "Shopping", "Trasporti", "Alimentari", "Casa", "Alimentari", "Shopping", "Trasporti",
  ]);
  const before = structuredClone(demoExpenses);
  const normalized = demoExpenses.map(normalizeHistoricalTransaction);
  assert.deepEqual(demoExpenses, before);
  assert.equal(normalized.length, demoExpenses.length);
  for (let i = 0; i < normalized.length; i++) {
    const { category, originalCategory, needsCategoryReview, ...rest } = normalized[i];
    const originalFields = { ...demoExpenses[i] };
    delete originalFields.category;
    assert.deepEqual(rest, originalFields);
    assert.equal(originalCategory, demoExpenses[i].category);
    assert.equal(isCategory(category), true);
    assert.equal(needsCategoryReview, category === "Da classificare");
  }
  assert.equal(normalized.reduce((sum, e) => sum + e.amount, 0).toFixed(2), "2608.28");
  assert.deepEqual(normalized.filter((e) => e.needsCategoryReview).map((e) => e.id), ["6", "12"]);
  for (const old of ["Shopping", "Casa", "Svago", "Salute"]) {
    assert.equal(isCategory(old), false);
    assert.equal(colors[old], undefined);
    assert.equal(categoryIcon[old], undefined);
    assert.equal(normalized.some((e) => e.category === old), false);
  }
  assert.equal(demoExpenses.reduce((sum, e) => sum + e.amount, 0).toFixed(2), "2608.28");
});
test("AI accetta ogni categoria di spesa attendibile", () => {
  for (const category of official) assert.equal(resolveAIClassification(category, 0.95), category);
});
test("AI lascia da classificare risultati ambigui, vecchi o non validi", () => {
  for (const category of [undefined, null, "Shopping", "Casa", "Amazon", "Stipendio", "Altre entrate"]) {
    assert.equal(resolveAIClassification(category, 0.99), "Da classificare");
  }
  for (const confidence of [NaN, Infinity, -1, 0, 0.79, 1.1]) {
    assert.equal(resolveAIClassification("Alimentari", confidence), "Da classificare");
  }
  assert.equal(resolveAIClassification("Alimentari", 0.8), "Alimentari");
});
test("categorie storiche escluse da selezione, classificatore e configurazione attiva", () => {
  for (const category of ["Stipendio", "Altre entrate"]) {
    assert.equal(isCategory(category), false);
    assert.equal(resolveAIClassification(category, 1), "Da classificare");
    assert.equal(isHistoricalIncome({ category }), true);
    assert.equal(classificationInstructions.includes(category), false);
  }
  for (const category of [...official, "Da classificare", "Casa"]) assert.equal(isHistoricalIncome({ category }), false);
});

test("identificativi stabili, ordine 1–13 e raccolta per la scheda Categorie", () => {
  assert.deepEqual(expenseCategories.map((c) => c.order), Array.from({ length: 13 }, (_, index) => index + 1));
  assert.equal(new Set(categoryDefinitions.map((c) => c.id)).size, 14);
  assert.equal(categoryIds.Animali, "pets");
  assert.equal(categoriesSheetRows.length, 14);
  assert.deepEqual(categoriesSheetRows[11], { id: "pets", ordine: 12, nome: "Animali", descrizione: categoryDefinitions[11].description, tipo: "expense" });
});
test("mapping contestuale delle categorie storiche senza riclassificazione indiscriminata", () => {
  const cases = [
    ["Shopping", "Zara", "Shopping e Abbigliamento"],
    ["Salute", "Farmacia Centrale", "Salute e Benessere"],
    ["Svago", "Pizzeria da Michele", "Tempo Libero e Socialità"],
    ["Svago", "Spotify", "Utenze e Abbonamenti digitali"],
    ["Svago", "Cinema", "Hobby e Intrattenimento"],
    ["Svago", "Acquisto generico", "Da classificare"],
    ["Casa", "Affitto", "Da classificare"],
    ["Casa", "Detersivo", "Casa e Pulizia"],
    ["Casa", "Crocchette per cani", "Animali"],
    ["Casa", "Pizzeria e detersivo", "Da classificare"],
    ["Categoria sconosciuta", "Altro", "Da classificare"],
  ];
  for (const [category, merchant, expected] of cases) assert.equal(normalizeHistoricalTransaction({ category, merchant }).category, expected);
  assert.equal(normalizeHistoricalTransaction({ category: "Casa", merchant: "Negozio", description: "lettiera per gatti" }).category, "Animali");
});
test("normalizzazione idempotente e correzione manuale rispettata", () => {
  const legacy = { id: "old", category: "Casa", merchant: "Affitto", amount: 650 };
  const normalized = normalizeHistoricalTransaction(legacy);
  assert.deepEqual(normalizeHistoricalTransaction(normalized), normalized);
  const corrected = normalizeHistoricalTransaction({ ...normalized, category: "Casa e Pulizia" });
  assert.equal(corrected.originalCategory, "Casa");
  assert.equal(corrected.needsCategoryReview, false);
  assert.equal(corrected.amount, 650);
});
test("entrate separate anche dopo la normalizzazione dello storico", () => {
  for (const category of ["Stipendio", "Altre entrate"]) {
    const movement = normalizeHistoricalTransaction({ category, merchant: "Entrata", amount: 1000 });
    assert.equal(movement.originalCategory, category);
    assert.equal(isHistoricalIncome(movement), true);
    assert.deepEqual(spendingMovements([movement]), []);
  }
});

test("rinomina: stesso ID, alias storici leggibili e totali aggregati senza mutare gli originali", () => {
  const current = "Utenze e Abbonamenti digitali";
  assert.equal(categoryIds[current], "digital-subscriptions");
  assert.equal(categoryIds["Manutenzioni Ristrutturazioni"], "maintenance-renovations");
  const expenses = ["Abbonamenti Digitali", "Abbonamenti digitali", current, "Manutenzioni Ristrutturazioni"]
    .map((category, i) => ({ id: String(i), merchant: "Fixture", date: "2026-10-21", category, amount: 10, source: "Manuale" }));
  const before = structuredClone(expenses);
  const summary = spendingSummary(expenses, "2026-10", 10000);
  assert.equal(summary.totalCents, 4000);
  assert.equal(summary.distribution.find(c => c.category === current).value, 30);
  assert.equal(summary.distribution.find(c => c.category === "Manutenzioni Ristrutturazioni").value, 10);
  assert.equal(summary.unclassified.length, 0);
  assert.deepEqual(expenses, before);
  for (const category of ["Abbonamenti Digitali", "Abbonamenti digitali"]) {
    assert.equal(isCategory(category), false);
    assert.equal(normalizeHistoricalTransaction({ category }).originalCategory, category);
  }
});
