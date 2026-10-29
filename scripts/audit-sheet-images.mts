import nextEnv from "@next/env";
import { createSheetsTransport } from "../src/lib/sheets-repository";
import { safeGoogleSheetsError } from "../src/lib/google-sheets";
import { imageStorageAudit } from "../src/lib/image-storage-audit";
nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
try { console.log(JSON.stringify(imageStorageAudit(await createSheetsTransport().read()), null, 2)); }
catch (error) { console.error(safeGoogleSheetsError(error).message); process.exitCode = 1; }
