"use client";

import { useId, useRef, useState } from "react";
import {
  createBackup, inspectArchive, movementOrigin, parseBackup, planReset, resetArchive,
  resetConfirmation, restoreBackup, sameArchive,
  type Archive, type ArchiveBackup, type ResetScope,
} from "@/lib/archive";
import { money } from "@/lib/demo";
import { isHistoricalIncome } from "@/lib/spending";
import { categories, isCategory, type Category } from "@/lib/categories";

export function ArchiveTools({ archive, onReset, onRestore, onReclassify }: {
  archive: Archive;
  onReset: (archive: Archive) => void;
  onRestore: (archive: Archive) => void;
  onReclassify?: (id: string, category: Category) => void;
}) {
  const [backup, setBackup] = useState<ArchiveBackup | null>(null);
  const [saved, setSaved] = useState(false);
  const [scope, setScope] = useState<ResetScope>("demo");
  const [reviewing, setReviewing] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [incoming, setIncoming] = useState<ArchiveBackup | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const confirmationId = useId();
  const counts = inspectArchive(archive);
  const legacyCount = archive.expenses.filter(isHistoricalIncome).length;
  const plan = planReset(archive, scope);
  const currentBackup = backup !== null && sameArchive(backup.archive, archive);
  const requiredConfirmation = resetConfirmation(plan.movements);
  const canReset = currentBackup && saved && confirmation === requiredConfirmation;

  function exportBackup() {
    setError(""); setMessage("");
    try {
      const next = createBackup(archive);
      const json = JSON.stringify(next, null, 2);
      parseBackup(json);
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `spesesmart-backup-${next.exportedAt.replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(link);
      link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setBackup(next); setSaved(false); setConfirmation(""); setReviewing(false);
      setMessage(`Download avviato: ${counts.movements} movimenti, ${counts.documents} documenti e ${counts.products} prodotti. Verifica che il file sia stato salvato.`);
    } catch {
      setError("Impossibile preparare un backup completo e valido. Nessun dato è stato eliminato.");
    }
  }

  async function readBackup(file: File | undefined) {
    setIncoming(null); setError(""); setMessage("");
    if (!file) return;
    try { setIncoming(parseBackup(await file.text())); }
    catch { setError("File non valido: scegli un backup JSON completo di SpeseSmart, versione 1. Nessun dato è stato modificato."); }
  }

  return <section className="panel archive-tools" aria-labelledby="archive-title">
    <h2 id="archive-title">Archivio · Backup e reset</h2>
    <p>Tutti i mesi: <strong>{counts.movements} movimenti</strong> · {counts.demo} demo certe · {counts.possibleReal} potenzialmente reali · {counts.documents} documenti · {counts.products} prodotti.</p>
    {legacyCount > 0 && <p role="status" className="legacy-notice"><strong>{legacyCount} record storici esclusi dalle spese.</strong> Sono conservati integralmente nel backup e nel ripristino. I reset delle spese li lasciano intatti; un’eventuale eliminazione richiede una procedura separata e la tua autorizzazione.</p>}
    <p>Il backup esporta la vista corrente e i dati strutturati letti da Google Sheets, escludendo le fotografie anche dagli snapshot. Esportalo prima di ricaricare per conservare modifiche locali e importazioni. Le bozze non confermate sono escluse.</p>
    <details>
      <summary>Verifica provenienza e movimenti</summary>
      <p>Sono demo i 15 esempi originali, gli scontrini marcati demo e le estrazioni simulate da screenshot. Gli altri movimenti richiedono la tua verifica: descrizione, negozio o importo non dimostrano che siano test.</p>
      <div className="table-scroll"><table>
        <thead><tr><th>Data</th><th>Descrizione</th><th>Importo</th><th>Provenienza</th></tr></thead>
        <tbody>{archive.expenses.filter((expense) => !isHistoricalIncome(expense)).map((expense) => <tr key={expense.id}>
          <td>{expense.date}</td><td>{expense.merchant}<small className="archive-id">ID: {expense.id} · {expense.source}</small>
            {expense.category === "Da classificare" && onReclassify && <label>Categoria della sola vista locale<select aria-label={`Categoria locale di ${expense.merchant}`} value={expense.category} onChange={event => { if (isCategory(event.target.value)) onReclassify(expense.id, event.target.value); }}>{categories.map(category => <option key={category}>{category}</option>)}</select></label>}
          </td>
          <td>{money(Math.abs(expense.amount))}{expense.amount < 0 && <small>Rettifica della spesa</small>}</td><td>{movementOrigin(expense, archive.receipts) === "demo" ? "Demo certa" : "Potenzialmente reale"}</td>
        </tr>)}</tbody>
      </table></div>
    </details>
    <div className="archive-actions">
      <button className="secondary" onClick={exportBackup}>Esporta backup JSON</button>
      <button className="text-button" onClick={() => importInput.current?.click()}>Importa backup JSON</button>
      <input ref={importInput} type="file" hidden accept="application/json,.json" onChange={(event) => {
        void readBackup(event.target.files?.[0]); event.target.value = "";
      }} />
    </div>
    {backup && <label className="archive-check">
      <input type="checkbox" checked={saved && currentBackup} disabled={!currentBackup} onChange={(event) => setSaved(event.target.checked)} />
      Ho verificato che il backup JSON sia stato salvato e contenga i miei dati.
    </label>}
    {backup && !currentBackup && <p role="status">L’archivio è cambiato: esporta un nuovo backup per abilitare il reset.</p>}
    <label className="archive-scope">Movimenti da eliminare
      <select value={scope} onChange={(event) => { setScope(event.target.value as ResetScope); setReviewing(false); setConfirmation(""); }}>
        <option value="demo">Solo spese demo certe (conserva i potenzialmente reali)</option>
        <option value="all">Tutte le spese, anche potenzialmente reali</option>
      </select>
    </label>
    <p>Il reset agisce soltanto sulla vista di questa sessione: non cancella celle o movimenti su Google Sheets. Al ricaricamento i dati remoti vengono letti nuovamente. Configurazioni, categorie e preferenza anti-demo restano conservate. Il ripristino JSON non scrive sul foglio.</p>
    <button className="secondary" disabled={!currentBackup || !saved || (plan.movements === 0 && plan.documents === 0)} onClick={() => { setReviewing(true); setConfirmation(""); setError(""); }}>Prepara reset</button>
    {reviewing && <form className="archive-confirm" onSubmit={(event) => {
      event.preventDefault();
      if (!backup || !canReset) return;
      try {
        const next = resetArchive(archive, backup, scope, confirmation, window.localStorage);
        onReset(next);
        setReviewing(false); setConfirmation(""); setSaved(false); setError("");
        setMessage(`Reset completato: eliminati ${plan.movements} movimenti, ${plan.documents} documenti e ${plan.products} prodotti. Restano ${plan.remaining} movimenti. Conserva il backup per un eventuale ripristino.`);
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Reset non riuscito. Nessun movimento eliminato."); }
    }}>
      <h3>Conferma esplicita del reset</h3>
      <p>Eliminerai <strong>{plan.movements} movimenti</strong> di tutti i mesi, {plan.documents} documenti e {plan.products} prodotti collegati. Di questi movimenti, <strong>{plan.possibleReal} potrebbero essere reali</strong>. Resteranno {plan.remaining} movimenti.</p>
      <p>Le bozze non confermate sono escluse dal backup e dal reset e restano nella sessione. Le categorie ufficiali, Da classificare, i budget, i record storici esclusi, il codice e le credenziali restano intatti.</p>
      <p id={`${confirmationId}-instructions`}>Per confermare digita <strong>{requiredConfirmation}</strong>. Rispetta maiuscole e spazi, senza aggiungere caratteri.</p>
      <div className="archive-confirmation-field">
        <label htmlFor={confirmationId}>Frase di conferma</label>
        <input
          id={confirmationId}
          className="archive-confirmation-input"
          type="text"
          name="reset-confirmation"
          aria-describedby={`${confirmationId}-instructions`}
          placeholder="Scrivi qui la frase richiesta"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </div>
      <div className="archive-actions">
        <button type="button" className="secondary" onClick={() => { setReviewing(false); setConfirmation(""); }}>Annulla</button>
        <button type="submit" className="archive-danger" disabled={!canReset}>Conferma eliminazione</button>
      </div>
    </form>}
    {incoming && <div className="archive-confirm">
      <h3>Ripristina backup</h3>
      <p>Backup del {incoming.exportedAt}: {incoming.counts.movements} movimenti, {incoming.counts.documents} documenti e {incoming.counts.products} prodotti. Il ripristino aggiunge i dati alla sessione; gli identificativi già presenti devono essere identici. Non modifica le configurazioni.</p>
      <div className="archive-actions">
        <button className="secondary" onClick={() => setIncoming(null)}>Annulla importazione</button>
        <button className="primary" onClick={() => {
          try {
            const merged = restoreBackup(archive, incoming);
            onRestore(merged); setIncoming(null); setReviewing(false); setConfirmation(""); setSaved(false); setError("");
            setMessage(`Backup ripristinato nella sessione: ${merged.expenses.length} movimenti totali. I dati importati restano locali e non vengono scritti su Google Sheets: conserva il file JSON.`);
          } catch (caught) { setError(caught instanceof Error ? caught.message : "Ripristino non riuscito."); }
        }}>Conferma ripristino</button>
      </div>
    </div>}
    {message && <p role="status">{message}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
