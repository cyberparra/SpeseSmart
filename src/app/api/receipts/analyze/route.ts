import { handleReceiptRequest } from "@/lib/receipts/analyze-server";
import { aiAccess } from "@/lib/ai-access";
import { authenticatedAccount, multiuserEnabled } from "@/lib/lan-mode";
import { loadCatalog } from "@/lib/user-preferences";
export async function POST(request: Request) {
  const denied = aiAccess(request, true); if (denied) return denied;
  try {
    const user = await authenticatedAccount(request);
    if (multiuserEnabled() && !user) return Response.json({ error: "Accesso account richiesto." }, { status: 401 });
    if (user) await loadCatalog();
    return handleReceiptRequest(request, process.env.OPENAI_API_KEY, undefined, user?.id);
  } catch { return Response.json({ error: "Configurazione personale non disponibile." }, { status: 503 }); }
}
