import { authenticatedAccount } from "@/lib/lan-mode";
import { personalBudget, updatePersonalBudget } from "@/lib/user-preferences";
import { PersistenceError } from "@/lib/sheets-persistence-model";
import { isSameOriginRequest } from "@/lib/request-origin";
const headers = { "Cache-Control": "no-store" };
async function handle(request: Request, write = false) {
  try {
    const user = await authenticatedAccount(request);
    if (!user) return Response.json({ error: "Accesso account richiesto." }, { status: 401, headers });
    const url = new URL(request.url);
    if (write) {
      if (!isSameOriginRequest(request) || url.search) return Response.json({ error: "Richiesta non consentita." }, { status: 403, headers });
      if (Number(request.headers.get("content-length")) > 4096) throw new PersistenceError("INVALID", "Richiesta troppo grande.");
      return Response.json(await updatePersonalBudget(user, await request.json()), { headers });
    }
    if (Array.from(url.searchParams.keys()).join() !== "month") throw new PersistenceError("INVALID", "Specifica soltanto il mese.");
    return Response.json(await personalBudget(user, url.searchParams.get("month") ?? ""), { headers });
  } catch (error) {
    const code = error instanceof PersistenceError ? error.code : "PREFERENCES";
    return Response.json({ error: code === "PREFERENCE_CONFLICT" ? "Budget modificato da un altro dispositivo. Rileggi prima di confermare." : "Preferenze non disponibili o richiesta non valida.", code },
      { status: code === "PREFERENCE_CONFLICT" ? 409 : code === "INVALID" ? 422 : 503, headers });
  }
}
export async function GET(request: Request) { return handle(request); }
export async function PATCH(request: Request) { return handle(request, true); }
