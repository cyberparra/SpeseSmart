import type { HistoricalCategory } from "./categories";
export type Expense = {
  id: string;
  merchant: string;
  date: string;
  category: HistoricalCategory;
  amount: number;
  source: string;
  originalCategory?: string;
  documentId?: string;
  sheetsDocumentId?: string;
  description?: string;
  demo?: boolean;
  notes?: string;
  type?: string;
  tipo?: string;
  direction?: string;
  kind?: string;
  categoryId?: string;
};
export const money = (n: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(
    n,
  );
export const demoExpenses: Expense[] = [
  {
    id: "1",
    merchant: "Esselunga",
    date: "2026-10-11",
    category: "Alimentari",
    amount: 64.8,
    source: "Scontrino",
  },
  {
    id: "2",
    merchant: "Amazon",
    date: "2026-10-10",
    category: "Shopping",
    amount: 39.99,
    source: "Screenshot",
  },
  {
    id: "3",
    merchant: "Pizzeria da Michele",
    date: "2026-10-10",
    category: "Svago",
    amount: 32,
    source: "Manuale",
  },
  {
    id: "4",
    merchant: "Eni Station",
    date: "2026-10-09",
    category: "Trasporti",
    amount: 50,
    source: "Scontrino",
  },
  {
    id: "5",
    merchant: "Spotify",
    date: "2026-10-08",
    category: "Svago",
    amount: 10.99,
    source: "Manuale",
  },
  {
    id: "6",
    merchant: "Affitto",
    date: "2026-10-01",
    category: "Casa",
    amount: 650,
    source: "Manuale",
  },
  {
    id: "7",
    merchant: "Coop",
    date: "2026-10-03",
    category: "Alimentari",
    amount: 98.5,
    source: "Scontrino",
  },
  {
    id: "8",
    merchant: "Farmacia Centrale",
    date: "2026-10-04",
    category: "Salute",
    amount: 26.4,
    source: "Manuale",
  },
  {
    id: "9",
    merchant: "Zara",
    date: "2026-10-06",
    category: "Shopping",
    amount: 79.9,
    source: "Manuale",
  },
  {
    id: "10",
    merchant: "Trenitalia",
    date: "2026-10-07",
    category: "Trasporti",
    amount: 24.5,
    source: "Screenshot",
  },
  {
    id: "11",
    merchant: "Coop",
    date: "2026-10-05",
    category: "Alimentari",
    amount: 71.2,
    source: "Scontrino",
  },
  {
    id: "12",
    merchant: "Affitto",
    date: "2026-09-01",
    category: "Casa",
    amount: 650,
    source: "Manuale",
  },
  {
    id: "13",
    merchant: "Spesa di settembre",
    date: "2026-09-15",
    category: "Alimentari",
    amount: 380,
    source: "Manuale",
  },
  {
    id: "14",
    merchant: "Acquisti di settembre",
    date: "2026-09-20",
    category: "Shopping",
    amount: 310,
    source: "Manuale",
  },
  {
    id: "15",
    merchant: "Abbonamento mezzi",
    date: "2026-09-04",
    category: "Trasporti",
    amount: 120,
    source: "Manuale",
  },
];
