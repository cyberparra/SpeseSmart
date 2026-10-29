import { createHash } from "node:crypto";
import { TABLE_HEADERS, type SheetSnapshot } from "./sheets-persistence-model";
// Aggregate only; never export images, receipt text, merchants or document IDs.
export function imageStorageAudit(snapshot: SheetSnapshot) {
  let images = 0, originalBytes = 0, embeddedBytes = 0, jsonBytes = 0, unparsedRows = 0;
  const unique = new Map<string, number>();
  for (const row of snapshot.Documenti.rows.slice(1)) {
    const parts = row.slice(TABLE_HEADERS.Documenti.length + 2);
    if (!parts.some(Boolean)) continue;
    const text = parts.join(""); jsonBytes += Buffer.byteLength(text);
    try {
      const value = JSON.parse(text);
      for (const receipt of value?.archive?.receipts ?? []) for (const document of receipt.Documenti ?? []) {
        if (typeof document.image !== "string" || !document.image) continue;
        const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(document.image);
        if (!match) { unparsedRows++; continue; }
        const bytes = Buffer.from(match[1], "base64");
        images++; originalBytes += bytes.length; embeddedBytes += Buffer.byteLength(document.image);
        unique.set(createHash("sha256").update(bytes).digest("hex"), bytes.length);
      }
    } catch { unparsedRows++; }
  }
  return { images, uniqueImages: unique.size, originalBytes, uniqueOriginalBytes: [...unique.values()].reduce((a, b) => a + b, 0), embeddedBytes, documentJsonBytes: jsonBytes, unparsedRows, readOnly: true };
}
