// Types et textes partagés (serveur + navigateur) pour la suppression en chaîne
// DAO -> devis -> chantier -> dépenses -> facturation.

export type DeletionKind = "tender" | "estimate" | "project";

export type ProjectImpact = {
  id: string;
  name: string;
  expenses: number; // saisies de dépenses (achats, salaires, présences)
  unpaidClaims: number; // factures non payées (supprimées)
  paidClaims: number; // factures payées (GARDÉES, archivées)
  payments: number; // paiements supprimés (ceux des factures payées sont gardés)
};

export type DeletionPreview = {
  kind: DeletionKind;
  name: string;
  estimates: string[]; // devis supprimés avec le DAO / le devis
  projects: ProjectImpact[];
  paidKept: number;
  needsTyping: boolean; // true = il faut taper SUPPRIMER pour confirmer
};

export const CONFIRM_WORD = "SUPPRIMER";

export function describePreview(preview: DeletionPreview): string[] {
  const lines: string[] = [];
  if (preview.kind === "tender") lines.push(`Le DAO « ${preview.name} » sera supprimé.`);
  if (preview.kind === "estimate") lines.push(`Le devis « ${preview.name} » sera supprimé.`);
  if (preview.kind === "project") lines.push(`Le chantier « ${preview.name} » sera supprimé.`);
  if (preview.estimates.length > 0) lines.push(`${preview.estimates.length} devis supprimé(s) avec lui.`);
  for (const project of preview.projects) {
    const parts: string[] = [];
    if (project.expenses > 0) parts.push(`${project.expenses} saisie(s) de dépenses`);
    if (project.unpaidClaims > 0) parts.push(`${project.unpaidClaims} facture(s) non payée(s)`);
    if (project.payments > 0) parts.push(`${project.payments} paiement(s)`);
    parts.push("planning, rapports, photos et stocks");
    lines.push(`${preview.kind === "project" ? "Avec lui" : `Chantier « ${project.name} »`} : ${parts.join(", ")} supprimé(s).`);
  }
  if (preview.paidKept > 0) lines.push(`${preview.paidKept} facture(s) PAYÉE(S) seront GARDÉES dans les « Factures archivées ».`);
  return lines;
}
