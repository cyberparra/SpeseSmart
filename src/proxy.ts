import { NextResponse, type NextRequest } from "next/server";
import { lanGatewayRequest, multiuserEnabled, multiuserFinancialDenied } from "./lib/lan-mode";

// Next 16 Proxy defaults to Node and, without a matcher, covers page/assets/APIs.
// Financial routes keep their own checks; this also denies direct backend browsing.
export function proxy(request: NextRequest) {
  if ((process.env.SPESESMART_HOME_PRODUCTION === "true" || multiuserEnabled()) && !lanGatewayRequest(request)) {
    return NextResponse.json({ error: "Accesso LAN autenticato richiesto.", code: "LAN_ACCESS" },
      { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (multiuserEnabled() && !( ["/", "/favicon.ico", "/api/auth/me", "/api/archive", "/api/preferences", "/api/categories", "/api/ai/usage", "/api/receipts/analyze"].includes(request.nextUrl.pathname) || (request.nextUrl.pathname.startsWith("/_next/static/") && !request.nextUrl.pathname.endsWith(".map")) )) return multiuserFinancialDenied()!;
  return NextResponse.next();
}
