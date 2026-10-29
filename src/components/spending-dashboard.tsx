"use client";
import { useMemo, useState } from "react";
import type { Archive } from "@/lib/archive";
import { dashboardSummary } from "@/lib/dashboard";
import { expenseCents } from "@/lib/spending";
import { monthLabel, shiftMonth } from "@/lib/calendar";
import { money } from "@/lib/demo";
import { colors } from "@/lib/categories";
import { MonthlyBudget, useMonthlyBudget } from "./monthly-budget";
import { ExpenseTrend } from "./expense-trend";

export function SpendingDashboard({ archive, month, today, onMonth, onArchive, onAdd, readOnly = false, personal = false }: {
  archive: Archive; month: string; today: string; onMonth: (month: string) => void;
  onArchive: (category?: string, purchaseId?: string) => void; onAdd: () => void; readOnly?: boolean; personal?: boolean;
}) {
  const budget = useMonthlyBudget(month, personal);
  const { budgetCents, configured, error } = budget;
  const data = useMemo(() => dashboardSummary(archive, month, budgetCents, today), [archive, month, budgetCents, today]);
  const [allCategories, setAllCategories] = useState(false);
  const ranked = [...data.distribution].sort((a, b) => b.value - a.value);
  const categories = allCategories ? data.distribution : ranked.filter(r => r.value !== 0).slice(0, 3);
  const maximum = Math.max(1, ...data.distribution.map(r => Math.abs(r.value)));
  const unclassified = data.unclassified.reduce((n, e) => n + expenseCents(e), 0);
  const signedMoney = (cents: number) => `${cents > 0 ? "+" : ""}${money(cents / 100)}`;
  return <div className="spending-dashboard">
    <div className="dashboard-period"><h2>{monthLabel(month)}</h2><div className="month-navigation">
      <button type="button" className="secondary" aria-label="Mese precedente" disabled={month <= "2000-01"} onClick={() => onMonth(shiftMonth(month, -1))}>‹</button>
      <label><span className="sr-only">Mese visualizzato</span><input type="month" min="2000-01" max="2099-12" value={month} onChange={e => { const value = e.target.value; if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= "2000-01" && value <= "2099-12") onMonth(value); }} /></label>
      <button type="button" className="secondary" aria-label="Mese successivo" disabled={month >= "2099-12"} onClick={() => onMonth(shiftMonth(month, 1))}>›</button>
    </div></div>
    <section className="dashboard-overview" aria-label="Riepilogo mensile">
      <article className="stat-card featured"><div className="stat-label">Spese del mese</div><div className="stat-value">{money(data.totalCents / 100)}</div><p>{data.purchaseCount} acquisti · Al netto di sconti e resi</p></article>
      <div className="dashboard-budget-grid"><MonthlyBudget key={month} month={month} budgetCents={budgetCents} configured={configured} storageError={error} readOnly={readOnly} onSave={"save" in budget ? budget.save : undefined} onRefresh={"refresh" in budget ? budget.refresh : undefined} />
        <article className="stat-card budget-remaining"><div className="budget-card-heading"><div className="stat-label">Budget residuo</div><div className={`stat-value ${data.remainingCents < 0 ? "over-budget" : ""}`}>{budgetCents === null ? "—" : money(data.remainingCents / 100)}</div></div>
          <p>{budgetCents === null ? "Budget non disponibile" : budgetCents === 0 ? "Budget impostato a zero" : data.totalCents < 0 ? "Rettifiche nette: le spese sono negative" : `${data.budgetPercent!.toLocaleString("it-IT", { maximumFractionDigits: 1 })}% utilizzato`}</p>
          {budgetCents !== null && <progress max={100} value={Math.max(0, Math.min(100, data.budgetPercent ?? (data.totalCents > 0 ? 100 : 0)))} aria-label="Budget utilizzato" />}
          {budgetCents !== null && data.remainingCents < 0 && <p>Superato di {money(-data.remainingCents / 100)}</p>}
        </article></div>
      <section className="month-comparison" aria-label="Confronto con il mese precedente">
        <h3>Rispetto a {monthLabel(data.previousMonth)}</h3>
        <div className="comparison-values"><strong className="comparison-amount">{signedMoney(data.differenceCents)}</strong>
          {data.differencePercent !== null && <span className="comparison-percentage">{data.differencePercent > 0 ? "+" : ""}{data.differencePercent.toLocaleString("it-IT", { maximumFractionDigits: 1 })}%</span>}
        </div>
        {data.differencePercent === null && <p className="comparison-explanation">Percentuale non calcolabile: il mese precedente ha un totale nullo o negativo.</p>}
        {data.incomplete && <p className="comparison-note"><strong>Mese in corso</strong><span>Totale parziale, a confronto con l’intero mese precedente.</span></p>}
      </section>
    </section>
    {data.purchaseCount === 0 && <section className="panel dashboard-empty"><h3>Nessun acquisto in questo mese</h3><p>Gli importi sono zero perché non risultano spese confermate nel periodo.</p>{!readOnly && <button className="secondary" onClick={onAdd}>Aggiungi una spesa</button>}</section>}
    <section className="panel dashboard-categories"><div className="dashboard-section-heading"><h2>Dove spendi</h2><button className="text-button" aria-expanded={allCategories} onClick={() => setAllCategories(!allCategories)}>{allCategories ? "Prime tre" : "Tutte le categorie"}</button></div>
      <div className="category-list">{categories.map(({ category, value }) => <button className="category-row" key={category} onClick={() => onArchive(category)}><span className="category-row-heading"><span className="category-name">{category}</span><strong className="category-amount">{money(value)}</strong></span><span className="category-meter" aria-hidden="true"><i style={{ width: `${Math.abs(value) / maximum * 100}%`, background: colors[category] }} /></span>{value < 0 && <small>Riduzione netta della spesa</small>}</button>)}</div>
      {!categories.length && <p>Nessuna spesa classificata nel periodo.</p>}
      {data.unclassified.length > 0 && <button className="secondary unclassified-action" onClick={() => onArchive("Da classificare")}>Da classificare · {money(unclassified / 100)} · Rivedi</button>}
      <p className="dashboard-caption">Importi netti per categoria. Le barre indicano grandezze, non percentuali del totale.</p>
    </section>
    <ExpenseTrend expenses={data.expenses} month={month} />
    <section className="panel dashboard-recent"><div className="dashboard-section-heading"><h2>Acquisti recenti</h2><button className="text-button" onClick={() => onArchive()}>Vedi tutti</button></div>
      {data.recent.map(purchase => <button className="recent-purchase" key={purchase.id} onClick={() => onArchive(undefined, purchase.id)}><span className="recent-purchase-copy"><strong>{purchase.merchant}</strong><small>{new Date(`${purchase.date}T12:00:00`).toLocaleDateString("it-IT")} · {purchase.origin}</small></span><strong className="recent-purchase-amount">{money(purchase.totalCents / 100)}</strong></button>)}
      {!data.recent.length && <p>Nessun acquisto nel mese selezionato.</p>}
      <details className="dashboard-secondary"><summary>Dettagli dei movimenti</summary><p>{data.selected.length} movimenti · Media per movimento {money(data.averageCents / 100)}. Gli acquisti suddivisi per categoria generano più movimenti.</p></details>
    </section>
  </div>;
}
