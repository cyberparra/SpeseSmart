import "server-only";
import { hostOperationsAllowed } from "../../scripts/host-policy.mjs";
import { sheets } from "@googleapis/sheets";
import { GoogleAuth, JWT } from "google-auth-library";
import { z } from "zod";
import { lanOperational, lanRuntimeValid } from "./lan-mode";

export const REQUIRED_SHEETS = ["Movimenti", "Prodotti", "Documenti", "Categorie", "LEGGIMI"] as const;
export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const METADATA_FIELDS = "spreadsheetId,sheets(properties(sheetId,title,index))";
const TIMEOUT_MS = 20_000;

export class GoogleSheetsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "GoogleSheetsError";
  }
}

const configurationError = () => new GoogleSheetsError("CONFIGURATION", "Controlla sul server la configurazione Google Sheets e le credenziali. Nessun dato modificato.");

// Non conservare errori originali o cause: possono contenere chiavi, token e percorsi.
export function safeGoogleSheetsError(error: unknown): GoogleSheetsError {
  if (error instanceof GoogleSheetsError) return error;
  const value = error as { code?: unknown; name?: unknown; message?: unknown; response?: { status?: unknown; data?: { error?: { details?: Array<{ reason?: unknown }> } } } } | null;
  const status = Number(value?.response?.status ?? value?.code);
  if (status === 403 && value?.response?.data?.error?.details?.some(d => d.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) return new GoogleSheetsError("AUTH_SCOPE", "La richiesta Google Sheets usa permessi API non compatibili. Il tentativo è conservato: verifica il metodo di lettura sul server prima di riprenderlo.");
  if (status === 401 || status === 403) return new GoogleSheetsError("AUTHORIZATION", "Accesso Google Sheets negato. Verifica credenziali, API abilitata e condivisione del foglio con il service account.");
  if (status === 404) return new GoogleSheetsError("NOT_FOUND", "Foglio non trovato o non accessibile. Verifica identificativo e condivisione.");
  if (status === 429) return new GoogleSheetsError("RATE_LIMIT", "Limite di richieste Google Sheets raggiunto. Riprova più tardi.");
  if (value?.name === "AbortError" || value?.name === "TimeoutError" || ["ETIMEDOUT", "ECONNABORTED"].includes(String(value?.code))) return new GoogleSheetsError("TIMEOUT", "La verifica Google Sheets ha superato il tempo disponibile. Riprova.");
  if (["ENOENT", "EACCES", "ERR_OSSL_UNSUPPORTED"].includes(String(value?.code)) || (typeof value?.message === "string" && /default credentials|private_key|client_email|invalid_grant|PEM|DECODER/i.test(value.message))) return configurationError();
  return new GoogleSheetsError("CONNECTION", "Impossibile verificare Google Sheets. Controlla la connessione e riprova.");
}

const ServiceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.email(),
  private_key: z.string().min(1),
  project_id: z.string().optional(),
});

export function googleSheetsWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return hostOperationsAllowed() && process.platform === "linux" && env.SPESESMART_SHEETS_WRITES_ENABLED === "true" && !env.VERCEL && env.SPESESMART_LAN_READ_ONLY !== "true"
    && (lanOperational(env) ? lanRuntimeValid(env) : env.NODE_ENV === "development");
}

export function createGoogleSheetsAuth(env: NodeJS.ProcessEnv = process.env, writable = false): GoogleAuth {
  if (writable && !googleSheetsWritesEnabled(env)) throw new GoogleSheetsError("WRITES_DISABLED", "Scritture disponibili soltanto nello sviluppo locale autorizzato o nel profilo LAN domestico verificato; produzione generica e Vercel restano in sola lettura.");
  const options = {
    scopes: [writable ? "https://www.googleapis.com/auth/spreadsheets" : SHEETS_READONLY_SCOPE],
    clientOptions: { transporterOptions: { timeout: TIMEOUT_MS, retry: false } },
  };
  // In locale GoogleAuth usa ADC e GOOGLE_APPLICATION_CREDENTIALS automaticamente.
  // Su hosting senza file, il JSON proviene esclusivamente da un secret del server.
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) {
    try {
      const account = ServiceAccountSchema.parse(JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON));
      const authClient = new JWT({
        email: account.client_email,
        key: account.private_key.replace(/\\n/g, "\n"),
        projectId: account.project_id,
        scopes: options.scopes,
        transporterOptions: options.clientOptions.transporterOptions,
      });
      return new GoogleAuth({ ...options, authClient });
    } catch { throw configurationError(); }
  }
  return new GoogleAuth(options);
}

type MetadataRequest = { spreadsheetId: string; includeGridData: false; fields: string };
type ReadOptions = { timeout: number; retry: false; signal: AbortSignal };
export type MetadataReader = (request: MetadataRequest, options: ReadOptions) => Promise<unknown>;

const MetadataSchema = z.object({
  spreadsheetId: z.string().min(1),
  sheets: z.array(z.object({ properties: z.object({
    sheetId: z.number().int().nonnegative(), title: z.string().min(1), index: z.number().int().nonnegative(),
  }) })).default([]),
});

export function createGoogleSheetsClient(env: NodeJS.ProcessEnv = process.env, reader?: MetadataReader) {
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  if (!spreadsheetId || !/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) throw configurationError();
  const auth = createGoogleSheetsAuth(env);
  const api = reader ? null : sheets({ version: "v4", auth });
  const read: MetadataReader = reader ?? (async (request, options) => (await api!.spreadsheets.get(request, options)).data);
  // Espone soltanto il metodo di lettura: nessuna API di scrittura o sincronizzazione.
  return {
    async verifyConnection() {
      try {
        const data = MetadataSchema.parse(await read({ spreadsheetId, includeGridData: false, fields: METADATA_FIELDS }, {
          timeout: TIMEOUT_MS, retry: false, signal: AbortSignal.timeout(TIMEOUT_MS),
        }));
        if (data.spreadsheetId !== spreadsheetId) throw new Error("unexpected spreadsheet");
        const detected = data.sheets.sort((a, b) => a.properties.index - b.properties.index).map(sheet => sheet.properties.title);
        if (new Set(detected).size !== detected.length) throw new Error("duplicate sheets");
        const missing = REQUIRED_SHEETS.filter(title => !detected.includes(title));
        return { connected: true, ready: missing.length === 0, readOnly: true, sheets: detected, missingSheets: missing };
      } catch (error) {
        if (error instanceof z.ZodError || (error instanceof Error && ["unexpected spreadsheet", "duplicate sheets"].includes(error.message))) {
          throw new GoogleSheetsError("INVALID_RESPONSE", "I metadati Google Sheets ricevuti non sono validi. Nessun dato modificato.");
        }
        throw safeGoogleSheetsError(error);
      }
    },
  };
}

export async function verifyGoogleSheetsConnection() {
  try { return await createGoogleSheetsClient().verifyConnection(); }
  catch (error) { throw safeGoogleSheetsError(error); }
}
