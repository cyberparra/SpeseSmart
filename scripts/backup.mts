import nextEnvironment from "@next/env";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { serverBackupConfig, initializeBackupRoot, createServerBackup, verifyServerBackup,
  restoreBackupIsolated, writeRotationPlan, applyRotationFile } from "../src/lib/server-backup";
import { BackupError } from "../src/lib/backup-sheets";

// Dedicated CLI, never a web endpoint. Environment/test bypasses are not accepted.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
Object.assign(process.env, { NODE_ENV: "production" });
nextEnvironment.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const [command, ...args] = process.argv.slice(2);
try {
  if (command === "verify" && args.length === 1) {
    const manifest = await verifyServerBackup(resolve(args[0]));
    console.log(JSON.stringify({ status: "verified", id: manifest.id, kind: manifest.kind,
      files: manifest.files.length, pending: manifest.state.pendingOperations.length, unknownAI: manifest.state.unknownAI }));
  } else {
    const config = serverBackupConfig();
    if (command === "init" && (args.length === 0 || (args.length === 1 && args[0] === "--allow-same-filesystem"))) {
      await initializeBackupRoot(config, args.length === 1); console.log("Destinazione privata inizializzata. Nessun registro o dato remoto modificato.");
    } else if ((command === "daily" || command === "weekly") && args.length === 0) {
      console.log(JSON.stringify({ status: "verified", ...await createServerBackup(config, command) }));
    } else if (command === "restore-test" && (args.length === 2 || args.length === 3)) {
      console.log(JSON.stringify({ status: "isolated-verified", ...await restoreBackupIsolated(config, resolve(args[0]), resolve(args[1]), args[2] ? resolve(args[2]) : undefined) }));
    } else if (command === "rotation" && args.length === 1) {
      console.log(JSON.stringify(await writeRotationPlan(config, resolve(args[0]))));
    } else if (command === "prune" && args.length === 2 && args[1] === "--confirm") {
      console.log(JSON.stringify(await applyRotationFile(config, resolve(args[0]))));
    } else throw new BackupError("USAGE", "Comando o parametri non validi. Consulta docs/backup.md.");
  }
} catch (error) {
  // Never print raw SDK/filesystem errors, paths with payloads, stack traces or secrets.
  if (error instanceof BackupError) console.error(`Backup fallito [${error.code}]: ${error.message}`);
  else console.error("Backup fallito: lock occupato, rete/disco/registri non disponibili o verifica fallita. Nessuna correzione automatica; controlla la guida.");
  process.exitCode = 1;
}
