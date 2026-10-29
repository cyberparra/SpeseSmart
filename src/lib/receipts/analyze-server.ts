import OpenAI from "openai";
import sharp from "sharp";
import { ZodError } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { effectiveReceiptSchema, effectiveReceiptInstructions, validateAnalysis } from "./model";
import { MAX_IMAGE_BYTES, matchesImageSignature, validateImageFile } from "./upload";
import { AIControlError, aiConfiguration, controlledAnalysis, MAX_AI_OUTPUT } from "../ai-usage";

export class ReceiptError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export async function analyzeWithOpenAI(image: string, key: string) {
  const client = new OpenAI({ apiKey: key, timeout: 60000, maxRetries: 0 });
  const response = await client.responses.parse({
    model: aiConfiguration().model,
    store: false,
    input: [
      { role: "system", content: effectiveReceiptInstructions() },
      { role: "user", content: [{ type: "input_text", text: "Leggi e classifica le singole voci di questo scontrino." }, { type: "input_image", image_url: image, detail: "high" }] },
    ],
    text: { format: zodTextFormat(effectiveReceiptSchema(), "receipt") },
    max_output_tokens: MAX_AI_OUTPUT,
  });
  return { receipt: response.output_parsed, completed: response.status === "completed", model: response.model,
    usage: response.usage ? { input: response.usage.input_tokens, cached: response.usage.input_tokens_details.cached_tokens, output: response.usage.output_tokens } : null };
}
export function apiError(error: unknown) {
  if (error instanceof AIControlError) return new ReceiptError(error.status, error.code, error.message);
  if (error instanceof ReceiptError) return error;
  if (error instanceof ZodError || error instanceof SyntaxError) return new ReceiptError(502, "INVALID_AI", "La risposta AI è incompleta o non valida. Riprova con una foto più nitida.");
  if (error instanceof OpenAI.APIConnectionTimeoutError || (error instanceof Error && error.name === "AbortError")) return new ReceiptError(504, "TIMEOUT", "L’analisi ha impiegato troppo tempo. Riprova.");
  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) return new ReceiptError(429, "RATE_LIMIT", "Il servizio AI ha raggiunto il limite disponibile. Riprova più tardi o verifica il credito API.");
    if (error.status === 401 || error.status === 403) return new ReceiptError(503, "CONFIGURATION", "Il servizio AI non è configurato correttamente. Controlla la chiave API sul server.");
    if (error.status === 400) return new ReceiptError(422, "IMAGE_OR_MODEL", "Impossibile analizzare l’immagine. Prova un’altra foto; verifica anche il modello configurato sul server.");
  }
  return new ReceiptError(502, "API_ERROR", "Il servizio AI non è disponibile. Le tue modifiche restano nella revisione; riprova più tardi.");
}
// Dipendenze sostituibili nei test: nessuna chiamata API a pagamento.
export async function handleReceiptRequest(request: Request, key: string | undefined, analyze?: (image: string, key: string) => Promise<unknown>, userId?: string): Promise<Response> {
  const fail = (error: ReceiptError) => Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  try {
    if (!key?.trim()) throw new ReceiptError(503, "MISSING_API_KEY", "Analisi reale non disponibile: OPENAI_API_KEY non è configurata. Puoi provare lo scontrino dimostrativo.");
    const limit = MAX_IMAGE_BYTES + 65536;
    if (Number(request.headers.get("content-length")) > limit) throw new ReceiptError(413, "TOO_LARGE", "L’immagine supera 10 MB.");
    if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) throw new ReceiptError(415, "FORMAT", "Carica un’immagine JPG, PNG o WebP.");
    const reader = request.body?.getReader();
    if (!reader) throw new ReceiptError(400, "EMPTY", "Scegli un’immagine dello scontrino.");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ReceiptError(413, "TOO_LARGE", "L’immagine supera 10 MB."); }
      chunks.push(value);
    }
    let form: FormData;
    try { form = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type")! } }).formData(); }
    catch { throw new ReceiptError(400, "BAD_UPLOAD", "Caricamento non valido. Scegli nuovamente l’immagine."); }
    for (const key of form.keys()) if (!["image", "reanalyze"].includes(key)) throw new ReceiptError(400, "INVALID", "Campo di analisi non consentito.");
    const file = form.get("image");
    if (!(file instanceof File)) throw new ReceiptError(400, "EMPTY", "Scegli un’immagine dello scontrino.");
    const message = validateImageFile(file);
    if (message) throw new ReceiptError(file.size > MAX_IMAGE_BYTES ? 413 : 415, "INVALID_FILE", message);
    const buffer = Buffer.from(await file.arrayBuffer());
    if (!matchesImageSignature(buffer, file.type)) throw new ReceiptError(415, "INVALID_IMAGE", "Il contenuto non corrisponde al formato dell’immagine. Scegli un altro file.");
    try {
      const metadata = await sharp(buffer, { limitInputPixels: 40000000 }).metadata();
      if (!metadata.width || !metadata.height || metadata.pages && metadata.pages > 1) throw new Error("invalid image");
    } catch { throw new ReceiptError(422, "CORRUPT_IMAGE", "L’immagine è danneggiata, animata o troppo grande in pixel. Prova una foto più piccola e nitida."); }
    const forceValue = form.get("reanalyze");
    if (forceValue !== null && forceValue !== "true") throw new ReceiptError(400, "INVALID", "Opzione di analisi non valida.");
    const image = `data:${file.type};base64,${buffer.toString("base64")}`;
    // Injected analyzers are used only by fixture tests; production always uses the durable guard.
    const result = analyze ? { receipt: await analyze(image, key), reusedFromCache: false }
      : await controlledAnalysis(buffer, forceValue === "true", () => analyzeWithOpenAI(image, key), aiConfiguration(), () => new Date(), userId);
    const raw = result.receipt;
    let receipt;
    try { receipt = validateAnalysis(raw); } catch { throw new ReceiptError(502, "INVALID_AI", "La risposta AI è incompleta o non valida. Riprova senza salvare dati incerti."); }
    if (receipt.status !== "receipt") throw new ReceiptError(422, receipt.status, receipt.status === "not_receipt" ? "L’immagine non sembra contenere uno scontrino. Scegli un’altra foto." : "Lo scontrino è sfocato o illeggibile. Scatta una foto più nitida.");
    if (!receipt.items.length) throw new ReceiptError(422, "NO_ITEMS", "Non sono state riconosciute voci. Prova una foto più nitida.");
    return Response.json({ receipt, reusedFromCache: result.reusedFromCache }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return fail(apiError(error)); }
}
