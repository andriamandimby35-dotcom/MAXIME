import { canonicalMaterialKey } from "@/lib/material-normalization";

// Postes de pure main-d'œuvre : leur coût est déjà dans les salaires
// journaliers, donc on ne cherche AUCUN prix de matériaux pour eux. Ils comptent
// 0 dans le coût interne et ne sont pas considérés comme « prix manquants ».
// L'installation et le repli de chantier n'en font PAS partie : ils coûtent
// (baraquement, clôture, branchements, transport des engins…) et leur prix se
// cherche dans la bibliothèque puis sur internet, comme une fourniture.
const LABOR_PATTERNS: RegExp[] = [
  /\bdepose\b/,
  /\bdemolition\b/,
  /\bevacuation (des |de |du )?(gravois|deblais|decombres|dechets|materiaux|terres|remblais)\b/,
  /\bnettoyage\b/,
  /\bpiquetage\b/,
  /\bimplantation\b/,
  /\bdebroussaillage\b/,
  /\bdecapage\b/,
];

export function isLaborLine(designation: string | null | undefined) {
  const key = canonicalMaterialKey(String(designation ?? ""));
  if (!key) return false;
  return LABOR_PATTERNS.some((pattern) => pattern.test(key));
}
