import { sessionFetch } from "./session-fetch";
export const ARCHIVE_READ_TIMEOUT_MS = 45_000;

// Consultation only: one deadline covers connection, headers and JSON body.
// Never replay requests or reuse this helper for mutations/paid analyses.
export async function readConfirmedArchive(signal?: AbortSignal, timeoutMs = ARCHIVE_READ_TIMEOUT_MS, fetcher: typeof fetch = sessionFetch): Promise<unknown> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher("/api/archive?view=dashboard", { cache: "no-store", signal: controller.signal });
    if ([401, 403].includes(response.status)) throw new Error("Accesso all’archivio non consentito. Verifica l’accesso autenticato e riprova il caricamento.");
    if (!response.ok) throw new Error("Google Sheets non è disponibile. Riprova il caricamento senza creare un nuovo invio.");
    try { return await response.json(); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error("Risposta dell’archivio non valida. Riprova il caricamento; i dati precedenti sono conservati.");
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (controller.signal.aborted) throw new Error("Il caricamento delle spese ha superato il tempo disponibile. Riprova caricamento; nessun nuovo invio è stato effettuato.");
    if (error instanceof TypeError) throw new Error("Impossibile raggiungere l’archivio. Controlla la connessione e riprova il caricamento.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
