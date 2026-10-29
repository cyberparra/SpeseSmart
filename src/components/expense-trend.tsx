import type { Expense } from "@/lib/demo";
import { money } from "@/lib/demo";
import { monthlySpending } from "@/lib/spending";

export function ExpenseTrend({ expenses, month }: { expenses: Expense[]; month: string }) {
  const periods = monthlySpending(expenses, month);
  const max = Math.max(0, ...periods.map((period) => Math.abs(period.totalCents)));
  const label = (value: string) => new Date(`${value}-01T12:00:00`).toLocaleDateString("it-IT", { month: "short", year: "2-digit" });
  return <section className="panel trend expense-trend">
    <div className="panel-heading"><div><h2>Andamento delle spese</h2><p>Ultimi sei mesi di calendario. I mesi senza spese sono inclusi.</p></div></div>
    <>
      <div className="signed-chart" role="img" aria-label={`Spese nette mensili: ${periods.map((period) => `${label(period.month)}: ${money(period.totalCents / 100)}`).join("; ")}`}>
        {periods.map(period => <div className="signed-column" key={period.month}><div className="signed-plot"><div className={`signed-bar ${period.totalCents < 0 ? "negative" : "positive"}`} style={{ height: `${Math.abs(period.totalCents) / (max || 1) * 48}%` }} /></div><span>{label(period.month).split(" ").map(part => <span key={part}>{part}</span>)}</span></div>)}
      </div>
      <ul className="trend-summary">{periods.map((period) => <li key={period.month}><span>{label(period.month)}</span><strong>{money(period.totalCents / 100)}</strong></li>)}</ul>
      <p className="chart-caption">Totali al netto di sconti e resi. Il mese in corso può essere incompleto.</p>
    </>
  </section>;
}
