"use client";
import { useEffect, useRef, useState } from "react";
import { categories } from "@/lib/categories";
import { money } from "@/lib/demo";
import { parseCents } from "@/lib/receipts/model";
import { editDraftErrors, type EditDraft, type EditablePurchase, type EditRequest } from "@/lib/purchase-edit";

export function PurchaseEditor({ editable, recovery, onSave, onClose }: { editable: EditablePurchase; recovery?: EditRequest; onSave: (request: EditRequest) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<EditDraft>(() => structuredClone(recovery?.draft ?? editable.draft));
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(Boolean(recovery));
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const request = useRef<EditRequest | null>(recovery ?? null);
  const submitting = useRef(false);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const errors = editDraftErrors(draft, editable);
  const totalCents = draft.items.reduce((sum, item) => sum + (parseCents(item.amount) ?? 0), 0);
  const subtotals = categories.map(category => ({ category, amount: draft.items.filter(i => i.category === category).reduce((sum, i) => sum + (parseCents(i.amount) ?? 0), 0) })).filter(s => draft.items.some(i => i.category === s.category));
  const patchItem = (id: string, value: Partial<EditDraft["items"][number]>) => setDraft(current => ({ ...current, items: current.items.map(i => i.id === id ? { ...i, ...value } : i) }));
  return <dialog ref={dialog} className="expense-dialog purchase-editor" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="purchase-editor-title">
    <div className="dialog-heading"><h2 id="purchase-editor-title">Modifica {editable.kind === "manual" ? "spesa manuale" : "scontrino"}</h2><button type="button" className="text-button" disabled={busy} onClick={onClose} aria-label="Chiudi modifica">×</button></div>
    <p className="dialog-description">Controlla i dati e conferma la modifica. Il totale viene ricostruito dalle righe; per gli scontrini il prezzo è già comprensivo della quantità.</p>
    <form onSubmit={async event => {
      event.preventDefault(); if (submitting.current || errors.length || conflict) return;
      submitting.current = true; setBusy(true); setError(""); setLocked(true);
      request.current ??= { documentId: editable.documentId, expectedVersion: editable.version, operationId: crypto.randomUUID(), draft: structuredClone(draft) };
      try { await onSave(request.current); onClose(); }
      catch (caught) {
        const code = caught && typeof caught === "object" && "code" in caught ? String(caught.code) : "";
        if (["INVALID", "QUADRATURA", "WRITES_DISABLED", "SETUP_REQUIRED", "EDIT_TOO_LARGE", "NOT_EDITABLE"].includes(code)) { request.current = null; setLocked(false); }
        if (["EDIT_CONFLICT", "UPDATE_CONFLICT"].includes(code)) setConflict(true);
        setError(caught instanceof Error ? caught.message : "Salvataggio non verificabile. Riprendi lo stesso invio senza cambiare i dati.");
      } finally { submitting.current = false; setBusy(false); }
    }}>
      <fieldset disabled={busy || locked} className="purchase-edit-fields">
        <div className="form-grid"><label>{editable.kind === "manual" ? "Descrizione acquisto" : "Negozio"}<input required maxLength={100} value={draft.merchant} onChange={e => setDraft({ ...draft, merchant: e.target.value })} /></label><label>Data<input type="date" required min="2000-01-01" max="2099-12-31" value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })} /></label></div>
        {draft.items.map((item, index) => <fieldset className="receipt-line" key={item.id}><legend>{editable.kind === "manual" ? "Voce" : "Prodotto"} {index + 1}</legend><label>Descrizione<input required maxLength={300} value={item.description} onChange={e => patchItem(item.id, { description: e.target.value })} /></label><div className="receipt-line-grid">
          {editable.kind === "receipt" && <label>Quantità (facoltativa)<input type="number" min="0.001" max="1000000" step="any" value={item.quantity ?? ""} onChange={e => patchItem(item.id, { quantity: e.target.value === "" ? null : Number(e.target.value) })} /></label>}
          <label>Importo della riga (€)<input inputMode="decimal" required value={item.amount} onChange={e => patchItem(item.id, { amount: e.target.value })} /></label>
          <label>Categoria<select value={item.category} onChange={e => patchItem(item.id, { category: e.target.value })}>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
        </div>{editable.kind === "receipt" && <label>Note / motivo della correzione del prezzo<input maxLength={1000} value={item.reason} required={parseCents(item.amount) !== editable.originalAmounts[item.id] || editable.lineKinds[item.id] === "adjustment"} onChange={e => patchItem(item.id, { reason: e.target.value })} /></label>}</fieldset>)}
        <label>Note dell’acquisto<textarea maxLength={1000} rows={3} value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} /></label>
      </fieldset>
      <div className="receipt-totals" aria-live="polite"><h3>Riepilogo della modifica</h3>{subtotals.map(s => <p key={s.category}><span>{s.category}</span><strong>{money(s.amount / 100)}</strong></p>)}<p><span>Totale prima della modifica</span><strong>{money(Object.values(editable.originalAmounts).reduce((sum, amount) => sum + amount, 0) / 100)}</strong></p><p><span>Totale ricostruito</span><strong>{money(totalCents / 100)}</strong></p></div>
      {errors.length > 0 && <div role="status" className="receipt-warning">{errors.map(message => <p key={message}>{message}</p>)}</div>}
      {error && <p className="error" role="alert">{error}</p>}
      {locked && !busy && !conflict && <p className="receipt-warning">I dati del tentativo sono conservati. Puoi riprendere lo stesso salvataggio; un’operazione incompleta rimane recuperabile anche dopo il ricaricamento.</p>}
      {conflict && <p className="receipt-warning">Il recupero richiede la verifica dei dati sul foglio. Le modifiche non vengono sovrascritte automaticamente.</p>}
      <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>{locked ? "Chiudi" : "Annulla"}</button><button className="primary" type="submit" disabled={busy || errors.length > 0 || conflict}>{busy ? "Verifica del salvataggio…" : locked ? "Riprendi salvataggio" : "Conferma modifica"}</button></div>
    </form>
  </dialog>;
}
