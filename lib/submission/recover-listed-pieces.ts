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
import { extendPagesUntilNextTitle, extractRelevantPageRange, locateTitleAtPageStartsIn, resolveVerifiedPages, scanDividerPages, type DividerPage } from "@/lib/submission/trim-to-relevant-pages";
import type { TemplateDetectedItem } from "@/lib/submission/build-dossier-items";

const SUBMISSION_PART = /march[eé]|formulaire|soumission|mod[eè]le|engagement|contrat|annexe/i;
const NOT_A_SUBMISSION_PART = /sp[eé]cification|technique|r[eè]glement|instruction|bordereau|devis|prix|\bplans?\b|crit[eè]re|cahier des charges/i;
// Étiquette de début de ligne d'une liste de pièces : puce éventuelle puis
// "A-", "B1 :", "Annexe 3", "Annexe 02", "2." ...
// Lettre d'étiquette en MAJUSCULE seulement ("A-", "B1 :") : une lettre
// minuscule ("a.", "b.") est un simple sous-titre de section, pas une pièce.

const LIST_LABEL_NO_LETTER_CASE_FOLD = /^(?:[·•▪●○\-–—*]\s*)?(?:(?:[Aa]nnexe|[Aa]ppendice|[Ff]ormulaire|[Mm]od[eè]le)\s*n?°?\s*\d+|[A-Z]\d{0,2}\s*[-–—:.)]|\d{1,2}\s*[-–—.)])/;
// Étiquette lettre+chiffre d'une pièce ("A1", "B2", "B") : même étiquette =
// même pièce, même si son intitulé est formulé différemment par l'IA ("A1 -
// FICHE DE RENSEIGNEMENTS" / "A1- IDENTIFICATION DU CANDIDAT"). Jamais pour
// "Annexe N" : la numérotation des annexes recommence d'une partie à l'autre.
function letterLabel(title: string): string | null {
  const match = /^\s*([A-Z]\d{0,2})\s*[-–—:.)]/.exec(title);
  return match ? match[1] : null;
}

const MAX_PART_PAGES = 320;
const TIME_BUDGET_MS = 90_000;

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
    if (LIST_LABEL_NO_LETTER_CASE_FOLD.test(line)) entries.push(line);
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
  // Parties de formulaires/marché : toutes leurs lignes de pièces. Parties
  // techniques (spécifications, bordereaux...) : seulement leurs lignes
  // « Annexe N » (planning, liste du personnel, code de conduite... sont des
  // pièces à fournir), jamais leurs « Chapitre N » (texte technique à lire).
  const relevant = allDividers.filter((divider) => !/^\s*r[eè]glement|r[eè]glement de l/i.test(divider.heading));
  if (!relevant.length) return items;
  const startedAt = Date.now();
  const dividerPages = new Set(allDividers.map((divider) => divider.page));
  const result = [...items];
  const knownFirstPages = () => new Set(result.flatMap((item) => knownPagesForItem(item)));
  for (const divider of relevant) {
    const nextDivider = allDividers.map((other) => other.page).filter((page) => page > divider.page).sort((a, b) => a - b)[0];
    // Les pièces d'une partie se trouvent après son intercalaire, avant le
    // suivant (fenêtre plafonnée pour rester rapide sur un gros DAO).
    const last = nextDivider ? nextDivider - 1 : divider.page + MAX_PART_PAGES;
    const windowPages: number[] = [];
    for (let page = divider.page + 1; page <= last; page += 1) windowPages.push(page);
    if (!windowPages.length) continue;
    const wholePartIsSubmission = SUBMISSION_PART.test(divider.heading) && !NOT_A_SUBMISSION_PART.test(divider.heading);
    const entries = listEntries(divider.lines).filter((entry) => wholePartIsSubmission || /^(?:annexe|appendice)\s*\d+/i.test(entry));
    for (const entry of entries) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break; // Meilleur effort : jamais bloquer l'ouverture de la page.
      // Déjà détectée (même titre) : rien à ajouter.
      if (findBestTitleMatch(entry, result)) continue;
      const entryLabel = letterLabel(entry);
      if (entryLabel && result.some((item) => letterLabel(item.title) === entryLabel)) continue;
      try {
        const siblingTitles = result.map((item) => item.title).filter((title) => title.length >= 12);
        let range = await extractRelevantPageRange(pdfBytes, windowPages, entry, { returnEmptyIfNotFound: true, siblingTitles });
        // Titre pas en gras/majuscules sur la vraie page : recherche tolérante
        // limitée aux pages de CETTE partie (jamais l'intercalaire lui-même).
        if (!range.pages.length) range = await locateTitleAtPageStartsIn(pdfBytes, entry, windowPages, siblingTitles);
        if (!range.pages.length) {
          const blind = await resolveVerifiedPages(pdfBytes, [], entry, { siblingTitles });
          if (blind.title && blind.pages.length && blind.pages[0] > divider.page && !dividerPages.has(blind.pages[0])) range = blind;
        }
        if (!range.pages.length) continue; // Titre introuvable dans le DAO : on n'invente rien.
        const start = range.pages[0];
        if (start <= divider.page || dividerPages.has(start)) continue;
        // Déjà couverte par une pièce détectée qui démarre sur cette page.
        if (knownFirstPages().has(start)) continue;
        // Titre retrouvé seulement par la recherche tolérante : on ne connaît
        // que la première page, la pièce en occupe souvent plusieurs (ex.
        // Annexe 2 = pages 48 et 49) : on lit les pages suivantes.
        const pages = range.pages.length > 1
          ? range.pages
          : await extendPagesUntilNextTitle(pdfBytes, start, entry, { siblingTitles, stopPages: dividerPages });
        result.push({
          kind: "document_to_provide",
          title: entry,
          source_reference: pages.length > 1 ? `Pages ${pages[0]}-${pages[pages.length - 1]}` : `Page ${start}`,
          instructions: "Pièce annoncée par le DAO : lisez-la, paraphez ou signez-la si nécessaire, puis joignez-la à votre soumission.",
          required: true,
          fields: [],
          template_origin: "dao",
          template_page_numbers: pages,
        });
      } catch (error) {
        console.error(`[addMissingPiecesListedByDao] ligne ignorée (${entry})`, error);
      }
    }
  }
  return result;
}
