"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { romeDate } from "@/lib/calendar";
import { archiveReadState } from "@/lib/dashboard";
import { SpendingDashboard } from "@/components/spending-dashboard";
import Link from "next/link";
import { sessionFetch } from "@/lib/session-fetch";
import { AccountControls, useAccount } from "@/components/account-session";
import { PasswordChange } from "@/components/password-change";
import { CategorySettings } from "@/components/category-settings";
import { operationalHeaders } from "@/lib/operational-headers";
import { readConfirmedArchive } from "@/lib/archive-read";
const ReceiptFlow = dynamic(() => import("@/components/receipt-flow").then(module => module.ReceiptFlow));
const AIConsumption = dynamic(() => import("@/components/ai-consumption").then(module => module.AIConsumption));
const ArchiveTools = dynamic(() => import("@/components/archive-tools").then(module => module.ArchiveTools));
import { PurchaseArchive } from "@/components/purchase-archive";
import { PurchaseEditor } from "@/components/purchase-editor";
import { PurchaseDeletion } from "@/components/purchase-deletion";
import type { DeleteRequest, PendingPurchaseDeletion } from "@/lib/purchase-delete";
import type { EditablePurchases, EditablePurchase, EditRequest } from "@/lib/purchase-edit";
import type { PendingPurchaseEdit } from "@/lib/sheets-updates";


import { type Archive, createBackup, parseBackup } from "@/lib/archive";
import { parseCents, type ConfirmedReceipt } from "@/lib/receipts/model";
import { prepareManualExpenses } from "@/lib/spending";
import { Icon } from "@/components/icon";
import { money, type Expense } from "@/lib/demo";
import {
  categories, resolveAIClassification, type Category,
} from "@/lib/categories";

type Mode = "Scontrino" | "Screenshot" | "Manuale";
type Item = { id: number; category: Category; amount: string };
const dateSubscribe = (notify: () => void) => { window.addEventListener("focus", notify); return () => window.removeEventListener("focus", notify); };
type ArchiveResponse = { archive: Archive; persistedIds: string[]; editablePurchases?: EditablePurchases; pendingEdits?: PendingPurchaseEdit[]; pendingDeletions?: PendingPurchaseDeletion[]; writesEnabled?: boolean; lanReadOnly?: boolean; lanOperational?: boolean; warnings?: string[]; previewOnly?: boolean };
export default function Home() {
  const account = useAccount();
  const today = useSyncExternalStore(dateSubscribe, () => romeDate(), () => "");
  const confirmedRef = useRef<Archive>({ expenses: [], receipts: [] });
  const readGeneration = useRef(0);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(0);
  const [adminLoaded, setAdminLoaded] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [localChanged, setLocalChanged] = useState(false);
  const localChangedRef = useRef(false);
  const [draftStarted, setDraftStarted] = useState(false);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [archiveContext, setArchiveContext] = useState({ month: "", category: "", purchaseId: "", visit: 0 });
  const [sessionExpenses, setExpenses] = useState<Expense[]>([]);
  const [receipts, setReceipts] = useState<ConfirmedReceipt[]>([]);
  const [registeredArchive, setRegisteredArchive] = useState<Archive>({ expenses: [], receipts: [] });
  const [editablePurchases, setEditablePurchases] = useState<EditablePurchases>({});
  const [pendingEdits, setPendingEdits] = useState<PendingPurchaseEdit[]>([]);
  const [pendingDeletions, setPendingDeletions] = useState<PendingPurchaseDeletion[]>([]);
  const [deleting, setDeleting] = useState<{ editable: EditablePurchase; recovery?: DeleteRequest } | null>(null);
  const [writesEnabled, setWritesEnabled] = useState(false);
  const [lanReadOnly, setLANReadOnly] = useState(false);
  const [previewOnly, setPreviewOnly] = useState(false);
  const [lanOperational, setLANOperational] = useState(false);
  const localOrigin = Boolean(today) && typeof window !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const mayAdd = !lanReadOnly && (hasLoaded || localOrigin);
  const [editing, setEditing] = useState<{ editable: EditablePurchase; recovery?: EditRequest } | null>(null);
  const [tab, setTab] = useState("Panoramica");
  const [selectedMonth, setMonth] = useState("");
  const month = selectedMonth || today.slice(0, 7);
  const [step, setStep] = useState<"choose" | "upload" | "review">("choose");
  const [mode, setMode] = useState<Mode>("Manuale");
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [preview, setPreview] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const [loadingArchive, setLoadingArchive] = useState(true);
  const [archiveError, setArchiveError] = useState("");
  const [snapshot, setSnapshot] = useState<unknown>();

  const [saving, setSaving] = useState(false);
  const savingLock = useRef(false);
  const manualOperation = useRef<{ signature: string; id: string } | null>(null);
  const [notes, setNotes] = useState("");
  const expenses = sessionExpenses;
  const applyRegisteredArchive = useCallback((body: ArchiveResponse) => {
    const checked = parseBackup(JSON.stringify(createBackup(body.archive))).archive;
    const oldIds = new Set(confirmedRef.current.expenses.map(e => e.id));
    const oldDocuments = new Set(confirmedRef.current.receipts.map(r => r.Documenti[0].id));
    const next = { expenses: checked.expenses, receipts: checked.receipts };
    readGeneration.current++; confirmedRef.current = next; setRegisteredArchive(next);
    if (!localChangedRef.current) {
      setExpenses(previous => [...checked.expenses, ...previous.filter(e => !oldIds.has(e.id) && !checked.expenses.some(item => item.id === e.id))]);
      setReceipts(previous => [...checked.receipts, ...previous.filter(r => !oldDocuments.has(r.Documenti[0].id) && !checked.receipts.some(item => item.Documenti[0].id === r.Documenti[0].id))]);
      if (checked.googleSheetsSnapshot !== undefined) { setSnapshot(checked.googleSheetsSnapshot); setAdminLoaded(true); }
      else { setSnapshot(undefined); setAdminLoaded(false); }
    }
    setPreviewOnly(body.previewOnly === true);
    setEditablePurchases(body.editablePurchases ?? {}); setPendingEdits(body.pendingEdits ?? []); setPendingDeletions(body.pendingDeletions ?? []);
    if (body.writesEnabled !== undefined) setWritesEnabled(body.writesEnabled);
    if (body.lanReadOnly !== undefined) setLANReadOnly(body.lanReadOnly === true);
    if (body.lanOperational !== undefined) setLANOperational(body.lanOperational === true);
    setHasLoaded(true); setLastUpdated(Date.now()); setLoadingArchive(false); setArchiveError("");
    if (body.warnings?.length) setNotice(body.warnings.join(" "));
  }, []);
  const refreshRegisteredArchive = useCallback(async (signal?: AbortSignal) => {
    const generation = ++readGeneration.current; setLoadingArchive(true);
    try {
      const body = await readConfirmedArchive(signal) as ArchiveResponse;
      if (generation === readGeneration.current) applyRegisteredArchive(body);
    } catch (caught) {
      if (signal?.aborted) return;
      if (generation === readGeneration.current) setArchiveError(caught instanceof Error ? caught.message : "Google Sheets non è disponibile. Riprova senza creare un nuovo invio.");
      throw caught;
    } finally { if (generation === readGeneration.current) setLoadingArchive(false); }
  }, [applyRegisteredArchive]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => { if (!controller.signal.aborted) return refreshRegisteredArchive(controller.signal).catch(() => {}); });
    return () => controller.abort();
  }, [refreshRegisteredArchive]);
  const dataState = archiveReadState(hasLoaded, loadingArchive, archiveError, registeredArchive);
  function openArchive(category = "", purchaseId = "") {
    setArchiveContext(current => ({ month, category, purchaseId, visit: current.visit + 1 })); setTab("Spese");
  }
  async function loadAdministration() {
    if (lanReadOnly || lanOperational || !localOrigin) return;
    if (adminBusy) return; setAdminBusy(true); setError("");
    const generation = readGeneration.current;
    try {
      const response = await sessionFetch("/api/archive", { cache: "no-store" }); const body = await response.json();
      if (!response.ok) throw new Error("Impossibile caricare i dati del backup. La sessione locale è conservata.");
      if (generation === readGeneration.current) {
        if (!localChangedRef.current) applyRegisteredArchive(body);
        setAdminLoaded(true);
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Backup non disponibile."); }
    finally { setAdminBusy(false); }
  }
  const reviewTotal = items.reduce((sum, item) => sum + (parseCents(item.amount) ?? 0), 0) / 100;
  function openAdd() {
    if (!mayAdd) return;
    if (!draftStarted) { setStep("choose"); setError(""); setPreview(""); setFileName(""); }
    dialog.current?.showModal();
  }
  function choose(next: Mode) {
    if (draftStarted) {
      if (next === mode) { setStep(next === "Manuale" || (next === "Screenshot" && items.length) ? "review" : "upload"); return; }
      if (!window.confirm("Cambiare modalità abbandona la bozza corrente. Vuoi continuare?")) return;
    }
    setDraftStarted(true); setMode(next);
    setError("");
    setMerchant("");
    setNotes("");
    setDate(romeDate());
    setItems([{ id: 1, category: "Alimentari", amount: "" }]);
    setStep(next === "Manuale" ? "review" : "upload");
  }
  async function updatePurchase(request: EditRequest) {
    let body;
    try {
      const response = await sessionFetch("/api/archive", { method: "PATCH", headers: await operationalHeaders(true, lanOperational), body: JSON.stringify(request) });
      body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error || "Modifica non confermata."), { code: body.code });
    } catch (caught) {
      await refreshRegisteredArchive().catch(() => {});
      throw caught;
    }
    applyRegisteredArchive(body);
    setNotice(body.duplicate ? "Modifica già confermata: archivio riletto, nessun invio duplicato." : "Modifica salvata su Google Sheets e verificata con rilettura dei dati.");
  }
  async function deletePurchase(request: DeleteRequest) {
    let body;
    try {
      const response = await sessionFetch("/api/archive", { method: "DELETE", headers: await operationalHeaders(true, lanOperational), body: JSON.stringify(request) });
      body = await response.json();
      if (!response.ok || body.deleted !== true) throw Object.assign(new Error(body.error || "Eliminazione non confermata."), { code: body.code });
    } catch (caught) {
      await refreshRegisteredArchive().catch(() => {});
      if (caught instanceof Error && "code" in caught) throw caught;
      throw new Error("Connessione interrotta: eliminazione non verificabile. Riprendi lo stesso tentativo, senza avviare una nuova operazione.");
    }
    applyRegisteredArchive(body);
    setNotice(body.duplicate ? "Eliminazione già verificata. Archivio e statistiche aggiornati, nessun invio duplicato." : "Spesa eliminata dall’archivio attivo. Documento, prodotti e movimenti verificati su Google Sheets; backup privato conservato.");
  }
  function simulate() {
    setMerchant(mode === "Scontrino" ? "Esselunga" : "Amazon");
    setItems(
      mode === "Scontrino"
        ? [
            { id: 1, category: resolveAIClassification("Alimentari", 0.95), amount: "42.50" },
            { id: 2, category: resolveAIClassification("Casa e Pulizia", 0.95), amount: "8.90" },
          ]
        : [{ id: 1, category: resolveAIClassification(undefined, 0), amount: "39.99" }],
    );
    setStep("review");
  }
  async function persist(input: unknown): Promise<Archive> {
    const response = await sessionFetch("/api/archive", { method: "POST", headers: await operationalHeaders(true, lanOperational), body: JSON.stringify(input) });
    const body = await response.json();
    if (!response.ok) {
      if (["CSRF", "WRITES_DISABLED", "SETUP_REQUIRED", "INVALID", "DEMO", "QUADRATURA", "TOO_LARGE"].includes(body.code)) manualOperation.current = null;
      throw Object.assign(new Error(body.error || "Salvataggio non confermato. Conserva la revisione e riprova."), { code: body.code });
    }
    const archive = parseBackup(JSON.stringify(createBackup(body.archive))).archive;
    const registered = { ...archive, expenses: archive.expenses.map(e => archive.receipts.length === 0 && body.operationId ? { ...e, sheetsDocumentId: `manual-${body.operationId}` } : e) };
    const previous = confirmedRef.current;
    const next = { expenses: [...registered.expenses, ...previous.expenses.filter(e => !registered.expenses.some(item => item.id === e.id))], receipts: [...registered.receipts, ...previous.receipts.filter(r => !registered.receipts.some(item => item.Documenti[0].id === r.Documenti[0].id))] };
    readGeneration.current++; confirmedRef.current = next; setRegisteredArchive(next); setHasLoaded(true); setLastUpdated(Date.now());
    setExpenses(previous => [...archive.expenses, ...previous.filter(e => !archive.expenses.some(item => item.id === e.id))]);
    setReceipts(previous => [...archive.receipts, ...previous.filter(r => !archive.receipts.some(item => item.Documenti[0].id === r.Documenti[0].id))]);

    void refreshRegisteredArchive().catch(() => { /* confirmed save remains visible; editor becomes available on reload */ });
    return archive;
  }
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (savingLock.current) return;
    savingLock.current = true; setSaving(true);
    try {
      if (mode !== "Manuale") throw new Error("Lo screenshot simulato resta una prova e non viene salvato su Google Sheets.");
      const draft = { description: merchant, date, notes, items };
      prepareManualExpenses({ ...draft, source: "Manuale" }, () => "validation-only");
      const signature = JSON.stringify(draft);
      if (manualOperation.current && manualOperation.current.signature !== signature) throw new Error("Il precedente invio va verificato prima di modificare i dati o creare una nuova operazione.");
      manualOperation.current ??= { signature, id: crypto.randomUUID() };
      await persist({ kind: "manual", operationId: manualOperation.current.id, draft });
      manualOperation.current = null; setDraftStarted(false);
      setMonth(date.slice(0, 7));
      setNotice(`Spese per ${money(reviewTotal)} salvate su Google Sheets.`);
      dialog.current?.close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Controlla i dati della spesa.");
    } finally { savingLock.current = false; setSaving(false); }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="SpeseSmart home">
          <span className="brand-symbol">
            <Icon name="leaf" size={25} />
          </span>
          Spese<span>Smart</span>
        </Link>
        <div className="workspace-label">IL TUO SPAZIO PERSONALE</div>
        <nav aria-label="Navigazione principale">
          {[
            ["Panoramica", "grid"],
            ["Spese", "list"],
            ["Aggiungi", "plus"],
            ["Impostazioni", "grid"],
          ].map(([label, icon]) => (
            <button
              key={label}
              className={`nav-item ${tab === label ? "active" : ""}`}
              disabled={label === "Aggiungi" && !mayAdd}
              aria-label={label === "Spese" ? "Archivio" : label === "Panoramica" ? "Dashboard" : label === "Aggiungi" ? "Aggiungi spesa" : label}
              aria-current={tab === label ? "page" : undefined}
              onClick={() => { if (label === "Aggiungi") openAdd(); else if (label === "Spese") openArchive(); else setTab(label); }}
            >
              <Icon name={icon} />
              <span>{label === "Spese" ? "Archivio" : label === "Panoramica" ? "Dashboard" : label}</span>
              {tab === label && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="demo-card">
            <span className="demo-dot" /> Archivio Google Sheets
            <p>
              Un piccolo passo verso
              <br />
              spese più consapevoli.
            </p>
            <span className="demo-note">Spese reali · nessuna demo nell’archivio</span>
          </div>
          <div className="profile">
            <span className="avatar">TU</span>
            <div>
              <strong>Il tuo spazio</strong>
              <small>Dati in questo browser</small>
            </div>
            <Icon name="down" size={16} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Il tuo spazio <span>/</span> <strong>{tab === "Spese" ? "Archivio" : tab}</strong>
          </div>
          <div className="topbar-right">
            <span className="demo-badge">GOOGLE SHEETS</span>
            <span className="avatar small">TU</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <h1>
                {tab === "Panoramica" ? "Dashboard" : tab === "Spese" ? "Archivio acquisti" : tab}
              </h1>
              {account && <p>Account: {account.username}</p>}
            </div>
            <button className="primary" disabled={!mayAdd} onClick={openAdd}>
              <Icon name="plus" />
              Aggiungi spesa
            </button>
          </div>
          {notice && (
            <div className="notice" role="status">
              <Icon name="check" />
              <span>{notice}</span>
              <button
                aria-label="Chiudi notifica"
                onClick={() => setNotice("")}
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          )}
          <div className="archive-read-status" role="status">
            {dataState === "loading" ? "Caricamento Google Sheets…" : dataState === "error" ? "Dati non disponibili: nessun totale attendibile." : dataState === "stale" ? "Dati precedenti non aggiornati." : previewOnly ? "Dati sintetici di collaudo" : null}
            {lastUpdated > 0 && <small>Ultima lettura {new Date(lastUpdated).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}</small>}
            <button className="text-button" disabled={loadingArchive} onClick={() => void refreshRegisteredArchive().catch(() => {})}>{loadingArchive ? "Caricamento…" : archiveError ? "Riprova caricamento" : "Aggiorna dati"}</button>
          </div>
          {lanReadOnly && <p className="notice" role="status">Accesso LAN in sola lettura. Inserimento, modifica, eliminazione, importazione e analisi AI sono disabilitati.</p>}
          {lanOperational && !account && <p className="local-note" role="status">Accesso LAN operativo autenticato. Backup, importazione e reset restano disponibili soltanto sul PC. Il budget personale è salvato in questo browser.</p>}
          {archiveError && <p className="error" role="alert">{archiveError}{hasLoaded ? " I valori mostrati sono quelli dell’ultima lettura riuscita." : " Controlla la connessione; gli importi non sono mostrati come zero."}</p>}
          {pendingEdits.map(pending => <div className="notice" role="status" key={pending.request.operationId}><span>Aggiornamento incompleto. Nuove scritture bloccate.</span><button className="text-button" disabled={!writesEnabled} onClick={() => setEditing({ editable: pending.editable, recovery: pending.request })}>Riprendi aggiornamento</button></div>)}
          {pendingDeletions.map(pending => <div className="notice" role="status" key={pending.request.operationId}><span>Eliminazione incompleta. Backup conservato, nuove scritture bloccate.</span><button className="text-button" disabled={!writesEnabled} onClick={() => setDeleting({ editable: pending.editable, recovery: pending.request })}>Riprendi eliminazione</button></div>)}
          {tab === "Impostazioni" ? <div className="settings-sections">{account && <><section className="panel"><h2>Account personale</h2><AccountControls /></section><PasswordChange /></>}<AIConsumption />{account && <CategorySettings />}
            {lanReadOnly || lanOperational || !localOrigin ? <section className="panel settings-administration"><h2>Accesso dalla rete domestica</h2><p>Backup, importazione e reset sono disponibili soltanto sul PC locale.</p></section> : <section className="panel settings-administration"><h2>Backup e strumenti locali</h2><p>Importazione, reset e riclassificazioni locali non modificano Google Sheets né le statistiche confermate. Esporta questa vista prima di ricaricare.</p>
              {!adminLoaded ? <button className="secondary" disabled={adminBusy} onClick={() => void loadAdministration()}>{adminBusy ? "Caricamento strumenti…" : "Carica backup e strumenti"}</button> : <>
                {localChanged && <p role="status">Vista locale modificata: dashboard e Archivio continuano a mostrare i dati confermati.</p>}
                <ArchiveTools archive={{ expenses, receipts, googleSheetsSnapshot: snapshot }} onReset={next => { localChangedRef.current = true; setExpenses(next.expenses); setReceipts(next.receipts); setLocalChanged(true); }} onRestore={next => { localChangedRef.current = true; setExpenses(next.expenses); setReceipts(next.receipts); setSnapshot(next.googleSheetsSnapshot); setLocalChanged(true); }} onReclassify={(id, category) => { localChangedRef.current = true; setLocalChanged(true); setExpenses(previous => previous.map(expense => expense.id === id ? { ...expense, category, originalCategory: expense.originalCategory ?? expense.category, needsCategoryReview: false } : expense)); }} />
              </>}{error && <p role="alert" className="error">{error}</p>}
            </section>}</div> : !hasLoaded || !month ? <section className="panel dashboard-unavailable"><h2>{loadingArchive ? "Caricamento delle spese" : "Google Sheets non disponibile"}</h2><p>{loadingArchive ? "Attendi la lettura dei dati confermati." : "Riprova il caricamento. Nessuna demo viene caricata."}</p></section> : tab === "Spese" ?
            <PurchaseArchive key={archiveContext.visit} archive={registeredArchive} initialMonth={archiveContext.month} initialCategory={archiveContext.category} selectedPurchaseId={archiveContext.purchaseId} error="" onAdd={openAdd} readOnly={lanReadOnly} editablePurchases={editablePurchases} writesEnabled={writesEnabled && !lanReadOnly && !archiveError && pendingEdits.length === 0 && pendingDeletions.length === 0} onEdit={editable => setEditing({ editable })} onDelete={editable => setDeleting({ editable })} /> :
            <SpendingDashboard archive={registeredArchive} month={month} today={today} onMonth={setMonth} onArchive={openArchive} onAdd={openAdd} readOnly={lanReadOnly} personal={Boolean(account)} />}

        </main>
        <footer className="app-footer">SpeseSmart © 2026 — Sviluppato da Adriano Parracciani (Cyberparra)</footer>
      </div>
      {editing && <PurchaseEditor key={editing.recovery?.operationId ?? `${editing.editable.documentId}:${editing.editable.version}`} editable={editing.editable} recovery={editing.recovery} onSave={updatePurchase} onClose={() => setEditing(null)} />}
      {deleting && <PurchaseDeletion key={deleting.recovery?.operationId ?? `${deleting.editable.documentId}:${deleting.editable.version}`} editable={deleting.editable} recovery={deleting.recovery} onDelete={deletePurchase} onClose={() => setDeleting(null)} />}
      <dialog
        ref={dialog}
        className="expense-dialog"
        onClose={() => setError("")}
        onCancel={event => { if (saving || receiptBusy) event.preventDefault(); }}
        aria-label="Inserimento spesa"
      >
        <div className="dialog-heading">
          <div>
            <div className="eyebrow">
              {step === "review"
                ? "ULTIMO PASSAGGIO"
                : "FACCIAMO SPAZIO ALLA SEMPLICITÀ"}
            </div>
            <h2>
              {step === "choose"
                ? "Come vuoi aggiungere la spesa?"
                : step === "upload"
                  ? mode === "Scontrino"
                    ? "Fotografa il tuo scontrino"
                    : "Carica uno screenshot"
                  : "Verifica la tua spesa"}
            </h2>
          </div>
          <button
            className="close-button"
            aria-label="Chiudi inserimento"
            disabled={saving || receiptBusy}
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" />
          </button>
        </div>
        {step === "choose" && (
          <>
            <p className="dialog-description">
              Scegli il modo più comodo per te. Potrai controllare ogni
              dettaglio prima di salvare.
            </p>
            <div className="mode-options">
              {(
                [
                  [
                    "Scontrino",
                    "camera",
                    "Foto scontrino",
                    "Scatta una foto o scegli dalla galleria.",
                  ],
                  [
                    "Screenshot",
                    "image",
                    "Screenshot acquisto online",
                    "Carica la conferma del tuo acquisto.",
                  ],
                  [
                    "Manuale",
                    "edit",
                    "Inserimento manuale",
                    "Aggiungi tutti i dettagli, in pochi secondi.",
                  ],
                ] as const
              ).map(([m, icon, title, desc]) => (
                <button key={m} onClick={() => choose(m)}>
                  <span className="icon-tile">
                    <Icon name={icon} size={24} />
                  </span>
                  <span>
                    <strong>{title}</strong>
                    <small>{desc}</small>
                  </span>
                  <span>→</span>
                </button>
              ))}
            </div>
            <div className="demo-info">
              <Icon name="info" size={18} />
              Gli scontrini possono essere analizzati con OpenAI. Puoi anche provare una demo senza inviare immagini.
            </div>
          </>
        )}
        {draftStarted && mode === "Scontrino" && (
          <div hidden={step !== "upload"}><ReceiptFlow lanOperational={lanOperational} onBusyChange={setReceiptBusy} onBack={() => setStep("choose")} onConfirm={async (receipt) => {
            if (receipt.Documenti[0].demo) throw Object.assign(new Error("La demo resta disponibile per la revisione e non viene salvata nell’archivio reale."), { code: "DEMO" });
            await persist({ kind: "receipt", operationId: receipt.Documenti[0].id, receipt });
            setMonth(receipt.Documenti[0].date.slice(0, 7));
            setNotice("Scontrino salvato su Google Sheets: documento, prodotti e subtotali confermati.");
            setDraftStarted(false); setReceiptBusy(false); dialog.current?.close();
          }} /></div>
        )}
        {step === "upload" && mode !== "Scontrino" && (
          <>
            <p className="dialog-description">
              Scegli un’immagine JPG, PNG o WebP (massimo 10 MB). La lettura
              automatica sarà disponibile in una prossima fase.
            </p>
            <label className="upload-area">
              <Icon name="upload" size={32} />
              <strong>{fileName || "Scegli un’immagine"}</strong>
              <span>
                Seleziona lo screenshot dal tuo dispositivo
              </span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  setError("");
                  setPreview("");
                  setFileName("");
                  if (!file) return;
                  if (
                    !["image/jpeg", "image/png", "image/webp"].includes(
                      file.type,
                    ) ||
                    file.size > 10 * 1024 * 1024
                  ) {
                    setError("Scegli un’immagine JPG, PNG o WebP entro 10 MB.");
                    e.target.value = "";
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => {
                    setPreview(String(reader.result));
                    setFileName(file.name);
                  };
                  reader.onerror = () =>
                    setError(
                      "Impossibile leggere il file. Prova un’altra immagine.",
                    );
                  reader.readAsDataURL(file);
                }}
              />
            </label>
            {preview && (
              <div
                className="preview"
                style={{ backgroundImage: `url("${preview}")` }}
                role="img"
                aria-label="Anteprima dell’immagine selezionata"
              />
            )}
            <div className="demo-info">
              <Icon name="info" size={18} />
              L’estrazione usa importi di esempio, indipendenti dall’immagine.
              Puoi provare anche senza caricare un file.
            </div>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setStep("choose")}>
                Indietro
              </button>
              <button className="primary" onClick={simulate}>
                Simula estrazione <Icon name="arrow" size={17} />
              </button>
            </div>
          </>
        )}
        {step === "review" && (
          <form onSubmit={save} inert={saving} aria-busy={saving}>
            <p className="dialog-description">
              {mode === "Manuale"
                ? "Registra una spesa: inserisci un importo positivo e scegli la categoria."
                : "Questi sono dati di esempio, non letti dall’immagine. Verifica e modifica ogni voce prima di salvare."}
            </p>
            <div className="form-grid">
              <label>
                Descrizione
                <input
                  required
                  maxLength={100}
                  value={merchant}
                  onChange={(e) => setMerchant(e.target.value)}
                  placeholder="Es. Spesa al supermercato"
                />
              </label>
              <label>
                Data
                <input
                  required
                  type="date"
                  min="2000-01-01"
                  max="2099-12-31"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
            </div>
            <div className="items-heading">
              <h3>Categorie e importi</h3>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setItems([
                    ...items,
                    { id: Date.now(), category: "Alimentari", amount: "" },
                  ])
                }
              >
                + Aggiungi voce
              </button>
            </div>
            {items.map((item) => (
              <div className="item-row" key={item.id}>
                <label>
                  Categoria
                  <select
                    value={item.category}
                    onChange={(e) =>
                      setItems(
                        items.map((i) =>
                          i.id === item.id
                            ? { ...i, category: e.target.value as Category }
                            : i,
                        ),
                      )
                    }
                  >
                    {categories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Importo (€)
                  <input
                    type="number"
                    required
                    min="0.01"
                    max="999999.99"
                    step="0.01"
                    inputMode="decimal"
                    value={item.amount}
                    placeholder="0,00"
                    onChange={(e) =>
                      setItems(
                        items.map((i) =>
                          i.id === item.id
                            ? { ...i, amount: e.target.value }
                            : i,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="remove-item"
                  disabled={items.length === 1}
                  aria-label="Rimuovi voce"
                  onClick={() =>
                    setItems(items.filter((i) => i.id !== item.id))
                  }
                >
                  <Icon name="trash" size={18} />
                </button>
              </div>
            ))}
            <label className="manual-notes">Note facoltative
              <textarea maxLength={1000} rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Aggiungi un dettaglio utile per ricordare la spesa" />
            </label>
            <div className="review-total">
              <span>Totale importi</span>
              <strong>{money(reviewTotal)}</strong>
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  setStep(mode === "Manuale" ? "choose" : "upload")
                }
              >
                Indietro
              </button>
              <button className="primary" type="submit">
                <Icon name="check" size={18} />
                {saving ? "Salvataggio…" : "Salva spesa"}
              </button>
            </div>
            <p className="local-note">
              Il salvataggio è confermato solo dopo la risposta di Google Sheets. In caso di errore la revisione resta disponibile.
            </p>
          </form>
        )}
      </dialog>
    </div>
  );
}
