// Unica configurazione ufficiale locale, pronta per la scheda Categorie di Google Sheets.
export const categoryDefinitions = [
  {"id": "groceries", "order": 1, "name": "Alimentari", "description": "Supermercato, mercato, alimenti e bevande destinati al consumo domestico.", "color": "#769882", "icon": "bag", "kind": "expense"},
  {"id": "home-cleaning", "order": 2, "name": "Casa e Pulizia", "description": "Detersivi, detergenti, prodotti per la pulizia, carta casa e piccoli articoli domestici.", "color": "#e2b57d", "icon": "home", "kind": "expense"},
  {"id": "health", "order": 3, "name": "Salute e Benessere", "description": "Visite mediche, dentista, farmacia, farmaci e prodotti sanitari.", "color": "#a9b78b", "icon": "heart", "kind": "expense"},
  {"id": "transport", "order": 4, "name": "Trasporti", "description": "Carburante, pedaggi, parcheggi, taxi, sharing e trasporti quotidiani.", "color": "#8faec4", "icon": "car", "kind": "expense"},
  {"id": "personal-care", "order": 5, "name": "Cura della Persona", "description": "Parrucchiere, barbiere, prodotti per l'igiene personale e cosmetica.", "color": "#cf9eaf", "icon": "heart", "kind": "expense"},
  {"id": "social", "order": 6, "name": "Tempo Libero e Socialità", "description": "Ristoranti, bar, aperitivi, cene fuori, colazioni e pause caffè.", "color": "#cc9190", "icon": "coffee", "kind": "expense"},
  {"id": "hobbies", "order": 7, "name": "Hobby e Intrattenimento", "description": "Videogiochi, libri, cinema, concerti, sport e palestre.", "color": "#c9ae73", "icon": "pie", "kind": "expense"},
  {"id": "shopping", "order": 8, "name": "Shopping e Abbigliamento", "description": "Vestiti, scarpe, accessori e piccoli acquisti tecnologici.", "color": "#ada0c9", "icon": "bag", "kind": "expense"},
  {"id": "digital-subscriptions", "order": 9, "name": "Utenze e Abbonamenti digitali", "description": "Bollette di luce, gas e acqua, telefonia, Internet, Netflix, Spotify, Amazon Prime, iCloud e riviste digitali.", "color": "#7faeb1", "icon": "calendar", "kind": "expense"},
  {"id": "travel", "order": 10, "name": "Viaggi e Vacanze", "description": "Weekend, voli, hotel e spostamenti turistici.", "color": "#85a5ce", "icon": "car", "kind": "expense"},
  {"id": "gifts", "order": 11, "name": "Regali e Donazioni", "description": "Festività, compleanni, regali e beneficenza.", "color": "#c59a74", "icon": "heart", "kind": "expense"},
  {"id": "pets", "order": 12, "name": "Animali", "description": "Cibo per animali domestici, crocchette, lettiere, veterinario, medicinali veterinari, antiparassitari, giochi e accessori per animali.", "color": "#ba9876", "icon": "paw", "kind": "expense"},
  {"id": "maintenance-renovations", "order": 13, "name": "Manutenzioni Ristrutturazioni", "description": "Riparazioni, manutenzione e ristrutturazione della casa: lavori, manodopera e materiali edili.", "color": "#a78f76", "icon": "home", "kind": "expense"},
  {"id": "unclassified", "order": 14, "name": "Da classificare", "description": "Solo per spese non classificate con sicurezza.", "color": "#9ba3ae", "icon": "info", "kind": "unclassified"},
 ] as { id: string; order: number; name: string; description: string; color: string; icon: string; kind: "expense" | "unclassified" }[];
export type Category = string;
export type CategoryId = string;
export const categories = categoryDefinitions.map((category) => category.name);
export const expenseCategories = categoryDefinitions.filter((category) => category.kind === "expense");
export const colors = Object.fromEntries(categoryDefinitions.map((c) => [c.name, c.color])) as Record<Category, string>;
export const categoryIcon = Object.fromEntries(categoryDefinitions.map((c) => [c.name, c.icon])) as Record<Category, string>;
export const categoryIds = Object.fromEntries(categoryDefinitions.map((c) => [c.name, c.id])) as Record<Category, CategoryId>;
export const categoriesSheetRows = categoryDefinitions.map((c) => ({
  id: c.id, ordine: c.order, nome: c.name, descrizione: c.description, tipo: c.kind,
}));
// Etichette accettate solo come input storico, mai come categorie attive.
export const legacyIncomeCategories = ["Stipendio", "Altre entrate"] as const;
export const legacySubscriptionCategory = "Abbonamenti Digitali";
// Alias di lettura: gli ID e i dati salvati rimangono invariati.
export function currentCategoryName(value: string): string {
  return value.toLowerCase() === legacySubscriptionCategory.toLowerCase()
    ? "Utenze e Abbonamenti digitali" : value;
}
export type CategoryExtension = { id: string; name: string; description: string };
let catalogRevision = -1;
let catalogScope = "";
export function applyCategoryExtensions(extensions: CategoryExtension[], revision: number, scope = "browser") {
  if (scope !== catalogScope) { catalogRevision = -1; catalogScope = scope; }
  if (revision < catalogRevision) return;
  const base = categoryDefinitions.filter(c => !c.id.startsWith("custom-"));
  if (!Number.isSafeInteger(revision) || revision < 0 || extensions.length > 50
    || extensions.some((c, i) => !/^custom-[a-f0-9-]{36}$/.test(c.id) || !c.name.trim() || c.name.length > 60 || c.description.length > 300
      || [...base.map(c => c.name), ...legacyIncomeCategories, legacySubscriptionCategory, "Shopping", "Casa", "Svago", "Salute", ...extensions.slice(0, i).map(c => c.name)].some(name => name.toLowerCase() === c.name.toLowerCase()))
    || new Set(extensions.map(c => c.id)).size !== extensions.length) throw Error("Catalogo categorie non valido.");
  categoryDefinitions.splice(0, categoryDefinitions.length, ...base, ...extensions.map((c, i) => ({ ...c, order: Math.max(...base.map(c => c.order)) + 1 + i, color: "#769882", icon: "bag", kind: "expense" as const })));
  categories.splice(0, categories.length, ...categoryDefinitions.map(c => c.name));
  expenseCategories.splice(0, expenseCategories.length, ...categoryDefinitions.filter(c => c.kind === "expense"));
  for (const c of categoryDefinitions) { colors[c.name] = c.color; categoryIcon[c.name] = c.icon; categoryIds[c.name] = c.id; }
  categoriesSheetRows.splice(0, categoriesSheetRows.length, ...categoryDefinitions.map(c => ({ id: c.id, ordine: c.order, nome: c.name, descrizione: c.description, tipo: c.kind })));
  catalogRevision = revision;
}
export type HistoricalCategory = Category | "Shopping" | "Casa" | "Svago" | "Salute" | (typeof legacyIncomeCategories)[number];

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && categories.some((category) => category === value);
}
// Il futuro classificatore AI deve usare queste descrizioni come categorie ammesse.
export const classificationInstructions = categoryDefinitions
  .map((c) => `${c.name}: ${c.description}`)
  .join("\n") + "\nClassifica solo spese. Non dedurre gli articoli dal solo negozio. Se la categoria è incerta usa Da classificare.";
export function resolveAIClassification(
  category: unknown,
  confidence: number,
): Category {
  return isCategory(category) && Number.isFinite(confidence) && confidence >= 0.8 && confidence <= 1
    ? category : "Da classificare";
}

// Vista di compatibilità: nessuna mutazione o scrittura sui movimenti originali.
export function normalizeHistoricalTransaction<T extends { category: string; merchant?: string; description?: string; originalCategory?: string }>(transaction: T) {
  const originalCategory = transaction.originalCategory ?? transaction.category;
  let category: Category;
  if (isCategory(transaction.category)) category = transaction.category;
  else if (isCategory(currentCategoryName(transaction.category))) category = currentCategoryName(transaction.category);
  else if (transaction.category === "Shopping") category = "Shopping e Abbigliamento";
  else if (transaction.category === "Salute") category = "Salute e Benessere";
  else {
    const text = `${transaction.description ?? ""} ${transaction.merchant ?? ""}`.toLowerCase();
    const matches = new Set<Category>();
    if (transaction.category === "Casa" || transaction.category === "Svago") {
      if (/\b(crocchette|lettier\w*|veterinar\w*)\b|(?:cibo|giochi|accessori|antiparassitari|medicinali).*(?:animali|cani|gatti|veterinari)/u.test(text)) matches.add("Animali");
      if (/\b(detersiv\w*|detergent\w*|pulizia|candeggina|ammorbident\w*|spugne|lampadine)\b|carta casa/u.test(text)) matches.add("Casa e Pulizia");
      if (/\b(netflix|spotify|icloud)\b|amazon prime|rivist\w* digital/u.test(text)) matches.add("Utenze e Abbonamenti digitali");
      if (/\b(pizzeri\w*|ristorant\w*|bar|aperitiv\w*|caffè|colazione)\b|cena fuori/u.test(text)) matches.add("Tempo Libero e Socialità");
      if (/\b(videogiochi|libri|cinema|concert\w*|palestr\w*)\b/u.test(text)) matches.add("Hobby e Intrattenimento");
      if (/\b(hotel|vacanz\w*)\b|volo turistico/u.test(text)) matches.add("Viaggi e Vacanze");
    }
    category = matches.size === 1 ? [...matches][0] : "Da classificare";
  }
  return { ...transaction, category, originalCategory, needsCategoryReview: category === "Da classificare" };
}
