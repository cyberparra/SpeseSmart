"use client";
import { sessionFetch } from "@/lib/session-fetch";
import { useEffect, useRef, useState } from "react";
import { money } from "@/lib/demo";
import { operationalHeaders } from "@/lib/operational-headers";
import { demoReceipt } from "@/lib/receipts/demo";
import { validateImageFile } from "@/lib/receipts/upload";
import { centsInput, createDraft, parseCents, prepareConfirmation, receiptCategories, reconcile, validateAnalysis, type ConfirmedReceipt, type ReceiptAnalysis, type ReceiptDraft, type ReceiptLine } from "@/lib/receipts/model";

function AmountInput({ value, onChange, label }: { value: number | null; onChange: (value: number | null) => void; label: string }) {
  const [text, setText] = useState(centsInput(value));
  return <label>{label}<input inputMode="decimal" value={text} placeholder="Non disponibile" onChange={(e) => { setText(e.target.value); onChange(parseCents(e.target.value)); }} /></label>;
}
export function ReceiptFlow({ onConfirm, onBack, onBusyChange, lanOperational = false }: { onConfirm: (receipt: ConfirmedReceipt) => void | Promise<void>; onBack: () => void; onBusyChange?: (busy: boolean) => void; lanOperational?: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [analysisImage, setAnalysisImage] = useState("");
  const [analysis, setAnalysis] = useState<ReceiptAnalysis | null>(null);
  const [draft, setDraft] = useState<ReceiptDraft | null>(null);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const [saved, setSaved] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const reading = useRef(0);
  const confirmation = useRef<{ signature: string; receipt: ConfirmedReceipt } | null>(null);
  const confirming = useRef(false);
  const analyzing = useRef(false);
  const [analysisNotice, setAnalysisNotice] = useState("");
  useEffect(() => () => { request.current?.abort(); reading.current++; }, []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  async function selectFile(next: File | undefined) {
    if (!next) return;
    const message = validateImageFile(next);
    if (message) { setError(message); return; }
    const version = ++reading.current;
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      if (version !== reading.current) return;
      setFile(next); setPreview(String(reader.result));
    };
    reader.onerror = () => setError("Impossibile leggere la foto. Scegli un’altra immagine.");
    reader.readAsDataURL(next);
  }
  async function analyze(force = false) {
    if (!file || busy || analyzing.current) return;
    analyzing.current = true; setAnalysisNotice("");
    setBusy(true); setError("");
    const controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 150000);
    try {
      const form = new FormData(); form.append("image", file);
      if (force) form.append("reanalyze", "true");
      const response = await sessionFetch("/api/receipts/analyze", { method: "POST", headers: await operationalHeaders(false, lanOperational), body: form, signal: controller.signal });
      let body;
      try { body = await response.json(); }
      catch { throw new Error("Il server non ha restituito una risposta valida. Riprova più tardi."); }
      if (!response.ok) throw new Error(body.error || "Analisi non disponibile. Riprova.");
      const next = validateAnalysis(body.receipt);
      setAnalysisNotice(body.reusedFromCache ? "Analisi riutilizzata dalla cache privata: nessuna nuova chiamata OpenAI." : "Nuova analisi AI completata e contabilizzata.");
      setAnalysisImage(preview); setAnalysis(next); setDraft(createDraft(next, () => crypto.randomUUID())); setDemo(false); setReview(true); setSaved(false);
    } catch (error) {
      setError(error instanceof TypeError || (error instanceof Error && error.name === "AbortError") ? "Connessione interrotta o analisi scaduta. Le correzioni sono conservate. Nessun nuovo invio automatico: riprova con Analizza scontrino per riusare la cache; un consumo sconosciuto blocca nuove chiamate. Analizza nuovamente avvia invece una nuova chiamata a pagamento." : error instanceof Error ? error.message : "Analisi non disponibile. Le correzioni sono conservate.");
    } finally { clearTimeout(timeout); setBusy(false); analyzing.current = false; }
  }
  function useDemo() {
    setAnalysisNotice("");
    setAnalysis(demoReceipt); setDraft(createDraft(demoReceipt, () => crypto.randomUUID()));
    setDemo(true); setReview(true); setError(""); setSaved(false);
  }
  function patchLine(id: string, patch: Partial<ReceiptLine>) {
    setDraft((current) => current && ({ ...current, items: current.items.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  }
  function addLine(kind: ReceiptLine["kind"]) {
    if (!draft) return;
    setDraft({ ...draft, items: [...draft.items, { id: crypto.randomUUID(), description: "", originalText: null, quantity: null, amountCents: null, kind, category: "Da classificare", confidence: 0, uncertain: false, reason: "" }] });
  }
  const totals = draft ? reconcile(draft) : null;
  if (review && draft && analysis && totals) return (
    <form className="receipt-flow" inert={busy} aria-busy={busy} onInvalidCapture={event => { const details = (event.target as HTMLElement).closest("details"); if (details) details.open = true; }} onSubmit={async (event) => {
      event.preventDefault();
      if (saved || !totals.valid || confirming.current) return;
      confirming.current = true; setBusy(true); setError("");
      try {
        const imageHash = !demo && analysisImage ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(analysisImage)))), byte => byte.toString(16).padStart(2, "0")).join("") : undefined;
        const signature = JSON.stringify({ draft, analysis, imageHash, demo });
        if (confirmation.current && confirmation.current.signature !== signature) throw new Error("Verifica l’esito del precedente invio prima di modificare una conferma già tentata.");
        confirmation.current ??= { signature, receipt: prepareConfirmation(draft, analysis, "", demo, () => crypto.randomUUID(), imageHash) };
        await onConfirm(confirmation.current.receipt); setSaved(true); setFile(null); setPreview(""); setAnalysisImage("");
      }
      catch (error) {
        if (error instanceof Error && "code" in error && ["CSRF", "WRITES_DISABLED", "SETUP_REQUIRED", "INVALID", "DEMO", "QUADRATURA", "TOO_LARGE"].includes(String(error.code))) confirmation.current = null;
        setError(error instanceof Error ? error.message : "Impossibile confermare. Le modifiche sono conservate.");
      }
      finally { confirming.current = false; setBusy(false); }
    }}>
      <h3>Verifica lo scontrino</h3>
      {demo ? <p className="demo-info">SCONTRINO DIMOSTRATIVO — Nessuna immagine caricata è stata analizzata.</p> : <ReceiptImage preview={analysisImage} />}
      {analysis.warnings.map((warning, index) => <p className="receipt-warning" key={index}>{warning}</p>)}
      <p className="dialog-description">Controlla ogni voce. Il prezzo è il totale della riga, non il prezzo unitario. I campi non leggibili restano vuoti.</p>
      <p className="local-note">La fotografia serve solo per analisi e revisione: non viene salvata nell’archivio o nei nuovi backup.</p>
      <div className="form-grid">
        <label>Negozio<input required maxLength={200} value={draft.merchant} onChange={(e) => setDraft({ ...draft, merchant: e.target.value })} /></label>
        <label>Data<input required type="date" min="2000-01-01" max="2099-12-31" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} /></label>
        <AmountInput value={draft.totalCents} label="Totale dichiarato (€)" onChange={(totalCents) => setDraft({ ...draft, totalCents })} />
        <label>Valuta<input required maxLength={3} value={draft.currency} placeholder="Non disponibile" onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} /></label>
      </div>
      {draft.items.map((item, index) => <fieldset className="receipt-line" key={item.id}>
        <legend>Voce {index + 1}{item.uncertain || item.category === "Da classificare" ? " · Da verificare" : ""}</legend>
        <label>Descrizione<input required maxLength={300} value={item.description ?? ""} placeholder="Non disponibile" onChange={(e) => patchLine(item.id, { description: e.target.value })} /></label>
        <div className="receipt-line-main">
          <AmountInput value={item.amountCents} label="Totale riga (€)" onChange={(amountCents) => patchLine(item.id, { amountCents })} />
          <label>Categoria<select value={item.category} onChange={(e) => patchLine(item.id, { category: e.target.value as ReceiptLine["category"] })}>{receiptCategories.map((c) => <option key={c}>{c}</option>)}</select></label>
        </div>
        <details className="product-secondary"><summary>Quantità, tipo e testo originale · {item.kind === "product" ? "Prodotto" : item.kind === "refund" ? "Reso" : item.kind === "discount" ? "Sconto" : item.kind === "adjustment" ? "Rettifica" : "Costo aggiuntivo"}</summary><div className="receipt-line-grid">
          <label>Quantità (facoltativa)<input type="number" min="0.001" step="any" value={item.quantity ?? ""} placeholder="Non disponibile" onChange={e => patchLine(item.id, { quantity: e.target.value === "" ? null : Number(e.target.value) })} /></label>
          <label>Tipo<select value={item.kind} onChange={e => patchLine(item.id, { kind: e.target.value as ReceiptLine["kind"] })}><option value="product">Prodotto</option><option value="discount">Sconto (negativo)</option><option value="refund">Reso (rettifica negativa)</option><option value="extra">Costo aggiuntivo</option><option value="adjustment">Rettifica motivata</option></select></label>
        </div>{item.originalText && <p className="original-text">Testo originale: {item.originalText}</p>}</details>
        {item.kind === "adjustment" && <label>Motivo della rettifica<input required maxLength={500} value={item.reason} placeholder="Spiega l’importo aggiunto o sottratto" onChange={(e) => patchLine(item.id, { reason: e.target.value })} /></label>}
        <button className="text-button" type="button" onClick={() => setDraft({ ...draft, items: draft.items.filter((i) => i.id !== item.id) })}>Elimina voce {index + 1}</button>
      </fieldset>)}
      <div className="receipt-add-actions"><button className="text-button" type="button" onClick={() => addLine("product")}>+ Prodotto</button><button className="text-button" type="button" onClick={() => addLine("discount")}>+ Sconto</button><button className="text-button" type="button" onClick={() => addLine("refund")}>+ Reso</button><button className="text-button" type="button" onClick={() => addLine("extra")}>+ Costo aggiuntivo</button><button className="text-button" type="button" onClick={() => addLine("adjustment")}>+ Rettifica motivata</button></div>
      <div className="receipt-totals" aria-live="polite">
        <h3>Subtotali per categoria</h3>
        {totals.subtotals.map((s) => <p key={s.category}><span>{s.category}</span><strong>{money(s.amountCents / 100)}</strong></p>)}
        <p><span>Totale dichiarato</span><strong>{draft.totalCents === null ? "Non disponibile" : money(draft.totalCents / 100)}</strong></p>
        <p><span>Totale ricostruito</span><strong>{money(totals.reconstructedCents / 100)}</strong></p>
        <p className={totals.differenceCents !== 0 ? "error" : ""}><span>Differenza</span><strong>{totals.differenceCents === null ? "Non disponibile" : money(totals.differenceCents / 100)}</strong></p>
      </div>
      {!totals.valid && <div className="receipt-warning" role="status">{totals.errors.map((message) => <p key={message}>{message}</p>)}</div>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions receipt-confirm-actions"><button type="button" className="secondary" onClick={() => setReview(false)}>Torna alla foto</button><button type="submit" className="primary" disabled={!totals.valid || saved}>Conferma · {money(totals.reconstructedCents / 100)}</button></div>
      {analysisNotice && <p role="status">{analysisNotice}</p>}
      <p className="local-note">La revisione resta disponibile fino alla conferma del salvataggio remoto. In caso di errore conserva la pagina e riprova gli stessi dati.</p>
    </form>
  );
  return <div className="receipt-flow" aria-busy={busy}>
    <p className="dialog-description">Scatta una foto nitida o carica JPG, PNG o WebP, massimo 10 MB. L’analisi invia l’immagine a OpenAI solo quando premi “Analizza scontrino”.</p>
    <input ref={camera} hidden type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e) => { void selectFile(e.target.files?.[0]); e.target.value = ""; }} />
    <input ref={upload} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { void selectFile(e.target.files?.[0]); e.target.value = ""; }} />
    <div className="receipt-add-actions"><button className="secondary" disabled={busy} onClick={() => camera.current?.click()}>Scatta foto</button><button className="secondary" disabled={busy} onClick={() => upload.current?.click()}>{file ? "Sostituisci foto" : "Carica immagine"}</button></div>
    {file && <p>{file.name}</p>}
    <ReceiptImage preview={preview} />
    {draft && <p className="receipt-warning">La revisione precedente è conservata. Una nuova analisi riuscita la sostituirà.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <p role="status">Analisi in corso… Attendi, può richiedere circa un minuto.</p>}
    <div className="dialog-actions"><button className="secondary" disabled={busy} onClick={onBack}>Indietro</button><button className="primary" disabled={!file || busy} onClick={() => void analyze()}>{busy ? "Analisi in corso…" : "Analizza scontrino"}</button></div>
    {file && <><button type="button" className="text-button" disabled={busy} onClick={() => void analyze(true)}>Analizza nuovamente</button><p className="local-note">Avvia una nuova chiamata a pagamento anche se esiste un risultato riutilizzabile. Si applicano i limiti AI mensili.</p></>}
    {draft && <button className="text-button" disabled={busy} onClick={() => setReview(true)}>Riprendi revisione e correzioni</button>}
    <div className="demo-info"><p>Puoi provare uno scontrino dimostrativo anche senza chiave API. La demo usa dati fissi e non analizza la foto caricata.</p><button className="text-button" disabled={busy} onClick={useDemo}>Prova scontrino dimostrativo</button></div>
  </div>;
}
function ReceiptImage({ preview }: { preview: string }) {
  return preview ? <a href={preview} target="_blank" rel="noreferrer" aria-label="Apri immagine originale dello scontrino"><div className="receipt-image" role="img" aria-label="Immagine originale dello scontrino" style={{ backgroundImage: `url("${preview}")` }} /></a> : null;
}
