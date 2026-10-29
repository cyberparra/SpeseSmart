"use client";
import { useRef, useState, useSyncExternalStore, useEffect, useCallback } from "react";
import { BUDGET_KEY, monthlyBudget, budgetConfigured, saveMonthlyBudget } from "@/lib/budget";
import { sessionFetch } from "@/lib/session-fetch";
import { operationalHeaders } from "@/lib/operational-headers";
import { centsInput, parseCents } from "@/lib/receipts/model";
import { money } from "@/lib/demo";

const changedEvent = "spesesmart:budget-changed";
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === BUDGET_KEY || event.key === null) notify(); };
  window.addEventListener("storage", storage);
  window.addEventListener(changedEvent, notify);
  return () => { window.removeEventListener("storage", storage); window.removeEventListener(changedEvent, notify); };
}
function snapshot() {
  try { return window.localStorage.getItem(BUDGET_KEY) ?? "{}"; }
  catch { return "unavailable"; }
}
function serverSnapshot() { return "{}"; }
type RemoteBudget = { month: string; budgetCents: number; configured: boolean; version: number };
const noSubscribe = () => () => {};
export function useMonthlyBudget(month: string, personal = false) {
  const raw = useSyncExternalStore(personal ? noSubscribe : subscribe, personal ? serverSnapshot : snapshot, serverSnapshot);
  const [remote, setRemote] = useState<RemoteBudget | null>(null);
  const [remoteError, setRemoteError] = useState("");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await sessionFetch("/api/preferences?month=" + month, { cache: "no-store", signal });
    const body = await response.json();
    if (!response.ok) throw Error(body.error || "Budget non disponibile.");
    if (!signal?.aborted) { setRemote(body); setRemoteError(""); }
  }, [month]);
  useEffect(() => {
    if (!personal) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => refresh(controller.signal)).catch(error => { if (!controller.signal.aborted) setRemoteError(error.message); });
    return () => controller.abort();
  }, [personal, refresh]);
  if (personal) return { budgetCents: remote?.month === month ? remote.budgetCents : null, configured: remote?.month === month && remote.configured, error: remoteError,
    save: async (text: string) => {
      const value = parseCents(text);
      if (value === null || value < 0 || !remote || remote.month !== month) throw Error("Completa un budget valido dopo il caricamento.");
      const response = await sessionFetch("/api/preferences", { method: "PATCH", headers: await operationalHeaders(true, true), body: JSON.stringify({ month, budgetCents: value, expectedVersion: remote.version }) });
      const body = await response.json();
      if (!response.ok) { if (response.status === 409) await refresh(); throw Error(body.error || "Budget non salvato."); }
      setRemote(body); setRemoteError("");
    }, refresh: () => refresh() };

  try { return { budgetCents: monthlyBudget(raw, month), configured: budgetConfigured(raw, month), error: "" }; }
  catch { return { budgetCents: null, configured: false, error: "Budget non disponibile: controlla l’accesso alla memoria locale e la configurazione salvata." }; }
}
export function MonthlyBudget({ month, budgetCents, storageError, configured = false, readOnly = false, onSave, onRefresh }: { month: string; budgetCents: number | null; storageError: string; configured?: boolean; readOnly?: boolean; onSave?: (text: string) => Promise<void>; onRefresh?: () => Promise<void> }) {
  const editor = useRef<HTMLDetailsElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  return <article className="stat-card budget-settings">
    <div className="budget-card-heading"><div className="stat-label">Budget mensile</div>
    <div className="stat-value">{budgetCents === null ? "—" : money(budgetCents / 100)}</div></div>
    <p className="budget-kind">{configured ? "Personalizzato per questo mese" : "Predefinito · non personalizzato"}</p>
    {!readOnly && <details ref={editor}><summary>Modifica budget</summary><form onSubmit={async (event) => {
      event.preventDefault(); if (saving) return; setSaving(true); setError(""); setNotice("");
      try {
        if (onSave) await onSave(text ?? centsInput(budgetCents));
        else { saveMonthlyBudget(window.localStorage, month, text ?? centsInput(budgetCents)); window.dispatchEvent(new Event(changedEvent)); }
        setText(null); setNotice("Budget del mese salvato."); if (editor.current) editor.current.open = false;
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Impossibile salvare il budget."); } finally { setSaving(false); }
    }}>
      <label>Limite di spesa (€)<input required inputMode="decimal" value={text ?? centsInput(budgetCents)} onChange={(event) => setText(event.target.value)} /></label>
      <button className="text-button" type="submit" disabled={saving || budgetCents === null}>Salva budget</button>
    </form></details>}
    {onRefresh && <button className="text-button" onClick={() => void onRefresh().catch(() => setError("Budget non disponibile."))}>Aggiorna budget</button>}
    {notice && <p role="status">{notice}</p>}
    {(error || storageError) && <p className="error" role="alert">{error || storageError}</p>}
  </article>;
}
