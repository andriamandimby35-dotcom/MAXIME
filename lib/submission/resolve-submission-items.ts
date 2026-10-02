// BUG corrigé (cause racine trouvée après plusieurs correctifs qui
// semblaient "ne pas marcher" en vérification live) : il existait TROIS
// copies quasi identiques de la logique "prendre analysis.submission_items,
// le découper si une pièce IA a fusionné plusieurs pages (splitMergedDaoItems),
// puis nettoyer le résultat (sanitizeSubmissionItems)" —
//   1) app/(dashboard)/tenders/[id]/submission/page.tsx (AFFICHE le dossier)
//   2) app/api/tenders/[id]/submission-dossier/generate/route.ts (ENREGISTRE
//      le dossier dans tender_submission_items)
//   3) app/api/tenders/[id]/printable-submission-document/route.ts (génère le
//      PDF d'UNE pièce à l'impression)
// Un correctif ajouté à sanitizeSubmissionItems avait été répercuté dans (2)
// mais PAS dans (1) — or (1) est la page que Maxime regarde réellement pour
// vérifier le dossier ! Résultat : (2) enregistrait bien des pièces propres
// dans tender_submission_items, mais (1) ignore ces lignes enregistrées (elle
// ne s'en sert QUE pour savoir si un dossier existe déjà, jamais pour les
// afficher) et reconstruit sa PROPRE liste directement depuis
// tenders.ai_analysis, à chaque ouverture de page — sans jamais appliquer le
// nettoyage. Un dossier "regénéré" semblait donc inchangé, alors que
// l'enregistrement en base, lui, avait bien été corrigé.
//
// Plutôt que d'ajouter le nettoyage séparément à (1) (et de laisser le même
// risque de désynchronisation se reproduire au prochain correctif), toute la
// logique commune est regroupée ICI, UNE SEULE FOIS, et (1) et (2) appellent
// désormais cette même fonction. (3) a un usage différent (retrouver le
// modèle d'UNE pièce déjà nommée, pas décider la liste affichée) et n'est pas
// concerné par ce regroupement.
import { splitMergedDaoItems } from "@/lib/submission/split-merged-dao-items";
import { knownPagesForItem } from "@/lib/submission/parse-page-reference";
import { sanitizeSubmissionItems, type WorkItemLike } from "@/lib/submission/sanitize-ai-analysis";
import { resolveFlaggedDuplicateItems } from "@/lib/submission/resolve-duplicate-items";
import type { TemplateDetectedItem } from "@/lib/submission/build-dossier-items";

export type ResolvedSubmissionItems = {
  items: TemplateDetectedItem[];
  removedAsBordereauHeading: string[];
  flaggedDuplicateTitles: string[];
  flaggedDuplicateInstructions: string[];
};

// Calcule la liste FINALE des pièces de soumission à partir de l'analyse IA
// déjà enregistrée (tenders.ai_analysis) : découpe d'abord une pièce fusionnée
// à tort sur plusieurs pages (si nécessaire, coûte un rechargement du DAO),
// puis retire/avertit sur les titres de bordereau et les doublons — toujours
// sur la liste FINALE (après découpage), jamais avant, puisque le découpage
// lui-même peut introduire un doublon de titre (observé en vrai : deux
// morceaux d'une même pièce fusionnée gardant par erreur le même titre).
// Enfin (demande explicite de Maxime : un dossier bon DIRECTEMENT, pas
// seulement signalé comme douteux), on tente de VÉRIFIER et CORRIGER les
// pièces signalées en double directement dans le DAO (voir
// resolve-duplicate-items.ts) — toujours sans appel IA, et seulement quand le
// DAO a déjà dû être rechargé pour une autre raison ou qu'au moins une pièce a
// été signalée, pour ne jamais payer ce coût sur un dossier sans aucun
// doublon.
export async function resolveFinalSubmissionItems(
  rawSubmissionItems: TemplateDetectedItem[],
  workItems: WorkItemLike[],
  documentUrl: string | null | undefined,
): Promise<ResolvedSubmissionItems> {
  const mightHaveMergedItems = rawSubmissionItems.some((item) => item.template_origin === "dao"
    && knownPagesForItem(item).length > 1);
  let items = rawSubmissionItems;
  // Chargé une seule fois, réutilisé pour le découpage ET la vérification des
  // doublons ci-dessous (évite de retélécharger deux fois le même DAO, parfois
  // volumineux, dans le même calcul de liste).
  let pdfBytes: Uint8Array | null = null;
  const loadPdfBytes = async (): Promise<Uint8Array | null> => {
    if (pdfBytes) return pdfBytes;
    if (!documentUrl) return null;
    try {
      const response = await fetch(documentUrl);
      if (response.ok) pdfBytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      // DAO original temporairement inaccessible : les appelants ci-dessous
      // continuent chacun avec leur repli habituel plutôt que d'échouer.
    }
    return pdfBytes;
  };
  if (mightHaveMergedItems) {
    const bytes = await loadPdfBytes();
    if (bytes) items = await splitMergedDaoItems(items, bytes);
  }
  const { items: sanitizedItems, removedAsBordereauHeading, flaggedDuplicateTitles, flaggedDuplicateInstructions } =
    sanitizeSubmissionItems(items, workItems);
  let finalItems: TemplateDetectedItem[] = sanitizedItems as TemplateDetectedItem[];
  // Avant : on ne vérifiait les vraies pages dans le DAO que si le texte
  // avait déjà signalé un doublon. Désormais, resolveFlaggedDuplicateItems
  // vérifie TOUTE pièce d'origine "dao" (voir son commentaire de tête) pour
  // repérer aussi les doublons que le texte seul ne peut pas voir — donc on
  // la lance dès qu'il existe au moins une pièce "dao", pas seulement quand
  // le texte a déjà grogné.
  const hasDaoItems = finalItems.some((item) => item.template_origin === "dao");
  if (hasDaoItems) {
    const bytes = await loadPdfBytes();
    if (bytes) {
      try {
        finalItems = await resolveFlaggedDuplicateItems(finalItems, bytes);
      } catch {
        // Échec inattendu de la vérification : on garde la liste simplement
        // nettoyée/avertie ci-dessus plutôt que de faire échouer tout
        // l'affichage du dossier pour cette seule étape supplémentaire.
      }
    }
  }
  return {
    items: finalItems,
    removedAsBordereauHeading,
    flaggedDuplicateTitles,
    flaggedDuplicateInstructions,
  };
}
