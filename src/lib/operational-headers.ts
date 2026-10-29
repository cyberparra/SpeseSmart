import { sessionFetch } from "@/lib/session-fetch";
// No retry of a financial operation or paid analysis. A session refresh happens
// before sending the operation, never after an uncertain response.
export async function operationalHeaders(json = true, lanOperational = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = json ? { "Content-Type": "application/json" } : {};
  if (!lanOperational) return headers;
  const response = await sessionFetch("/api/lan/session", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  if (!response.ok || typeof body.csrf !== "string") throw new Error("Sessione LAN non disponibile. Accedi nuovamente: la bozza è conservata.");
  return { ...headers, "X-SpeseSmart-CSRF": body.csrf };
}
