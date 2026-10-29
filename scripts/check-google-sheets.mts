import nextEnv from "@next/env";
import { safeGoogleSheetsError, verifyGoogleSheetsConnection } from "../src/lib/google-sheets";

// Stesse regole di caricamento di Next.js; nessuna stampa del contenuto dei file env.
try {
  nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production", {
    info() {}, error() { throw new Error("environment configuration"); },
  });
  const result = await verifyGoogleSheetsConnection();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
} catch (error) {
  const safe = safeGoogleSheetsError(error);
  console.error(JSON.stringify({ connected: false, code: safe.code, message: safe.message }));
  process.exitCode = 1;
}
