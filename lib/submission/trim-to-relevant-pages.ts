import "@/lib/submission/pdfjs-worker-setup";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { significantWords } from "@/lib/submission/title-match";

// Une plage de pages tirée d'une référence textuelle ("Pages 31-46, Partie
// III") ou de numéros extraits par l'IA peut englober plusieurs documents à
// la suite (table des matières, un autre modèle, PUIS la pièce demandée).
// Logique générale (valable pour toute pièce, pas seulement CCAP ou les
// plans) : tant que le titre en tête de page ne change pas, la page
// appartient au même groupe ; dès qu'un NOUVEAU titre apparaît, c'est un
// autre document. On part donc de la page qui nomme vraiment le sujet dans
// son propre titre, puis on avance tant qu'aucun autre titre ne prend le
// relais. Un titre est presque toujours en majuscules dans ce genre de DAO,
// mais pas systématiquement (constaté : "Annexe 2" / calendrier cultural
// d'un DAO réel a un titre en casse normale) — on ne peut donc pas exiger la
// casse ; le signal fiable est qu'une ligne de titre est courte et ne se
// termine jamais comme une phrase (pas de ponctuation de fin).
const HEADING_ZONE_LENGTH = 100;

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("fr-FR");
}

/** Une ligne "titre" est courte et ne se termine pas comme une phrase — la
 * casse (majuscule ou non) n'est qu'une indication, jamais une condition.
 * Signal volontairement large : sert seulement à REPÉRER le début (une
 * recherche rare, déjà protégée par la comparaison de mots-clés ci-dessous),
 * jamais à décider un arrêt — un simple retour à la ligne au milieu d'une
 * phrase ("...tion sera faite des acomptes...") passerait aussi ce test. */
function isUppercaseHeading(line: string) {
  const trimmed = line.trim();
  const letters = trimmed.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length < 4 || trimmed.length > 100) return false;
  return !/[.,;]\s*$/.test(trimmed);
}

/** Une ligne réellement en majuscules — signal fort, sans faux positif possible sur du texte courant. */
function isStrictUppercaseHeading(line: string) {
  const trimmed = line.trim();
  const letters = trimmed.replace(/[^A-Za-zÀ-ÿ]/g, "");
  return letters.length >= 4 && letters === letters.toLocaleUpperCase("fr-FR") && letters !== letters.toLocaleLowerCase("fr-FR");
}

async function pageHeadingLine(doc: Awaited<ReturnType<typeof getDocument>["promise"]>, pageNumber: number) {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const lines = (content.items as Array<{ str?: string }>)
    .map((item) => (item.str ?? "").trim())
    .filter(Boolean);
  // La toute première ligne est souvent juste le numéro de page imprimé.
  const withoutPageNumber = lines[0] && /^\d{1,4}$/.test(lines[0]) ? lines.slice(1) : lines;
  const firstLine = withoutPageNumber[0] ?? "";
  const fullText = withoutPageNumber.join(" ");
  return { firstLine, isHeading: isUppercaseHeading(firstLine), heading: normalizeText(fullText.slice(0, HEADING_ZONE_LENGTH)) };
}

export async function trimToRelevantStart(pdfBytes: Uint8Array, candidatePages: number[], title: string): Promise<number[]> {
  const range = await extractRelevantPageRange(pdfBytes, candidatePages, title);
  return range;
}

// Dernier recours quand l'IA n'a retrouvé AUCUNE page pour une pièce
// pourtant quasi toujours présente dans ce genre de DAO (CCAP, plans,
// calendrier cultural, code de conduite...) : au lieu d'abandonner, on
// cherche son titre directement dans TOUT le document, page par page,
// exactement comme extractRelevantPageRange le fait déjà à partir d'une
// plage connue — sauf qu'ici la "plage de départ" est le DAO entier.
// Générique par construction (le titre cherché est un paramètre) : sert
// n'importe quelle pièce, sur n'importe quel DAO, pas seulement le CCAP.
export async function locateTitleInFullDocument(pdfBytes: Uint8Array, title: string): Promise<number[]> {
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    const allPages = Array.from({ length: doc.numPages }, (_, index) => index + 1);
    return await extractRelevantPageRange(pdfBytes, allPages, title, { returnEmptyIfNotFound: true });
  } catch {
    return [];
  }
}

/**
 * Trouve, dans candidatePages, la page qui nomme vraiment "title" dans son
 * propre titre (en majuscules), puis prend toutes les pages suivantes tant
 * qu'aucun NOUVEAU titre en majuscules différent n'apparaît.
 */
// Un seul mot-clé partagé peut être un faux ami (ex. "cahier" seul matche
// aussi bien "CCAP / Cahier des Clauses..." qu'un simple "cahier des
// charges" mentionné en corps de texte sur une page totalement différente,
// constaté sur un DAO réel : la page B- LOCALISATION DU SITE, qui précède le
// vrai CCAP, était ainsi prise à tort pour son début). On exige donc qu'une
// bonne PART des mots-clés du titre soit retrouvée, pas un seul mot isolé.
const MIN_KEYWORD_MATCH_RATIO = 0.6;

function matchesTitle(heading: string, keywords: string[]) {
  if (!keywords.length) return false;
  const matched = keywords.filter((keyword) => heading.includes(keyword)).length;
  return matched / keywords.length >= MIN_KEYWORD_MATCH_RATIO;
}

// Un CCAP (et les documents contractuels similaires) s'organise en Articles
// et clauses numérotées (Article 4, 5.6, 6.3.1...) qui appartiennent tous au
// MÊME chapitre : chacune ressemble à "un nouveau titre différent" alors que
// ce n'est qu'une sous-partie du même document, jamais un signal d'arrêt. Un
// VRAI changement de document est marqué par un repère de niveau supérieur
// (PARTIE, ANNEXE, CHAPITRE, ou une nouvelle lettre de chapitre A-/B-/C-...).
function isSubsectionContinuation(line: string) {
  return /^(article\s*\d|\d+(?:\.\d+){0,3}\s*[-–.])/i.test(line.trim());
}
function isNewChapterMarker(line: string) {
  const trimmed = line.trim();
  return /^(partie|annexe|chapitre)\b/i.test(trimmed) || /^[a-z][-–.]\s/i.test(trimmed);
}

export async function extractRelevantPageRange(
  pdfBytes: Uint8Array,
  candidatePages: number[],
  title: string,
  // Les deux appels historiques (trimToRelevantStart, et la référence
  // textuelle du DAO dans printable-submission-document) partent d'une
  // plage déjà probablement correcte (page citée par l'IA ou par le
  // sommaire) : si le titre n'y est finalement pas retrouvé, mieux vaut
  // rester sur cette plage de départ que de ne rien renvoyer du tout.
  // locateTitleInFullDocument (recherche à l'aveugle sur TOUT le DAO,
  // sans aucun indice de page au départ) a besoin du signal inverse :
  // rien trouvé doit vouloir dire rien à imprimer, jamais "tout le DAO".
  options: { returnEmptyIfNotFound?: boolean } = {},
): Promise<number[]> {
  if (!candidatePages.length) return candidatePages;
  const keywords = [...significantWords(title)].filter((word) => word.length >= 4);
  if (!keywords.length) return candidatePages;
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    const sorted = [...candidatePages].sort((a, b) => a - b);
    let startIndex = -1;
    let referenceHeading = "";
    for (let index = 0; index < sorted.length; index += 1) {
      const pageNumber = sorted[index];
      if (pageNumber < 1 || pageNumber > doc.numPages) continue;
      try {
        const { heading, isHeading } = await pageHeadingLine(doc, pageNumber);
        if (isHeading && matchesTitle(heading, keywords)) {
          startIndex = index;
          referenceHeading = heading;
          break;
        }
      } catch {
        // Page illisible : on continue d'essayer les suivantes.
      }
    }
    // Sujet non trouvé : on ne devine pas. Comportement historique (garder
    // toute la plage de départ) sauf pour une recherche à l'aveugle, où
    // "toute la plage" serait le DAO entier — voir options ci-dessus.
    if (startIndex === -1) return options.returnEmptyIfNotFound ? [] : candidatePages;
    const kept = [sorted[startIndex]];
    let previousPage = sorted[startIndex];
    for (let index = startIndex + 1; index < sorted.length; index += 1) {
      const pageNumber = sorted[index];
      if (pageNumber < 1 || pageNumber > doc.numPages) break;
      // Une page candidate ISOLÉE (un grand saut depuis la précédente, ex.
      // 16 puis 267 pour une simple mention "image finale p.267") n'est
      // presque jamais une vraie continuation physique du document : par
      // défaut on continuerait "faute de signal d'arrêt", ce qui a déjà
      // laissé passer une page totalement étrangère au sujet (le Code de
      // Conduite, référencé par erreur par l'IA comme page de A3). On exige
      // donc ici un vrai mot-clé du sujet retrouvé sur CETTE page précise —
      // l'absence de signal ne suffit plus, il faut un signal positif.
      const isIsolatedJump = pageNumber - previousPage > 1;
      try {
        const { firstLine, heading, isHeading } = await pageHeadingLine(doc, pageNumber);
        if (isIsolatedJump) {
          const fullPageHeading = normalizeText((await (await doc.getPage(pageNumber)).getTextContent()).items.map((item) => ("str" in item ? item.str : "")).join(" ").slice(0, 400));
          if (!matchesTitle(fullPageHeading, keywords)) { previousPage = pageNumber; continue; }
        } else {
          // Un simple retour à la ligne au milieu d'une phrase peut
          // ressembler à "un titre" (court, sans ponctuation de fin) sans en
          // être un : seule une VRAIE frontière de structure (majuscules,
          // article/clause numéroté, ou repère de chapitre) compte pour
          // décider d'arrêter ou de continuer — un texte courant ne l'est pas.
          const isBoundaryCandidate = isStrictUppercaseHeading(firstLine) || isSubsectionContinuation(firstLine) || isNewChapterMarker(firstLine);
          if (isBoundaryCandidate && heading !== referenceHeading && !matchesTitle(heading, keywords)) {
            if (isNewChapterMarker(firstLine) || !isSubsectionContinuation(firstLine)) {
              break; // Nouveau titre différent : un autre document (ou chapitre) commence ici.
            }
            // Une clause/article numéroté(e) reste dans le même document : on avance sans y voir un arrêt.
          }
        }
        kept.push(pageNumber);
        previousPage = pageNumber;
        if (isHeading) referenceHeading = heading;
      } catch {
        if (!isIsolatedJump) kept.push(pageNumber); // Page illisible au milieu d'un groupe contigu : gardée par prudence.
        previousPage = pageNumber;
      }
    }
    return kept;
  } catch {
    return candidatePages;
  }
}
