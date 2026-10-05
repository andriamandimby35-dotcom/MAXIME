// FILET DE SÉCURITÉ GÉNÉRAL (demandé par Maxime : « la B- Localisation du site
// et l'Annexe 2 sont obligatoires, comment le généraliser ? ») : l'analyse IA
// oublie parfois une pièce que le DAO annonce pourtant lui-même, noir sur
// blanc, sur sa page intercalaire de partie ("PARTIE III – MARCHES ET
// FORMULAIRES : A- Acte d'engagement, B- Localisation du Site (LS), C- CCAP,
// Annexe 1 : ..., Annexe 02 : ..."). Plutôt que de dépendre uniquement de
// l'IA (et de payer une nouvelle analyse à chaque oubli), on relit cette
// liste officielle directement dans le PDF, sans aucun appel IA : pour chaque
// ligne annoncée, on retrouve sa vraie page dans le DAO ; si AUCUNE pièce déjà
// détectée ne correspond (ni par titre, ni par page de départ), la pièce est
// ajoutée à la liste, avec sa vraie page.
//
// Garde-fous (jamais de pièce inventée) :
//  - une ligne annoncée n'est ajoutée QUE si son titre est retrouvé comme
//    vrai titre de page APRÈS l'intercalaire (jamais sur l'intercalaire
//    lui-même, ni sur un autre intercalaire) ;
//  - seules les parties dont le titre parle de marché/formulaires/modèles/
//    soumission/engagement sont lues ; règlement, spécifications techniques,
//    bordereaux, plans et critères sont ignorés (ce ne sont pas des pièces à
//    fournir) ;
//  - une ligne qui ne commence pas par une étiquette de liste (A-, B-,
//    Annexe 3, 2., puce) n'est jamais traitée comme une pièce.
import { findBestTitleMatch } from "@/lib/submission/title-match";
import { knownPagesForItem } from "@/lib/submission/parse-page-reference";
import { extractRelevantPageRange, resolveVerifiedPages, scanDividerPages, type DividerPage } from "@/lib/submission/trim-to-relevant-pages";
import type { TemplateDetectedItem } from "@/lib/submission/build-dossier-items";

const SUBMISSION_PART = /march[eé]|formulaire|soumission|mod[eè]le|engagement|contrat|annexe/i;
const NOT_A_SUBMISSION_PART = /sp[eé]cification|technique|r[eè]glement|instruction|bordereau|devis|prix|\bplans?\b|crit[eè]re|cahier des charges/i;
// Étiquette de début de ligne d'une liste de pièces : puce éventuelle puis
// "A-", "B1 :", "Annexe 3", "Annexe 02", "2." ...
const LIST_LABEL = /^(?:[·•▪●○\-–—*]\s*)?(?:(?:annexe|appendice|formulaire|mod[eè]le)\s*n?°?\s*\d+|[a-z]\d{0,2}\s*[-–—:.)]|\d{1,2}\s*[-–—.)])/i;

function cleanEntryTitle(line: string) {
  return line
    .replace(/^[·•▪●○\-–—*]\s*/, "")
    .replace(/[\s,;.]+$/, "")
    // « Annexe 02 » s'écrit « ANNEXE 2 » sur la page elle-même.
    .replace(/\b0+(\d)\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Réunit les lignes qui continuent la précédente (une ligne qui ne commence
// pas par une étiquette de liste prolonge l'entrée au-dessus).
function listEntries(lines: string[]) {
  const entries: string[] = [];
  for (const line of lines) {
    if (LIST_LABEL.test(line)) entries.push(line);
    else if (entries.length && /^[a-zà-ÿ(]/.test(line)) entries[entries.length - 1] += ` ${line}`;
  }
  return entries.map(cleanEntryTitle).filter((entry) => entry.length >= 6);
}

export async function addMissingPiecesListedByDao(
  items: TemplateDetectedItem[],
  pdfBytes: Uint8Array,
  dividers?: DividerPage[],
): Promise<TemplateDetectedItem[]> {
  const allDividers = dividers ?? await scanDividerPages(pdfBytes);
  const relevant = allDividers.filter((divider) => SUBMISSION_PART.test(divider.heading) && !NOT_A_SUBMISSION_PART.test(divider.heading));
  if (!relevant.length) return items;
  const dividerPages = new Set(allDividers.map((divider) => divider.page));
  const result = [...items];
  const knownFirstPages = () => new Set(result.flatMap((item) => knownPagesForItem(item)));
  for (const divider of relevant) {
    const nextDivider = allDividers.map((other) => other.page).filter((page) => page > divider.page).sort((a, b) => a - b)[0];
    // Les pièces d'une partie se trouvent après son intercalaire, avant le
    // suivant (fenêtre plafonnée pour rester rapide sur un gros DAO).
    const last = Math.min(nextDivider ? nextDivider - 1 : divider.page + 150, divider.page + 150);
    const windowPages: number[] = [];
    for (let page = divider.page + 1; page <= last; page += 1) windowPages.push(page);
    if (!windowPages.length) continue;
    for (const entry of listEntries(divider.lines)) {
      // Déjà détectée (même titre) : rien à ajouter.
      if (findBestTitleMatch(entry, result)) continue;
      try {
        const siblingTitles = result.map((item) => item.title).filter((title) => title.length >= 12);
        let range = await extractRelevantPageRange(pdfBytes, windowPages, entry, { returnEmptyIfNotFound: true, siblingTitles });
        if (!range.pages.length) {
          const blind = await resolveVerifiedPages(pdfBytes, [], entry, { siblingTitles });
          if (blind.title && blind.pages.length && blind.pages[0] > divider.page && !dividerPages.has(blind.pages[0])) range = blind;
        }
        if (!range.pages.length) continue; // Titre introuvable dans le DAO : on n'invente rien.
        const start = range.pages[0];
        if (start <= divider.page || dividerPages.has(start)) continue;
        // Déjà couverte par une pièce détectée qui démarre sur cette page.
        if (knownFirstPages().has(start)) continue;
        result.push({
          kind: "document_to_provide",
          title: entry,
          source_reference: `Page ${start}`,
          instructions: "Pièce annoncée par le DAO : lisez-la, paraphez ou signez-la si nécessaire, puis joignez-la à votre soumission.",
          required: true,
          fields: [],
          template_origin: "dao",
          template_page_numbers: [start],
        });
      } catch (error) {
        console.error(`[addMissingPiecesListedByDao] ligne ignorée (${entry})`, error);
      }
    }
  }
  return result;
}
