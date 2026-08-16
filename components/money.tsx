export function formatAr(value: number | string | null | undefined) {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Number(value ?? 0))} Ar`;
}
export function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}
