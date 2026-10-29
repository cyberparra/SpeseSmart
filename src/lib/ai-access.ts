import "server-only";
import { hostOperationsAllowed } from "../../scripts/host-policy.mjs";
import { timingSafeEqual } from "node:crypto";
import { isSameOriginRequest } from "./request-origin";
import { lanReadOnly, lanOperational, lanGatewayRequest, multiuserEnabled } from "./lan-mode";

export function aiAccess(request: Request, post = false): Response | null {
  if (multiuserEnabled() && !lanGatewayRequest(request)) return Response.json({ error: "Accesso account richiesto.", code: "AI_ACCESS" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (post && !hostOperationsAllowed()) return Response.json({ error: "Operazioni disabilitate amministrativamente su questo host.", code: "HOST_DISABLED" }, { status: 403 });
  const headers = { "Cache-Control": "no-store" };
  if (lanOperational() && !lanGatewayRequest(request)) return Response.json({ error: "Accesso LAN autenticato richiesto.", code: "LAN_ACCESS" }, { status: 403, headers });
  if (post && lanReadOnly()) return Response.json({ error: "Accesso LAN in sola lettura: analisi AI disabilitata.", code: "LAN_READ_ONLY" }, { status: 403, headers });
  if (process.env.VERCEL || !["development", "production"].includes(process.env.NODE_ENV ?? "")) return Response.json({ error: "AI disponibile soltanto sul server Ubuntu con registro persistente.", code: "AI_ENVIRONMENT" }, { status: 503, headers });
  if (process.env.NODE_ENV === "production" && !lanOperational()) {
    const user = process.env.SPESESMART_ACCESS_USER; const password = process.env.SPESESMART_ACCESS_PASSWORD;
    if (!user || !password) return Response.json({ error: "Configura l’accesso personale sul server.", code: "AI_ACCESS" }, { status: 503, headers });
    const expected = Buffer.from(`Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`);
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return Response.json({ error: "Accesso personale richiesto.", code: "AI_ACCESS" }, { status: 401, headers: { ...headers, "WWW-Authenticate": 'Basic realm="SpeseSmart", charset="UTF-8"' } });
  } else {
    try { if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) throw new Error(); }
    catch { return Response.json({ error: "Accesso AI locale richiesto.", code: "AI_ACCESS" }, { status: 403, headers }); }
  }
  if (post && !isSameOriginRequest(request)) return Response.json({ error: "Richiesta non consentita.", code: "CSRF" }, { status: 403, headers });
  return null;
}
