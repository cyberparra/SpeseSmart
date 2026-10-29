const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
export function romeDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function shiftMonth(month: string, offset: number) {
  if (!monthPattern.test(month) || !Number.isInteger(offset)) throw new Error("Mese non valido.");
  const [year, number] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, number - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}
export function monthRange(month: string) {
  const next = shiftMonth(month, 1);
  return { from: `${month}-01`, to: new Date(new Date(`${next}-01T12:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10) };
}
export const monthLabel = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString("it-IT", { timeZone: "Europe/Rome", month: "long", year: "numeric" });
