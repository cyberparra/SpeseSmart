import "server-only";
import { lanOperational, lanGatewayRequest } from "./lan-mode";

const isLoopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

// NextURL normalizza gli IP loopback in localhost. Host conserva l'autorità
// realmente richiesta dal browser: non trattare le diverse origini come alias.
export function isSameOriginRequest(request: Request): boolean {
  if (lanOperational()) return lanGatewayRequest(request)
    && request.headers.get("origin") === process.env.SPESESMART_LAN_ORIGIN
    && request.headers.get("sec-fetch-site") === "same-origin";
  try {
    const target = new URL(request.url);
    const origin = request.headers.get("origin");
    if (!origin || !["http:", "https:"].includes(target.protocol) || new URL(origin).origin !== origin) return false;
    let actual = target;
    const host = request.headers.get("host");
    if (host !== null) {
      if (!/^[a-zA-Z0-9.:[\]-]+$/.test(host)) return false;
      actual = new URL(`${target.protocol}//${host}`);
      if (isLoopback(target.hostname)) {
        if (!isLoopback(actual.hostname) || actual.port !== target.port) return false;
      } else if (actual.origin !== target.origin) return false;
    }
    if (process.env.NODE_ENV === "development" && !isLoopback(actual.hostname)) return false;
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return false;
    // X-Forwarded-Host/Proto non sono attendibili in questo server locale.
    return origin === actual.origin;
  } catch { return false; }
}
