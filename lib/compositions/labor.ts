import { canonicalMaterialKey } from "@/lib/material-normalization";

// Postes de main-d'œuvre / de chantier : leur coût est déjà dans les salaires
// journaliers (ou dans les frais généraux), donc on ne cherche AUCUN prix de
// matériaux pour eux. Ils comptent 0 dans le coût interne et ne sont pas
// considérés comme « prix manquants ».
const LABOR_PATTERNS: RegExp[] = [
  /\binstallation (de |du )?chantier\b/,
  /\brepli\b/,
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
