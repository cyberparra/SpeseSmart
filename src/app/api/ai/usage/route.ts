import { aiAccess } from "@/lib/ai-access";
import { AIControlError, getAIUsage } from "@/lib/ai-usage";
import { authenticatedAccount, multiuserEnabled } from "@/lib/lan-mode";
export async function GET(request: Request) {
  const denied = aiAccess(request); if (denied) return denied;
  try { const user = await authenticatedAccount(request);
    if (multiuserEnabled() && !user) return Response.json({ error: "Accesso account richiesto." }, { status: 401 });
    return Response.json(await getAIUsage(undefined, undefined, user?.id), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return Response.json({ error: error instanceof AIControlError ? error.message : "Registro AI non disponibile.", code: "AI_STORAGE" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
