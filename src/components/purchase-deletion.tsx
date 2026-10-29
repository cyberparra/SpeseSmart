"use client";
import { useEffect, useRef, useState } from "react";
import type { EditablePurchase } from "@/lib/purchase-edit";
import type { DeleteRequest } from "@/lib/purchase-delete";
import { money } from "@/lib/demo";

export function PurchaseDeletion({ editable, recovery, onDelete, onClose }: { editable: EditablePurchase; recovery?: DeleteRequest; onDelete: (request: DeleteRequest) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<DeleteRequest | null>(recovery ?? null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(Boolean(recovery));
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const totalCents = Object.values(editable.originalAmounts).reduce((sum, value) => sum + value, 0);
  async function submit() {
    if (submitting.current || blocked) return;
    submitting.current = true; setBusy(true); setError(""); setAttempted(true);
    request.current ??= { documentId: editable.documentId, operationId: crypto.randomUUID(), expectedVersion: editable.version, confirmed: true };
    try { await onDelete(request.current); onClose(); }
    catch (caught) {
      const code = caught && typeof caught === "object" && "code" in caught ? String(caught.code) : "";
      if (["EDIT_CONFLICT", "UPDATE_CONFLICT", "NOT_EDITABLE", "WRITES_DISABLED", "EDIT_TOO_LARGE", "SETUP_REQUIRED", "INVALID"].includes(code)) setBlocked(true);
      setError(caught instanceof Error ? caught.message : "Esito non verificabile. Riprendi lo stesso tentativo: il successo non è confermato.");
    } finally { submitting.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="expense-dialog purchase-deletion" aria-labelledby="purchase-deletion-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-heading"><h2 id="purchase-deletion-title">Elimina spesa</h2></div>
    <p>Controlla l’acquisto prima di confermare. Sarà escluso dall’Archivio, dalla dashboard e dalle statistiche.</p>
    <dl className="purchase-facts deletion-summary"><div><dt>Negozio / descrizione</dt><dd>{editable.draft.merchant}</dd></div><div><dt>Data</dt><dd>{new Date(`${editable.draft.date}T12:00:00`).toLocaleDateString("it-IT")}</dd></div><div><dt>Importo totale</dt><dd>{money(totalCents / 100)}</dd></div><div><dt>Tipo di acquisto</dt><dd>{editable.kind === "manual" ? "Spesa manuale" : "Scontrino"}</dd></div></dl>
    <p className="receipt-warning">L’eliminazione riguarda tutto l’acquisto{editable.kind === "receipt" ? ", inclusi documento, prodotti e movimenti di tutte le categorie" : " e tutte le sue voci"}. Prima viene verificato un backup privato. I record restano marcati come eliminati per consentire un recupero controllato; non vengono rimossi fisicamente dal foglio.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {attempted && !busy && !blocked && <p role="status">Il tentativo è conservato. Riprendilo con lo stesso identificativo, anche dopo il riavvio. Chiudere questa finestra non annulla un’operazione già inviata.</p>}
    {blocked && <p>Operazione bloccata. Ricarica l’archivio; se esiste un recupero pendente, verifica il foglio prima di procedere.</p>}
    <div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>{attempted ? "Chiudi" : "Annulla"}</button><button type="button" className="danger-button" disabled={busy || blocked} onClick={() => void submit()}>{busy ? "Verifica dell’eliminazione…" : attempted ? "Riprendi eliminazione" : "Elimina definitivamente"}</button></div>
  </dialog>;
}
