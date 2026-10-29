// One immutable binding per document. A different login always creates a new
// document; old components can never borrow the next account's credentials.
type Binding = { userId: string; csrf: string; controller: AbortController };
let required = false;
let binding: Binding | null = null;
export function bindSession(userId?: string, csrf?: string, multiuser = true) {
  binding?.controller.abort(); required = multiuser;
  binding = userId && csrf ? { userId, csrf, controller: new AbortController() } : null;
}
export const personalSession = () => required;
export function clearSession() {
  binding?.controller.abort(); binding = null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("spesesmart:session-ended"));
}
export async function sessionFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const own = binding;
  if (required && !own) throw new DOMException("Sessione terminata.", "AbortError");
  const headers = new Headers(init.headers);
  if (own) headers.set("X-SpeseSmart-CSRF", own.csrf);
  const response = await fetch(input, { ...init, headers, ...(own ? { signal: AbortSignal.any([own.controller.signal, ...(init.signal ? [init.signal] : [])]) } : {}) });
  if (own) {
    if (own !== binding || own.controller.signal.aborted) throw new DOMException("Sessione terminata.", "AbortError");
    if (response.status === 401) { clearSession(); throw new Error("Sessione scaduta: accedi nuovamente."); }
    if (String(input) === "/api/lan/session") {
      const data = await response.clone().json();
      if (data.user?.id !== own.userId || data.csrf !== own.csrf) { clearSession(); throw new Error("Account cambiato: accedi nuovamente."); }
    }
  }
  return response;
}
