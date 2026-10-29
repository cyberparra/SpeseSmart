import type { ReceiptAnalysis } from "./model";
export const demoReceipt: ReceiptAnalysis = {
  status: "receipt", merchant: "Supermercato dimostrativo", date: "2026-10-11", totalCents: 1390, currency: "EUR",
  warnings: ["Scontrino dimostrativo: questi dati non provengono dalla tua immagine."],
  items: [
    { description: "Pasta (2 confezioni)", originalText: "2 x PASTA 1,50", quantity: 2, amountCents: 300, kind: "product", category: "Alimentari", confidence: 1, uncertain: false },
    { description: "Detersivo", originalText: "DETERSIVO 4,90", quantity: 1, amountCents: 490, kind: "product", category: "Casa e Pulizia", confidence: 1, uncertain: false },
    { description: "Shampoo", originalText: "SHAMPOO 6,00", quantity: 1, amountCents: 600, kind: "product", category: "Cura della Persona", confidence: 1, uncertain: false },
  ],
};
