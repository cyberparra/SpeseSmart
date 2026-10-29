import nextEnv from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import { createSheetsTransport, setupPlan } from "../src/lib/sheets-repository";
import { safeGoogleSheetsError } from "../src/lib/google-sheets";
import { PersistenceError } from "../src/lib/sheets-persistence-model";
try {
  nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  const plan = setupPlan(await createSheetsTransport().read());
  const result = JSON.stringify({ applied: false, transactionsToWrite: 0, ...plan }, null, 2);
  if (process.argv.includes("--export")) {
    await mkdir("docs", { recursive: true });
    await writeFile("docs/google-sheets-first-write.json", result + "\n");
  }
  console.log(result);
} catch (error) {
  const safe = error instanceof PersistenceError ? error : safeGoogleSheetsError(error);
  console.error(JSON.stringify({ code: safe.code, error: safe.message })); process.exitCode = 1;
}
