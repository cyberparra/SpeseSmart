// Work on copies only. Historical Sheets rows must never be rewritten here.
export function withoutImages<T>(value: T): T {
  function clean(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(clean);
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (/^(image|photo|photograph|originalImage|originalPhoto|imageUrl|imageData|imageBytes|imageBase64|photoBase64|base64|dataUrl)$/i.test(key)) result[key] = "";
        else result[key] = clean(item);
      }
      // Technical JSON is split across cells; sanitize the joined payload first.
      if (Array.isArray(result.rows)) {
        const rows = result.rows as unknown[][];
        const headers = rows[0];
        const start = headers?.indexOf("SpeseSmart JSON 1") ?? -1;
        if (start >= 0) for (let i = 1; i < rows.length; i++) {
          const original = (value as { rows: unknown[][] }).rows[i];
          const joined = original.slice(start).join("");
          if (!joined) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(joined); }
          catch {
            if (/data:image\/|"(?:image|photo|base64|imageData|imageBytes|imageBase64)"\s*:/i.test(joined)) throw new Error("Snapshot con JSON tecnico incompleto: impossibile esportare un backup senza fotografie.");
            continue;
          }
          const cleaned = clean(parsed);
          if (JSON.stringify(cleaned) === JSON.stringify(parsed)) {
            rows[i] = [...rows[i].slice(0, start), ...original.slice(start)];
            continue;
          }
          const text = JSON.stringify(cleaned);
          const fragments = text.match(/[\s\S]{1,40000}/g) ?? [];
          rows[i] = [...rows[i].slice(0, start), ...fragments];
        }
      }
      return result;
    }
    if (typeof value === "string") {
      if (/^\s*[\[{]/.test(value)) {
        try {
          const parsed = JSON.parse(value);
          const cleaned = JSON.stringify(clean(parsed));
          return cleaned === JSON.stringify(parsed) ? value : cleaned;
        } catch { /* ordinary text or a fragment */ }
      }
      if (/data:image\//i.test(value)) return value.replace(/data:image\/[^;,\s]+;base64,[A-Za-z0-9+/=\s]*/gi, "");
    }
    return value;
  }
  return clean(value) as T;
}
