import { expenseCategories, isCategory, legacyIncomeCategories, normalizeHistoricalTransaction } from "./categories";
import type { Expense } from "./demo";
import { parseCents, validDate } from "./receipts/model";
import { shiftMonth } from "./calendar";

type HistoricalMovement = {
  category: string; originalCategory?: string; categoryId?: string;
  type?: string; tipo?: string; direction?: string; kind?: string;
};
// Read-only compatibility. Never infer a historical movement's direction from its sign.
export function isHistoricalIncome(movement: HistoricalMovement): boolean {
  const normalize = (value: string | undefined) => value?.trim().toLowerCase();
  const labels: readonly string[] = legacyIncomeCategories.map(normalize) as string[];
  return [movement.category, movement.originalCategory].some((value) => labels.includes(normalize(value) ?? ""))
    || ["salary", "other-income"].includes(normalize(movement.categoryId) ?? "")
    || [movement.type, movement.tipo, movement.direction, movement.kind]
      .some((value) => ["income", "entrata", "entrate", "in"].includes(normalize(value) ?? ""));
}

export function spendingMovements(movements: Expense[]) {
  return movements.filter((movement) => !isHistoricalIncome(movement)).map(normalizeHistoricalTransaction);
}

// Native convention is unchanged: positive expenses, negative expense adjustments.
// Round each EUR amount to cents before aggregating; do not apply abs() to totals.
export function expenseCents(movement: Pick<Expense, "amount">) {
  return Math.round(movement.amount * 100);
}
export function spendingSummary(movements: Expense[], month: string, budgetCents: number) {
  const selected = spendingMovements(movements).filter((movement) => movement.date.startsWith(`${month}-`))
    .sort((a, b) => b.date.localeCompare(a.date));
  const totalCents = selected.reduce((sum, movement) => sum + expenseCents(movement), 0);
  const distribution = expenseCategories.map(({ name: category }) => ({
    category, value: selected.filter((movement) => movement.category === category)
      .reduce((sum, movement) => sum + expenseCents(movement), 0) / 100,
  }));
  const unclassified = selected.filter((movement) => movement.category === "Da classificare");
  return { selected, totalCents, remainingCents: budgetCents - totalCents,
    averageCents: selected.length ? totalCents / selected.length : 0, distribution, unclassified };
}

export function monthlySpending(movements: Expense[], throughMonth: string) {
  const totals = new Map<string, number>();
  for (const movement of spendingMovements(movements)) {
    const month = movement.date.slice(0, 7);
    if (month <= throughMonth) totals.set(month, (totals.get(month) ?? 0) + expenseCents(movement));
  }
  return Array.from({ length: 6 }, (_, index) => {
    const month = shiftMonth(throughMonth, index - 5);
    return { month, totalCents: totals.get(month) ?? 0 };
  });
}

export function prepareManualExpenses(input: {
  description: string; date: string; notes: string;
  items: { category: string; amount: string }[]; source: "Manuale" | "Screenshot demo";
}, id: () => string): Expense[] {
  let dateValid = false;
  try { dateValid = validDate(input.date); } catch { /* Invalid calendar date. */ }
  if (!dateValid || !input.description.trim() || input.description.trim().length > 100 || input.notes.length > 1000 || !input.items.length) {
    throw new Error("Controlla data, descrizione e note della spesa.");
  }
  return input.items.map((item) => {
    const amountCents = parseCents(item.amount);
    if (!isCategory(item.category) || amountCents === null || amountCents <= 0) {
      throw new Error("Scegli una categoria di spesa e un importo positivo con al massimo due decimali.");
    }
    return { id: id(), merchant: input.description.trim(), date: input.date, notes: input.notes.trim(),
      category: item.category, amount: amountCents / 100, source: input.source,
      type: "expense", demo: input.source === "Screenshot demo" };
  });
}
