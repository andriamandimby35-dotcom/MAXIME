// Jusqu'ici, une pièce détectée en double par sanitizeSubmissionItems (même
// titre et/ou mêmes instructions qu'une autre pièce du DAO) restait affichée
// TELLE QUELLE dans la liste, juste accompagnée d'un avertissement — sans
// jamais corriger quoi que ce soit. Demande explicite de Maxime : que le
// dossier affiché et les PDF générés soient bons DIRECTEMENT après l'analyse,
// pas seulement signalés comme douteux à vérifier à la main.
//
// Correctif, toujours SANS appel IA supplémentaire (coût nul, conforme à la
// règle d'économie de crédits) : pour chaque pièce signalée, on vérifie
// directement dans le vrai DAO (même méthode fiable déjà utilisée ailleurs :
// majuscules + gras retrouvés sur la page, voir trim-to-relevant-pages.ts) où
// se trouve VRAIMENT son titre, même si ça veut dire chercher au-delà de la
// page que l'IA avait donnée.
//   - Si deux pièces signalées en double se vérifient toutes les deux sur la
//     MÊME vraie page du DAO : c'est confirmé, une seule pièce suffit — on ne
//     garde que la première, les autres sont retirées de la liste (vérifié
//     en vrai : "Annexe 1 : Modèle de garantie bancaire de bonne exécution"
//     recopiée 3 fois avec 3 pages fausses différentes (19, 31, 45) se
//     vérifie en réalité UNE SEULE fois, page 47 — les 3 entrées fusionnent
//     en une seule, page corrigée).
//   - Si elles se vérifient sur des pages RÉELLEMENT différentes : fausse
//     alerte, ce sont bien deux pièces distinctes (même titre par
//     coïncidence, ou instructions génériques partagées) — on garde les deux,
//     simplement débarrassées de l'avertissement devenu inutile puisqu'on a
//     pu vérifier directement dans le DAO (vérifié en vrai : "Annexe 7 -
//     Modèle Panneau de chantier" apparaît deux fois à des pages réellement
//     différentes du DAO, toutes les deux légitimes).
//   - Si la vérification échoue (titre introuvable nulle part, DAO
//     temporairement inaccessible) : on ne devine jamais, la pièce garde son
//     avertissement d'origine, par prudence.
import { knownPagesForItem } from "@/lib/submission/parse-page-reference";
import { resolveVerifiedPages } from "@/lib/submission/trim-to-relevant-pages";
import { hasDuplicateWarning, stripDuplicateWarning } from "@/lib/submission/sanitize-ai-analysis";

type DuplicateCandidateItem = {
  title: string;
  instructions?: string;
  template_origin?: string;
  template_page_numbers?: number[];
  source_reference?: string | null;
};

// Même seuil que siblingTitlesFor dans printable-submission-document/route.ts
// (un titre trop court — "A1", "B2"... — matcherait n'importe quoi ailleurs
// sur la page et donnerait de faux arrêts).
const MIN_SIBLING_TITLE_LENGTH = 12;

function siblingTitlesFor(items: DuplicateCandidateItem[], ownTitle: string): string[] {
  const ownNormalized = ownTitle.trim().toLocaleLowerCase("fr-FR");
  return items
    .map((item) => item.title?.trim())
    .filter((otherTitle): otherTitle is string => typeof otherTitle === "string"
      && otherTitle.length >= MIN_SIBLING_TITLE_LENGTH
      && otherTitle.toLocaleLowerCase("fr-FR") !== ownNormalized);
}

export async function resolveFlaggedDuplicateItems<T extends DuplicateCandidateItem>(
  items: T[],
  pdfBytes: Uint8Array,
): Promise<T[]> {
  const flaggedIndexes = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.template_origin === "dao" && hasDuplicateWarning(item.instructions));
  if (!flaggedIndexes.length) return items;

  type Resolved = { startPage: number; pages: number[] };
  const resolved = new Map<number, Resolved>();
  for (const { item, index } of flaggedIndexes) {
    const candidatePages = knownPagesForItem(item);
    if (!candidatePages.length) continue;
    try {
      const result = await resolveVerifiedPages(pdfBytes, candidatePages, item.title, {
        siblingTitles: siblingTitlesFor(items, item.title),
      });
      if (result.title && result.pages.length) {
        resolved.set(index, { startPage: result.pages[0], pages: result.pages });
      }
    } catch {
      // Page illisible ou DAO temporairement inaccessible pour CETTE pièce :
      // elle garde son avertissement d'origine, jamais de supposition.
    }
  }
  if (!resolved.size) return items;

  // Regroupe les pièces signalées dont la vraie page de départ, une fois
  // vérifiée, est identique : vraiment la même pièce détectée plusieurs fois.
  const groups = new Map<number, number[]>();
  for (const [index, info] of resolved) {
    const group = groups.get(info.startPage) ?? [];
    group.push(index);
    groups.set(info.startPage, group);
  }

  const dropped = new Set<number>();
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue; // Vérifiée seule sur sa propre page : pas un doublon réel, voir plus bas.
    // On garde en priorité la pièce dont la page CONNUE D'ORIGINE (celle
    // donnée par l'IA, avant correction) contenait déjà la vraie page — elle
    // n'a pas eu besoin d'être corrigée, donc l'IA avait probablement choisi
    // le titre le plus fidèle pour elle. À défaut, la première du groupe.
    const keepIndex = indexes.find((index) => knownPagesForItem(items[index]).includes(resolved.get(index)!.startPage)) ?? indexes[0];
    for (const index of indexes) if (index !== keepIndex) dropped.add(index);
  }

  const result: T[] = [];
  items.forEach((item, index) => {
    if (dropped.has(index)) return;
    const info = resolved.get(index);
    if (!info) {
      result.push(item);
      return;
    }
    // Vérifiée avec succès (seule sur sa page, ou gardée après fusion) :
    // l'avertissement devenu inutile disparaît, et les pages connues de la
    // pièce sont corrigées sur la vraie page trouvée dans le DAO — pour que
    // la suite (génération du PDF, affichage "Source : p.X") parte
    // directement de la bonne page, sans dépendre d'un second correctif
    // ailleurs. Même format que split-merged-dao-items.ts pour ce champ
    // ("Pages X, Y") : on remplace aussi l'ancienne référence textuelle
    // (ex. "Pages 32, 33", la mauvaise plage) pour qu'elle ne revienne pas
    // contaminer à nouveau le résultat via knownPagesForItem la prochaine
    // fois que cette pièce est relue.
    result.push({
      ...item,
      instructions: stripDuplicateWarning(item.instructions),
      template_page_numbers: info.pages,
      source_reference: `Pages ${info.pages.join(", ")}`,
    });
  });
  return result;
}
