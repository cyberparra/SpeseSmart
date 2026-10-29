import { authenticatedAccount } from "@/lib/lan-mode";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const user = await authenticatedAccount(request);
    return user ? Response.json({ user }, { headers })
      : Response.json({ error: "Accesso account richiesto." }, { status: 401, headers });
  } catch {
    return Response.json({ error: "Registro account non disponibile." }, { status: 503, headers });
  }
}
