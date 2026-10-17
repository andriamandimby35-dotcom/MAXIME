import { canonicalMaterialKey } from "@/lib/material-normalization";
import { manualWorkFor } from "@/lib/compositions/manual-work";

// Postes de pure main-d'œuvre : leur coût est déjà dans les salaires
// journaliers, donc on ne cherche AUCUN prix de matériaux pour eux. Ils comptent
// 0 dans le coût interne et ne sont pas considérés comme « prix manquants ».
// Les travaux manuels sans matériau (fouille, déblai, remblai à la main, décapage…)
// et l'installation / repli de chantier en font aussi partie : 0 en interne.
// Leur prix pour le client (devis externe) est calculé à part, voir manual-work.ts.
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

export function isLaborLine(designation: string | null | undefined, unit?: string | null) {
  const key = canonicalMaterialKey(String(designation ?? ""));
  if (!key) return false;
  if (LABOR_PATTERNS.some((pattern) => pattern.test(key))) return true;
  return manualWorkFor(String(designation ?? ""), String(unit ?? "")) !== null;
}
