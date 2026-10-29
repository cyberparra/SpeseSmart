import { authenticatedAccount } from "@/lib/lan-mode";
import { loadCatalog, addCategory } from "@/lib/user-preferences";
import { PersistenceError } from "@/lib/sheets-persistence-model";
import { isSameOriginRequest } from "@/lib/request-origin";
const headers = { "Cache-Control": "no-store" };
async function handle(request: Request, write = false) {
  try {
    const user = await authenticatedAccount(request);
    if (!user) return Response.json({ error: "Accesso account richiesto." }, { status: 401, headers });
    if (new URL(request.url).search || (write && !isSameOriginRequest(request))) return Response.json({ error: "Richiesta non consentita." }, { status: 403, headers });
    if (write && user.role !== "admin") return Response.json({ error: "Gestione categorie riservata all’amministratore." }, { status: 403, headers });
    return Response.json(write ? await addCategory(user, await request.json()) : await loadCatalog(), { headers });
  } catch (error) {
    const code = error instanceof PersistenceError ? error.code : "PREFERENCES";
    return Response.json({ error: "Catalogo non disponibile o richiesta non valida.", code }, { status: code === "PREFERENCE_CONFLICT" ? 409 : code === "INVALID" ? 422 : 503, headers });
  }
}
export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request, true); }
