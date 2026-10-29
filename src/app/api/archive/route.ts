import { loadCatalog } from "@/lib/user-preferences";
import { timingSafeEqual } from "node:crypto";
import { googleSheetsRepository } from "@/lib/sheets-repository";
import { PersistenceError } from "@/lib/sheets-persistence-model";
import { safeGoogleSheetsError, googleSheetsWritesEnabled } from "@/lib/google-sheets";
import { isSameOriginRequest } from "@/lib/request-origin";
import { archiveForView } from "@/lib/archive";
import { lanReadOnly, lanOperational, lanGatewayRequest, multiuserEnabled, authenticatedAccount } from "@/lib/lan-mode";

// Node.js è il runtime predefinito; Cache Components vieta la config runtime.
const headers = { "Cache-Control": "no-store" };
function access(request: Request): Response | null {
  if (multiuserEnabled() && !lanGatewayRequest(request)) return Response.json({ error: "Accesso account richiesto.", code: "AUTH_REQUIRED" }, { status: 401, headers });
  if (lanOperational() && !lanGatewayRequest(request)) return Response.json({ error: "Accesso LAN autenticato richiesto.", code: "LAN_ACCESS" }, { status: 403, headers });
  if (process.env.NODE_ENV !== "production") {
    try { if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) throw new Error(); }
    catch { return Response.json({ error: "Usa l’accesso LAN HTTPS autenticato.", code: "LOCAL_ACCESS" }, { status: 403, headers }); }
  }
  // Pubblicazione: nessun archivio finanziario accessibile senza autenticazione.
  if (process.env.NODE_ENV === "production" && !lanOperational()) {
    const user = process.env.SPESESMART_ACCESS_USER;
    const password = process.env.SPESESMART_ACCESS_PASSWORD;
    if (!user || !password) return Response.json({ error: "Configura l’accesso personale sul server prima della pubblicazione." }, { status: 503, headers });
    const expected = Buffer.from(`Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`);
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: "Accesso personale richiesto." }, { status: 401, headers: { ...headers, "WWW-Authenticate": 'Basic realm="SpeseSmart", charset="UTF-8"' } });
  }
  return null;
}
function fail(error: unknown) {
  const safe = error instanceof PersistenceError ? error : safeGoogleSheetsError(error);
  const status = safe.code === "AUTH_REQUIRED" ? 401 : safe.code === "NOT_FOUND" ? 404 : safe.code === "WRITES_DISABLED" ? 403 : ["EDIT_CONFLICT", "UPDATE_CONFLICT", "UPDATE_PENDING"].includes(safe.code) ? 409 : ["INVALID", "QUADRATURA", "NOT_EDITABLE", "EDIT_TOO_LARGE"].includes(safe.code) ? 422 : 503;
  return Response.json({ error: safe.message, code: safe.code }, { status, headers });
}
export async function GET(request: Request) {
  const denied = access(request); if (denied) return denied;
  if (lanOperational() && new URL(request.url).search !== "?view=dashboard") return Response.json({ error: "Strumenti amministrativi disponibili soltanto sul PC.", code: "LAN_ADMIN" }, { status: 403, headers });
  try {
    const user = await authenticatedAccount(request);
    if (!user) throw new PersistenceError("AUTH_REQUIRED", "Accesso account richiesto.");
    await loadCatalog();
    const repository = googleSheetsRepository(user);
    const loaded = await repository.load();
    const archive = archiveForView(loaded.archive, new URL(request.url).searchParams.get("view") === "dashboard");
    return Response.json({ ...loaded, archive, writesEnabled: googleSheetsWritesEnabled(), lanReadOnly: lanReadOnly(), lanOperational: lanOperational() }, { headers });
  } catch (error) { return fail(error); }
}
async function mutate(request: Request, action: "save" | "update" | "delete") {
  const denied = access(request); if (denied) return denied;
  if (!isSameOriginRequest(request)) return Response.json({ error: "Richiesta non consentita.", code: "CSRF" }, { status: 403, headers });
  // Prima di leggere il body, di autenticare un writer o di contattare Google.
  if (!googleSheetsWritesEnabled()) return fail(new PersistenceError("WRITES_DISABLED", "Salvataggi disabilitati in questo ambiente. Usa lo sviluppo locale autorizzato; la revisione è conservata."));
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new PersistenceError("INVALID", "Richiesta vuota.");
    const parts: Uint8Array[] = []; let length = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 20 * 1024 * 1024) { await reader.cancel(); throw new PersistenceError("TOO_LARGE", "Documento troppo grande per il salvataggio. La revisione è conservata."); }
      parts.push(value);
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(parts).toString("utf8")); }
    catch { throw new PersistenceError("INVALID", "Richiesta non valida."); }
    const user = await authenticatedAccount(request);
    if (!user) throw new PersistenceError("AUTH_REQUIRED", "Accesso account richiesto.");
    if (new URL(request.url).search) throw new PersistenceError("INVALID", "Parametri non consentiti.");
    await loadCatalog();
    const repository = googleSheetsRepository(user);
    const result = await repository[action](input);
    return Response.json({ ...result, archive: archiveForView(result.archive, lanOperational()) }, { headers });
  } catch (error) { return fail(error); }
}
export async function POST(request: Request) { return mutate(request, "save"); }
export async function PATCH(request: Request) { return mutate(request, "update"); }
export async function DELETE(request: Request) { return mutate(request, "delete"); }
