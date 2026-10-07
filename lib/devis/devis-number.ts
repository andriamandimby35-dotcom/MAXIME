// Numéro d'un devis, comme le numéro de facture (FACT-CODE-01) : DEV-CODE-01.
// Le code est celui du chantier (project_code) ; sans chantier, les 6 premiers caractères de l'identifiant du devis.
// Le numéro reste le même à chaque PDF (pas de compteur à faire avancer, donc rien à écrire dans Supabase).
export function devisNumber(projectCode: string | null | undefined, fallbackId: string, revision = 1): string {
  const code = String(projectCode ?? "").trim() || String(fallbackId).replace(/-/g, "").slice(0, 6);
  return `DEV-${code.toUpperCase()}-${String(revision).padStart(2, "0")}`;
}
