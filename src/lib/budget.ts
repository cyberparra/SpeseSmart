import { parseCents } from "./receipts/model";

export const BUDGET_KEY = "spesesmart:monthly-budgets:v1";
export const DEFAULT_BUDGET_CENTS = 200000;
function parseBudgets(raw: string | null): Record<string, number> {
  const value: unknown = JSON.parse(raw ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.entries(value).some(([month, cents]) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
      || typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0 || cents > 99999999)) {
    throw new Error("Configurazione budget non valida: i dati salvati sono stati conservati.");
  }
  return value as Record<string, number>;
}
export function monthlyBudget(raw: string | null, month: string) {
  return parseBudgets(raw)[month] ?? DEFAULT_BUDGET_CENTS;
}
export function budgetConfigured(raw: string | null, month: string) {
  return Object.hasOwn(parseBudgets(raw), month);
}
export function saveMonthlyBudget(storage: Pick<Storage, "getItem" | "setItem">, month: string, value: string) {
  const cents = parseCents(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || cents === null || cents < 0) throw new Error("Inserisci un budget da 0 a 999.999,99 €, con al massimo due decimali.");
  const budgets = parseBudgets(storage.getItem(BUDGET_KEY));
  const next = JSON.stringify({ ...budgets, [month]: cents });
  storage.setItem(BUDGET_KEY, next);
  if (storage.getItem(BUDGET_KEY) !== next) throw new Error("Impossibile salvare il budget in questo browser.");
}
