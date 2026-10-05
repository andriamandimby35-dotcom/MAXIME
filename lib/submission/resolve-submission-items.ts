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
import { findSameLabelPairs, mergeRelabeledPiecesUsingDao, mergeSamePieceDuplicates } from "@/lib/submission/merge-same-label-duplicates";
import { createHash } from "crypto";
import { unstable_cache } from "next/cache";
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
async function computeFinalSubmissionItems(
  rawSubmissionItems: TemplateDetectedItem[],
  workItems: WorkItemLike[],
  documentUrl: string | null | undefined,
): Promise<{ value: ResolvedSubmissionItems; degraded: boolean }> {
  // Vrai si le DAO était nécessaire mais n'a pas pu être téléchargé : le
  // résultat est alors un repli partiel, qu'il ne faut JAMAIS mettre en cache
  // (voir resolveFinalSubmissionItems plus bas).
  let degraded = false;
  const mightHaveMergedItems = rawSubmissionItems.some((item) => item.template_origin === "dao"
    && knownPagesForItem(item).length > 1);
  let items = rawSubmissionItems;
  // Chargé une seule fois, réutilisé pour le découpage ET la vérification des
  // doublons ci-dessous (évite de retélécharger deux fois le même DAO, parfois
  // volumineux, dans le même calcul de liste).
  let pdfBytes: Uint8Array | null = null;
  // BUG corrigé (vérifié en vrai : la page du dossier restait bloquée sur
  // "Chargement…" plusieurs minutes, sans jamais afficher ni erreur ni
  // résultat) : ce fetch() n'avait AUCUNE limite de temps — si le
  // téléchargement du DAO (un fichier volumineux) est anormalement lent ou
  // reste bloqué côté réseau, toute la page attendait indéfiniment, bien
  // au-delà du temps que prend normalement l'analyse elle-même (quelques
  // secondes à une trentaine de secondes). On limite désormais ce
  // téléchargement à TIMEOUT_MS : au-delà, on abandonne proprement et les
  // appelants ci-dessous continuent avec leur repli habituel (comme pour tout
  // autre échec de téléchargement), au lieu de bloquer la page indéfiniment.
  // Un message est journalisé pour qu'on puisse repérer ce cas précis dans
  // les journaux Vercel plutôt que de le confondre avec une page simplement
  // lente.
  const PDF_FETCH_TIMEOUT_MS = 90_000;
  // Mesure de temps (diagnostic, visible dans les journaux Vercel) : la page
  // mettait ~35 s à s'ouvrir sans qu'on sache quelle étape était lente
  // (téléchargement du DAO, découpage, ou vérification des doublons).
  const startedAt = Date.now();
  const logStep = (step: string) => console.log(`[resolveFinalSubmissionItems] ${step} : ${Date.now() - startedAt} ms depuis le début`);
  const loadPdfBytes = async (): Promise<Uint8Array | null> => {
    if (pdfBytes) return pdfBytes;
    if (!documentUrl) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(documentUrl, { signal: controller.signal });
      if (response.ok) pdfBytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "AbortError";
      console.error(
        isTimeout
          ? `[resolveFinalSubmissionItems] Téléchargement du DAO abandonné après ${PDF_FETCH_TIMEOUT_MS}ms (documentUrl=${documentUrl})`
          : `[resolveFinalSubmissionItems] Téléchargement du DAO impossible (documentUrl=${documentUrl})`,
        error,
      );
      // DAO original temporairement inaccessible ou trop lent : les
      // appelants ci-dessous continuent chacun avec leur repli habituel
      // plutôt que de bloquer toute la page indéfiniment.
    } finally {
      clearTimeout(timeout);
    }
    logStep(`DAO téléchargé (${pdfBytes ? pdfBytes.length : 0} octets)`);
    return pdfBytes;
  };
  if (mightHaveMergedItems) {
    const bytes = await loadPdfBytes();
    if (bytes) items = await splitMergedDaoItems(items, bytes);
    else degraded = true;
    logStep("découpage des pièces fusionnées terminé");
  }
  const { items: sanitizedItems, removedAsBordereauHeading, flaggedDuplicateTitles, flaggedDuplicateInstructions } =
    sanitizeSubmissionItems(items, workItems);
  let finalItems: TemplateDetectedItem[] = sanitizedItems as TemplateDetectedItem[];
  // IMPORTANT (régression de performance vérifiée en vrai, corrigée) : lancer
  // resolveFlaggedDuplicateItems sur TOUTES les pièces "dao" (sans ce
  // déclencheur) vérifie aussi les pièces jamais retrouvées nulle part dans
  // le DAO (ex. un fragment mal extrait) — chacune d'elles fait alors
  // parcourir le document ENTIER avant de conclure "introuvable", ce qui a
  // fait tourner la page plusieurs minutes en vrai sur Vercel (constaté en
  // direct, pas seulement en théorie). On ne lance donc cette vérification
  // (coûteuse) QUE pour les pièces déjà repérées comme suspectes par le texte
  // (sanitizeSubmissionItems, rapide, sans lire le DAO) — voir
  // sanitize-ai-analysis.ts, dont la détection a été élargie (espace
  // lettre/chiffre) pour repérer aussi les doublons à ponctuation différente
  // sans avoir besoin de vérifier TOUTES les pièces dans le vrai DAO.
  if (flaggedDuplicateTitles.length || flaggedDuplicateInstructions.length) {
    const bytes = await loadPdfBytes();
    if (bytes) {
      try {
        finalItems = await resolveFlaggedDuplicateItems(finalItems, bytes);
      } catch (error) {
        console.error("[resolveFinalSubmissionItems] vérification des doublons échouée", error);
        degraded = true;
        // Échec inattendu de la vérification : on garde la liste simplement
        // nettoyée/avertie ci-dessus plutôt que de faire échouer tout
        // l'affichage du dossier pour cette seule étape supplémentaire.
      }
    } else {
      degraded = true;
    }
  }
  // Dernier filet, texte seul (aucun coût de temps) : même pièce formulée
  // différemment ("Modèle de planning..." / "Planning...", même étiquette).
  finalItems = mergeSamePieceDuplicates(finalItems);
  // Même étiquette ("Annexe 1"), pages différentes, titre complet introuvable
  // sur les pages annoncées mais présent sur celles de l'autre : même pièce
  // mal paginée (voir merge-same-label-duplicates.ts). Ne lit le DAO que s'il
  // existe réellement une telle paire.
  if (findSameLabelPairs(finalItems).length) {
    const bytes = await loadPdfBytes();
    if (bytes) {
      try {
        finalItems = await mergeRelabeledPiecesUsingDao(finalItems, bytes);
      } catch (error) {
        degraded = true;
        console.error("[resolveFinalSubmissionItems] rapprochement des pièces mal paginées échoué", error);
      }
    } else {
      degraded = true;
    }
  }
  logStep("terminé");
  return {
    value: {
      items: finalItems,
      removedAsBordereauHeading,
      flaggedDuplicateTitles,
      flaggedDuplicateInstructions,
    },
    degraded,
  };
}

// À incrémenter à chaque correctif de la logique ci-dessus, pour ne jamais
// resservir un ancien résultat calculé par une version précédente du code.
const RESOLVE_CACHE_VERSION = "2026-10-05-b";

class DegradedResultError extends Error {
  constructor(public readonly value: ResolvedSubmissionItems) {
    super("Résultat partiel (DAO inaccessible), non mis en cache.");
  }
}

// Même résultat qu'avant, mais calculé UNE SEULE FOIS par analyse : la page du
// dossier mettait ~36 s à s'ouvrir à chaque visite (téléchargement de 48 Mo,
// lecture de 268 pages, vérifications dans le DAO), alors que la réponse ne
// change que si l'analyse IA ou ce code changent. La clé de cache est une
// empreinte de TOUT ce qui peut changer le résultat (analyse, bordereau,
// adresse du DAO, version du code) : une nouvelle analyse ou un correctif
// produit une nouvelle clé, donc un nouveau calcul, jamais un vieux résultat.
// Un résultat partiel (DAO inaccessible sur le moment) n'est jamais mis en
// cache : l'erreur lancée à dessein l'en empêche, et on rend le résultat
// partiel tel quel pour cette visite seulement.
export async function resolveFinalSubmissionItems(
  rawSubmissionItems: TemplateDetectedItem[],
  workItems: WorkItemLike[],
  documentUrl: string | null | undefined,
): Promise<ResolvedSubmissionItems> {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([RESOLVE_CACHE_VERSION, rawSubmissionItems, workItems, documentUrl ?? null]))
    .digest("hex");
  const cached = unstable_cache(
    async () => {
      const { value, degraded } = await computeFinalSubmissionItems(rawSubmissionItems, workItems, documentUrl);
      if (degraded) throw new DegradedResultError(value);
      return value;
    },
    ["resolve-final-submission-items", RESOLVE_CACHE_VERSION, fingerprint],
  );
  try {
    return await cached();
  } catch (error) {
    if (error instanceof DegradedResultError) return error.value;
    // Le cache lui-même n'est pas disponible (ex. hors serveur Next) ou le
    // calcul a échoué : on recalcule directement, comme avant l'ajout du cache.
    console.error("[resolveFinalSubmissionItems] cache indisponible, calcul direct", error);
    return (await computeFinalSubmissionItems(rawSubmissionItems, workItems, documentUrl)).value;
  }
}
