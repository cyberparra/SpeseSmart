import nextEnv from "@next/env";
import { initializeAI, aiConfiguration, AIControlError } from "../src/lib/ai-usage";
import { initializePreferences } from "../src/lib/user-preferences";
if (!process.argv.includes("--preferences")) nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
try { if (process.argv.includes("--preferences")) { await initializePreferences(); console.log("Preferenze private inizializzate. Nessuna chiamata remota."); } else { const config = aiConfiguration(); await initializeAI(config); console.log(`Registro AI pronto: ${config.directory} (cartella 0700, file 0600). Nessuna chiamata OpenAI.`); } }
catch (error) { console.error(error instanceof AIControlError ? error.message : "Inizializzazione registro AI non riuscita; nessun registro esistente sovrascritto."); process.exitCode = 1; }
