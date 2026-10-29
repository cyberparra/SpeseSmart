import type { Archive } from "./archive";
import { buildPurchases } from "./purchases";
import { spendingSummary } from "./spending";
import { shiftMonth } from "./calendar";
import { movementOrigin } from "./archive";
import { isHistoricalIncome } from "./spending";

// Dashboard and archive share the exact server-confirmed purchase selection, excluding demos/income.
export function dashboardSummary(archive: Archive, month: string, budgetCents: number | null, today: string) {
  const purchases = buildPurchases(archive);
  const documentIds = new Set(purchases.filter(p => p.id.startsWith("document:")).map(p => p.id.slice(9)));
  const movementIds = new Set(purchases.filter(p => p.id.startsWith("movement:")).map(p => p.id.slice(9)));
  const byMovement = new Map(archive.receipts.flatMap(r => r.Movimenti.map(m => [m.id, r.Documenti[0].id] as const)));
  const expenses = archive.expenses.filter(e => !isHistoricalIncome(e) && movementOrigin(e, archive.receipts) !== "demo" && !/demo|dimostrativ|simulat/i.test(e.source)
    && (movementIds.has(e.id) || documentIds.has(e.documentId || e.sheetsDocumentId || byMovement.get(e.id) || "")));
  const summary = spendingSummary(expenses, month, budgetCents ?? 0);
  const previousMonth = shiftMonth(month, -1);
  const previous = spendingSummary(expenses, previousMonth, 0).totalCents;
  const difference = summary.totalCents - previous;
  return { ...summary, expenses, previousMonth, previousCents: previous, differenceCents: difference,
    differencePercent: previous > 0 ? difference * 100 / previous : null,
    incomplete: month === today.slice(0, 7),
    budgetPercent: budgetCents !== null && budgetCents > 0 ? summary.totalCents * 100 / budgetCents : null,
    recent: purchases.filter(p => p.date.startsWith(`${month}-`)).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)).slice(0, 3),
    purchaseCount: purchases.filter(p => p.date.startsWith(`${month}-`)).length,
  };
}
export type ArchiveReadState = "loading" | "ready" | "empty" | "stale" | "error";
export function archiveReadState(loaded: boolean, loading: boolean, error: string, archive: Archive): ArchiveReadState {
  if (!loaded) return loading ? "loading" : "error";
  if (error) return "stale";
  return buildPurchases(archive).length ? "ready" : "empty";
}
