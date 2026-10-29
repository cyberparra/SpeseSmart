"use client";
import { useMemo, useState } from "react";
import type { Archive } from "@/lib/archive";
import { categories, colors } from "@/lib/categories";
import { money } from "@/lib/demo";
import { buildPurchases, emptyPurchaseFilters, filterPurchases, purchaseFilterErrors, purchaseOrigins, type PurchaseFilters } from "@/lib/purchases";
import { Icon } from "./icon";
import type { EditablePurchases, EditablePurchase } from "@/lib/purchase-edit";
import { monthRange } from "@/lib/calendar";

const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
export function PurchaseArchive({ archive, initialCategory = "", initialMonth = "", selectedPurchaseId = "", error, onAdd, readOnly = false, editablePurchases = {}, writesEnabled = false, onEdit, onDelete }: { archive: Pick<Archive, "expenses" | "receipts">; initialCategory?: string; initialMonth?: string; selectedPurchaseId?: string; error: string; onAdd: () => void; readOnly?: boolean; editablePurchases?: EditablePurchases; writesEnabled?: boolean; onEdit?: (purchase: EditablePurchase) => void; onDelete?: (purchase: EditablePurchase) => void }) {
  const [filters, setFilters] = useState<PurchaseFilters>({ ...emptyPurchaseFilters, ...(initialMonth ? monthRange(initialMonth) : {}), category: initialCategory });
  const purchases = useMemo(() => buildPurchases(archive), [archive]);
  const visible = useMemo(() => filterPurchases(purchases, filters), [purchases, filters]);
  const errors = purchaseFilterErrors(filters);
  const patch = (values: Partial<PurchaseFilters>) => setFilters(current => ({ ...current, ...values }));
  if (error) return <section className="panel purchase-empty"><Icon name="info" size={32} /><h2>Archivio non disponibile</h2><p>Ricarica la pagina dopo aver verificato la connessione a Google Sheets.</p></section>;
  if (!purchases.length) return <section className="panel purchase-empty"><span className="purchase-empty-icon"><Icon name="bag" size={32} /></span><h2>Il tuo archivio comincia qui</h2><p>{readOnly ? "Non risultano acquisti registrati. Puoi aggiungerli dall’app locale sul PC." : "Non hai ancora registrato acquisti. Aggiungi la prima spesa: qui ritroverai negozi, prodotti e dettagli, tutti in un unico posto."}</p>{!readOnly && <button className="primary" onClick={onAdd}><Icon name="plus" />Aggiungi la prima spesa</button>}</section>;
  return <section className="purchase-archive" aria-label="Archivio degli acquisti">
    <div className="panel purchase-filters">
      <label className="purchase-search">Cerca negli acquisti<span><Icon name="search" /><input type="search" value={filters.query} placeholder="Negozio, descrizione o prodotto" onChange={e => patch({ query: e.target.value })} /></span></label>
      <details className="purchase-filter-options">
        <summary>Filtra gli acquisti <Icon name="down" size={16} /></summary>
        <div className="purchase-filter-grid">
          <label>Categoria<select value={filters.category} onChange={e => patch({ category: e.target.value })}><option value="">Tutte le categorie</option>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
          <label>Origine<select value={filters.origin} onChange={e => patch({ origin: e.target.value })}><option value="">Tutte le origini</option>{purchaseOrigins.map(origin => <option key={origin}>{origin}</option>)}</select></label>
          <label>Dal<input type="date" value={filters.from} onChange={e => patch({ from: e.target.value })} /></label>
          <label>Al<input type="date" value={filters.to} onChange={e => patch({ to: e.target.value })} /></label>
          <label>Importo minimo (€)<input inputMode="decimal" value={filters.min} placeholder="Nessun minimo" onChange={e => patch({ min: e.target.value })} /></label>
          <label>Importo massimo (€)<input inputMode="decimal" value={filters.max} placeholder="Nessun massimo" onChange={e => patch({ max: e.target.value })} /></label>
        </div>
        <p className="purchase-hint">I filtri selezionano acquisti interi. Gli importi sono totali netti; per trovare i resi puoi usare valori negativi.</p>
      </details>
      <div className="purchase-controls"><label>Ordina per<select value={filters.sort} onChange={e => patch({ sort: e.target.value as PurchaseFilters["sort"] })}><option value="date-desc">Data · più recenti</option><option value="date-asc">Data · meno recenti</option><option value="amount-desc">Importo · decrescente</option><option value="amount-asc">Importo · crescente</option></select></label><button type="button" className="secondary" onClick={() => setFilters({ ...emptyPurchaseFilters })}>Azzera filtri</button></div>
      {errors.length > 0 && <div role="alert" className="error">{errors.map(message => <p key={message}>{message}</p>)}</div>}
      <p role="status" className="purchase-result-count">{visible.length} {visible.length === 1 ? "acquisto" : "acquisti"} su {purchases.length} · Tutti i mesi{filters.category ? ` · ${filters.category}` : ""}{filters.origin ? ` · ${filters.origin}` : ""}</p>
    </div>
    {!visible.length && !errors.length && <div className="panel purchase-empty"><Icon name="search" size={28} /><h2>Nessun acquisto corrisponde</h2><p>Prova una ricerca diversa oppure azzera i filtri.</p><button className="secondary" onClick={() => setFilters({ ...emptyPurchaseFilters })}>Mostra tutti gli acquisti</button></div>}
    <div className="purchase-list">
      {visible.map(purchase => <details className="panel purchase-card" key={purchase.id} open={purchase.id === selectedPurchaseId ? true : undefined}>
        <summary><span className="purchase-card-icon"><Icon name={purchase.origin === "Scontrino" ? "bag" : "wallet"} /></span><span className="purchase-card-title"><strong>{purchase.merchant}</strong><span>{dateLabel(purchase.date)} · {purchase.origin}</span><span className="purchase-category-names">{purchase.subtotals.map(s => s.category).join(" · ")}</span></span><span className="purchase-card-amount"><strong>{money(Math.abs(purchase.totalCents) / 100)}</strong>{purchase.totalCents < 0 && <small>Rettifica · riduce la spesa</small>}<span>Dettagli <Icon name="down" size={15} /></span></span></summary>
        <div className="purchase-details">
          <div className="purchase-edit-action">
            {onEdit && <button type="button" className="secondary" disabled={!writesEnabled || !editablePurchases[purchase.id.slice(9)]} onClick={() => onEdit(editablePurchases[purchase.id.slice(9)])}><Icon name="edit" size={16} />Modifica</button>}
            {onDelete && <button type="button" className="danger-button" disabled={!writesEnabled || !editablePurchases[purchase.id.slice(9)]} onClick={() => onDelete(editablePurchases[purchase.id.slice(9)])}>Elimina</button>}
            {!editablePurchases[purchase.id.slice(9)] ? <p className="purchase-hint">Questo acquisto rimane consultabile. Modifica ed eliminazione richiedono un documento SpeseSmart completo e senza fotografie incorporate.</p> : !writesEnabled && <p className="purchase-hint">Scritture disponibili soltanto nello sviluppo locale autorizzato, senza operazioni pendenti.</p>}
          </div>
          <dl className="purchase-facts"><div><dt>Data</dt><dd>{dateLabel(purchase.date)}</dd></div><div><dt>Negozio / descrizione</dt><dd>{purchase.merchant}</dd></div><div><dt>Totale netto</dt><dd>{money(purchase.totalCents / 100)}</dd></div><div><dt>Origine</dt><dd>{purchase.origin}</dd></div></dl>
          {purchase.descriptions.filter(d => d !== purchase.merchant).map(d => <p key={d}>{d}</p>)}
          <h3>Prodotti</h3>
          {purchase.products.length ? <ul className="purchase-products">{purchase.products.map(product => <li key={product.id}><div><strong>{product.description}</strong><span>{product.quantity === null ? "Quantità non disponibile" : `Quantità: ${product.quantity.toLocaleString("it-IT")}`} · {product.category}</span>{product.originalText && product.originalText !== product.description && <small>Testo originale: {product.originalText}</small>}{product.notes && <small>Note: {product.notes}</small>}</div><div className="purchase-product-price"><strong>{product.amountCents === null ? "Prezzo non disponibile" : money(product.amountCents / 100)}</strong>{product.amountCents !== null && product.amountCents < 0 && <small>Riduzione della spesa</small>}</div></li>)}</ul> : <p className="purchase-hint">Nessun prodotto associato a questa spesa. I dati del movimento sono riportati qui sotto.</p>}
          <h3>Subtotali per categoria</h3><dl className="purchase-subtotals">{purchase.subtotals.map(s => <div key={s.category}><dt><i style={{ background: colors[s.category] }} />{s.category}</dt><dd>{money(s.amountCents / 100)}</dd></div>)}</dl>
          <h3>Note</h3>{purchase.notes.length ? purchase.notes.map(note => <p className="purchase-note" key={note}>{note}</p>) : <p className="purchase-hint">Nessuna nota.</p>}
          <p className="purchase-hint">Il prezzo mostrato è il totale della riga, già comprensivo della quantità.</p>
        </div>
      </details>)}
    </div>
  </section>;
}
