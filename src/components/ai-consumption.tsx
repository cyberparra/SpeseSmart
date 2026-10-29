"use client";
import { sessionFetch } from "@/lib/session-fetch";
import { useAccount } from "./account-session";
import { useEffect, useState } from "react";
import type { getAIUsage } from "@/lib/ai-usage";
type Summary = Awaited<ReturnType<typeof getAIUsage>>;
async function readSummary(signal?: AbortSignal): Promise<Summary> {
  const response = await sessionFetch("/api/ai/usage", { cache: "no-store", signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Consumi AI non disponibili.");
  return body;
}
export function AIConsumption() {
  const personal = Boolean(useAccount());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  async function refresh(signal?: AbortSignal) {
    try {
      setSummary(await readSummary(signal));
    } catch (error) { if (!(error instanceof Error && error.name === "AbortError")) { setSummary(null); setError(error instanceof Error ? error.message : "Consumi AI non disponibili."); } }
    finally { setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    readSummary(controller.signal).then(body => { if (!controller.signal.aborted) setSummary(body); }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Consumi AI non disponibili.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return <section className="panel ai-consumption" aria-labelledby="ai-consumption-title">
    <div className="panel-heading"><div><h2 id="ai-consumption-title">Consumi AI</h2><p>{personal ? "Consumi del tuo account. I limiti AI sono condivisi tra tutti gli utenti." : "Limiti separati dal budget delle spese personali."}</p></div><button type="button" className="secondary" disabled={loading} onClick={() => { setLoading(true); setError(""); void refresh(); }}>Aggiorna consumi</button></div>
    {loading && <p role="status">Lettura dei consumi…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {summary && <>
      <p>Mese {summary.month} · fuso Europe/Rome</p>
      <dl className="ai-metrics">
        <div><dt>Nuove analisi</dt><dd>{summary.analyses} / {summary.maxAnalyses}</dd></div>
        <div><dt>Risultati riutilizzati</dt><dd>{summary.cacheHits}</dd></div>
        <div><dt>Token consumati noti</dt><dd>{summary.totalTokens.toLocaleString("it-IT")}</dd></div>
        <div><dt>Costo stimato</dt><dd>{summary.estimatedUsd.toFixed(6)} USD</dd></div>
      </dl>
      <p>Input: {summary.inputTokens} · di cui in cache OpenAI: {summary.cachedInputTokens} · output: {summary.outputTokens}.</p>
      <p>{personal ? "Limite complessivo" : "Budget"}: {summary.budgetUsd.toFixed(2)} USD · {personal ? "impegnato dal tuo account" : "utilizzato o impegnato"}: {summary.committedUsd.toFixed(6)} USD.</p>
      <label className="ai-progress">{personal ? "Contributo personale al limite mensile" : "Utilizzo del limite mensile"}: {summary.percent.toFixed(1)}%<progress max={100} value={Math.min(100, summary.percent)} /></label>
      {(summary.warning || summary.blocked) && <p className="receipt-warning" role="status">{summary.blocked ? "Nuove analisi bloccate: limite mensile o prenotazione non disponibile." : "È stato utilizzato almeno l’80% di uno dei limiti AI."}</p>}
      {summary.unknown > 0 && <p className="receipt-warning">{summary.unknown} analisi in corso o con consumo sconosciuto: prenotazioni mantenute nel budget, token non inventati.</p>}
      <p className="local-note">Stima applicativa, distinta dagli importi effettivamente fatturati da OpenAI. La percentuale considera il maggiore fra consumo del budget (incluse prenotazioni) e numero di nuove analisi. Anche una prenotazione non disponibile può bloccare la prossima analisi.</p>
    </>}
  </section>;
}
