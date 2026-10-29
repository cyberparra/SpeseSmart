import test from "node:test";
import assert from "node:assert/strict";
import { romeDate, shiftMonth, monthRange } from "../src/lib/calendar.ts";
import { dashboardSummary, archiveReadState } from "../src/lib/dashboard.ts";
import { buildPurchases } from "../src/lib/purchases.ts";
import { monthlySpending } from "../src/lib/spending.ts";
import { budgetConfigured, monthlyBudget, saveMonthlyBudget, BUDGET_KEY } from "../src/lib/budget.ts";
import { createDraft, prepareConfirmation } from "../src/lib/receipts/model.ts";
import { demoReceipt } from "../src/lib/receipts/demo.ts";
import { archiveForView, createBackup, parseBackup } from "../src/lib/archive.ts";

const expense = (id, amount, category = "Alimentari", date = "2026-10-12", extra = {}) => ({ id, merchant: "Negozio", amount, category, date, source: "Manuale", ...extra });
const archive = (expenses = []) => ({ expenses, receipts: [] });

test("dashboard: caricamento, errore iniziale, dati obsoleti e archivio realmente vuoto distinti", () => {
  const empty = archive();
  assert.equal(archiveReadState(false, true, "", empty), "loading");
  assert.equal(archiveReadState(false, false, "rete", empty), "error");
  assert.equal(archiveReadState(true, false, "", empty), "empty");
  assert.equal(archiveReadState(true, false, "rete", empty), "stale");
  assert.equal(archiveReadState(true, false, "", archive([expense("id", 7)])), "ready");
});

test("dashboard: date Europe/Rome, ora legale, cambio anno e febbraio bisestile", () => {
  assert.equal(romeDate(new Date("2026-12-31T23:30:00Z")), "2027-01-01");
  assert.equal(romeDate(new Date("2026-07-10T22:30:00Z")), "2026-07-11");
  assert.equal(shiftMonth("2026-12", 1), "2027-01"); assert.equal(shiftMonth("2027-01", -1), "2026-12");
  assert.equal(monthRange("2024-02").to, "2024-02-29"); assert.equal(monthRange("2025-02").to, "2025-02-28");
  assert.throws(() => shiftMonth("2026-13", 1));
});

test("dashboard: un acquisto manuale suddiviso, importi esatti e stessa selezione dell’Archivio", () => {
  const value = archive([expense("a", 0.1, "Alimentari", undefined, { sheetsDocumentId: "manual" }), expense("b", 0.2, "Trasporti", undefined, { sheetsDocumentId: "manual" })]);
  const summary = dashboardSummary(value, "2026-10", 100, "2026-10-14");
  assert.equal(summary.totalCents, 30); assert.equal(summary.remainingCents, 70); assert.equal(summary.purchaseCount, 1);
  assert.equal(summary.purchaseCount, buildPurchases(value).length); assert.equal(summary.selected.length, 2);
});

test("dashboard: scontrino multicategoria e zero acquisti demo/entrate, anche con legami storici per ID", () => {
  let id = 0; const analysis = structuredClone(demoReceipt);
  const receipt = prepareConfirmation(createDraft(analysis, () => `p-${++id}`), analysis, "", false, () => `r-${++id}`);
  const expenses = receipt.Movimenti.map(m => expense(m.id, m.amountCents / 100, m.category, m.date, { source: "Scontrino" }));
  const value = { expenses: [...expenses, expense("demo", 100, "Alimentari", undefined, { demo: true }), expense("income", 100, "Alimentari", undefined, { type: "income" })], receipts: [receipt] };
  const summary = dashboardSummary(value, analysis.date.slice(0, 7), 100000, analysis.date);
  assert.equal(summary.totalCents, receipt.Documenti[0].totalCents); assert.equal(summary.purchaseCount, 1);
  assert.equal(summary.recent.length, 1);
});

test("dashboard: modifiche/eliminazioni confermate cambiano statistiche, sessione locale indipendente", () => {
  const confirmed = archive([expense("a", 7)]); const local = structuredClone(confirmed);
  local.expenses[0].amount = 999; local.expenses.push(expense("unconfirmed", 100));
  assert.equal(dashboardSummary(confirmed, "2026-10", 10000, "2026-10-14").totalCents, 700);
  const updated = archive([expense("a", 8.5)]); assert.equal(dashboardSummary(updated, "2026-10", 10000, "2026-10-14").totalCents, 850);
  assert.equal(dashboardSummary(archive(), "2026-10", 10000, "2026-10-14").remainingCents, 10000);
});

test("dashboard: confronto con mese precedente di calendario, base zero e mese incompleto", () => {
  const summary = dashboardSummary(archive([expense("a", 10), expense("b", 5, "Alimentari", "2026-08-01")]), "2026-10", 10000, "2026-10-14");
  assert.equal(summary.previousMonth, "2026-09"); assert.equal(summary.previousCents, 0); assert.equal(summary.differencePercent, null); assert.equal(summary.incomplete, true);
  const past = dashboardSummary(archive([expense("b", 5, "Alimentari", "2026-09-01"), expense("c", 10, "Alimentari", "2026-08-01")]), "2026-09", 10000, "2026-10-14");
  assert.equal(past.differencePercent, -50); assert.equal(past.incomplete, false);
});

test("dashboard: sei mesi consecutivi tra anni, rettifiche negative e budget superato/zero", () => {
  const value = archive([expense("a", -7, "Alimentari", "2026-12-10"), expense("b", 20, "Trasporti", "2027-01-05")]);
  const series = monthlySpending(value.expenses, "2027-01"); assert.deepEqual(series.map(s => s.month), ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01"]);
  assert.equal(series[4].totalCents, -700);
  const negative = dashboardSummary(value, "2026-12", 10000, "2027-01-14"); assert.equal(negative.remainingCents, 10700); assert.equal(negative.budgetPercent, -7);
  const exceeded = dashboardSummary(value, "2027-01", 1000, "2027-01-14"); assert.equal(exceeded.remainingCents, -1000); assert.equal(exceeded.budgetPercent, 200);
  assert.equal(dashboardSummary(value, "2027-01", 0, "2027-01-14").budgetPercent, null);
});

test("budget: predefinito non personalizzato distinto da zero, persistenza esistente conservata", () => {
  const values = new Map(); const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(budgetConfigured(null, "2026-10"), false); assert.equal(monthlyBudget(null, "2026-10"), 200000);
  saveMonthlyBudget(storage, "2026-10", "0"); const raw = storage.getItem(BUDGET_KEY);
  assert.equal(budgetConfigured(raw, "2026-10"), true); assert.equal(monthlyBudget(raw, "2026-10"), 0);
  saveMonthlyBudget(storage, "2026-11", "50.25"); assert.equal(monthlyBudget(storage.getItem(BUDGET_KEY), "2026-11"), 5025);
});

test("dashboard: vista compatta senza snapshot, backup completo conserva i dati strutturati", () => {
  const source = { ...archive([expense("id", 7)]), googleSheetsSnapshot: { fixture: "raw structured rows", photo: "data:image/png;base64,dGVzdA==" } };
  const compact = archiveForView(source, true); assert.equal(compact.googleSheetsSnapshot, undefined);
  const full = archiveForView(source); assert.deepEqual(full.expenses, source.expenses); assert.ok(full.googleSheetsSnapshot);
  assert.equal(JSON.stringify(full).includes("data:image"), false);
  assert.deepEqual(parseBackup(JSON.stringify(createBackup(full))).archive, full); assert.ok(source.googleSheetsSnapshot.photo);
});
