export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export function validateImageFile(file: { size: number; type: string }): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return "Formato non supportato. Scegli JPG, PNG o WebP.";
  if (file.size <= 0) return "Il file è vuoto. Scegli un’altra immagine.";
  if (file.size > MAX_IMAGE_BYTES) return "L’immagine supera 10 MB. Riduci la dimensione e riprova.";
  return null;
}
export function matchesImageSignature(bytes: Uint8Array, type: string): boolean {
  if (type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  if (type === "image/webp") return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}
