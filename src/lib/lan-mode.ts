import "server-only";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { homeProductionReady } from "../../scripts/home-runtime.mjs";
import { accountDirectory, readAccounts, publicAccount } from "../../scripts/accounts.mjs";

export const multiuserEnabled = () => process.env.SPESESMART_MULTIUSER === "true";

// Identity headers are accepted only on the existing capability-protected hop.
// Role and active state come from the private registry, never from the browser.
export async function authenticatedAccount(request: Request) {
  if (!multiuserEnabled() || !lanGatewayRequest(request)) return null;
  const id = request.headers.get("x-spesesmart-user-id");
  const revision = request.headers.get("x-spesesmart-account-revision");
  const registry = await readAccounts(accountDirectory());
  const account = registry.accounts.find(a => a.id === id && a.revision === revision && a.active);
  return account ? publicAccount(account) : null;
}

// Unlisted routes stay closed in the multiuser profile.
export function multiuserFinancialDenied() {
  return multiuserEnabled() ? Response.json({ error: "Funzionalità non ancora disponibile nel profilo multiutente.", code: "MULTIUSER_NOT_READY" },
    { status: 403, headers: { "Cache-Control": "no-store" } }) : null;
}

export function lanOperational(env: NodeJS.ProcessEnv = process.env): boolean {
  // Invalid production profiles must still take the deny-only gateway path.
  return env.SPESESMART_LAN_OPERATIONAL === "true" || env.SPESESMART_HOME_PRODUCTION === "true";
}

// Production is granted only by the home launcher, inherited lock and private proof.
export function lanRuntimeValid(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const origin = new URL(env.SPESESMART_LAN_ORIGIN ?? "");
    const port = Number(env.SPESESMART_LAN_INTERNAL_PORT);
    return process.platform === "linux" && !env.VERCEL
      && (env.SPESESMART_HOME_PRODUCTION === "true" ? homeProductionReady(env) : env.NODE_ENV === "development")
      && lanOperational(env) && env.SPESESMART_LAN_READ_ONLY !== "true"
      && /^[a-f0-9]{64}$/.test(env.SPESESMART_LAN_CAPABILITY ?? "")
      && origin.origin === env.SPESESMART_LAN_ORIGIN && origin.protocol === "https:"
      && isIP(origin.hostname) === 4
      && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d/.test(origin.hostname)
      && Number(origin.port) >= 1024 && Number(origin.port) <= 65535
      && Number.isInteger(port) && port >= 1024 && port <= 65535;
  } catch { return false; }
}

export function lanGatewayRequest(request: Request): boolean {
  if (!lanRuntimeValid()) return false;
  try {
    const target = new URL(request.url);
    const actual = Buffer.from(request.headers.get("x-spesesmart-lan-capability") ?? "");
    const expected = Buffer.from(process.env.SPESESMART_LAN_CAPABILITY!);
    return ["127.0.0.1", "localhost"].includes(target.hostname) && target.protocol === "http:"
      && target.port === process.env.SPESESMART_LAN_INTERNAL_PORT
      && request.headers.get("host") === `127.0.0.1:${target.port}`
      && actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

// Additional deny-only gate for the dedicated LAN process; never grants writes.
export const lanReadOnly = () => process.env.SPESESMART_LAN_READ_ONLY === "true";
