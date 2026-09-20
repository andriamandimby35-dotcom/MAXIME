import "@/lib/submission/pdfjs-worker-setup";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { significantWords } from "@/lib/submission/title-match";

// Une plage de pages tirée d'une référence textuelle ("Pages 31-46, Partie
// III") ou de numéros extraits par l'IA peut englober plusieurs documents à
// la suite (table des matières, un autre modèle, PUIS la pièce demandée), OU
// au contraire être trop courte (l'IA ne cite parfois qu'UNE seule page pour
// une pièce qui s'étale en réalité sur plusieurs pages, ex. un formulaire
// "A1 à A5"). Logique générale (valable pour toute pièce, pas seulement CCAP
// ou les plans) : on part de la page qui nomme vraiment le sujet dans son
// propre titre, puis on avance — même au-delà des pages initialement
// données — tant qu'aucun NOUVEAU titre ne prend le relais. Un titre est
// presque toujours en majuscules dans ce genre de DAO, mais pas
// systématiquement (constaté : "Annexe 2" / calendrier cultural d'un DAO
// réel a un titre en casse normale) — on ne peut donc pas exiger la casse ;
// le signal fiable est qu'une ligne de titre est courte et ne se termine
// jamais comme une phrase (pas de ponctuation de fin).
//
// La "zone de titre" utilisée pour comparer les mots-clés ne prend que les
// 2 premières lignes de la page (un titre peut être coupé sur deux lignes),
// jamais tout le haut de la page : sinon un simple sommaire ("a. MODELES DE
// FICHES DE RENSEIGNEMENTS...") glissé sous un AUTRE titre ("PARTIE II —
// FORMULAIRES DE SOUMISSION") se faisait passer à tort pour le vrai début du
// document "Fiches de renseignements..." — constaté sur un DAO réel.
const HEADING_LINE_COUNT = 2;

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
  const headingZone = withoutPageNumber.slice(0, HEADING_LINE_COUNT).join(" ");
  return { firstLine, isHeading: isUppercaseHeading(firstLine), heading: normalizeText(headingZone) };
}

export async function trimToRelevantStart(pdfBytes: Uint8Array, candidatePages: number[], title: string, claimedByOtherPages?: Set<number>): Promise<number[]> {
  const range = await extractRelevantPageRange(pdfBytes, candidatePages, title, { claimedByOtherPages });
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
export async function locateTitleInFullDocument(pdfBytes: Uint8Array, title: string, claimedByOtherPages?: Set<number>): Promise<number[]> {
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    const allPages = Array.from({ length: doc.numPages }, (_, index) => index + 1);
    return await extractRelevantPageRange(pdfBytes, allPages, title, { returnEmptyIfNotFound: true, claimedByOtherPages });
  } catch {
    return [];
  }
}

/**
 * Trouve, dans candidatePages (élargi aux pages voisines, voir plus bas), la
 * page qui nomme vraiment "title" dans son propre titre, puis prend toutes
 * les pages suivantes — y compris AU-DELÀ de candidatePages, dans le
 * document réel — tant qu'aucun NOUVEAU titre différent n'apparaît.
 */
// Un ou deux mots-clés partagés peuvent être un faux ami (ex. "cahier" seul
// matche aussi bien "CCAP / Cahier des Clauses..." qu'un simple "cahier des
// charges" mentionné en corps de texte sur une page totalement différente,
// constaté sur un DAO réel : la page B- LOCALISATION DU SITE, qui précède le
// vrai CCAP, était ainsi prise à tort pour son début ; et "fiches" +
// "renseignements" seuls ont aussi fait confondre un simple sommaire listant
// "MODELES DE FICHES DE RENSEIGNEMENTS" avec le vrai début du formulaire).
// On exige donc de retrouver PRESQUE TOUS les mots-clés du titre — pas
// forcément le titre mot pour mot (un DAO peut l'écrire avec un accent, une
// ponctuation ou un mot en plus/en moins différent de celui donné par
// l'IA), mais assez pour exclure une simple mention en passant.
const MIN_KEYWORD_MATCH_RATIO = 0.85;

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

// Une page suivante marque-t-elle un VRAI changement de document (donc la
// fin de la pièce en cours) ? Partagé entre l'extension DANS candidatePages
// et l'extension AU-DELÀ (voir extractRelevantPageRange), pour appliquer
// exactement la même règle dans les deux cas : un article/une clause
// numéroté(e) ne compte jamais comme un arrêt, seul un vrai nouveau titre
// (différent du sujet recherché) en compte un.
function isStopBoundary(firstLine: string, heading: string, referenceHeading: string, keywords: string[]) {
  const isBoundaryCandidate = isStrictUppercaseHeading(firstLine) || isSubsectionContinuation(firstLine) || isNewChapterMarker(firstLine);
  if (!isBoundaryCandidate || heading === referenceHeading || matchesTitle(heading, keywords)) return false;
  return isNewChapterMarker(firstLine) || !isSubsectionContinuation(firstLine);
}

// Une fois la pièce trouvée, elle continue tant qu'aucun nouveau titre ne
// prend le relais — MÊME au-delà des pages initialement données par l'IA ou
// par le sommaire du DAO (celles-ci ne couvrent pas toujours tout le
// document réel, ex. un formulaire "A1 à A5" dont l'IA n'a cité que la
// première page). On plafonne cette extension pour éviter un balayage
// interminable en cas de document illisible, et on s'arrête net dès qu'une
// page est déjà revendiquée par une AUTRE pièce déjà identifiée dans ce DAO
// (claimedByOtherPages), pour ne jamais avaler par erreur son contenu.
const MAX_EXTRA_PAGES_BEYOND_CANDIDATES = 60;

export async function extractRelevantPageRange(
  pdfBytes: Uint8Array,
  candidatePages: number[],
  title: string,
  options: {
    // Les deux appels historiques (trimToRelevantStart, et la référence
    // textuelle du DAO dans printable-submission-document) partent d'une
    // plage déjà probablement correcte (page citée par l'IA ou par le
    // sommaire) : si le titre n'y est finalement pas retrouvé, mieux vaut
    // rester sur cette plage de départ que de ne rien renvoyer du tout.
    // locateTitleInFullDocument (recherche à l'aveugle sur TOUT le DAO,
    // sans aucun indice de page au départ) a besoin du signal inverse :
    // rien trouvé doit vouloir dire rien à imprimer, jamais "tout le DAO".
    returnEmptyIfNotFound?: boolean;
    // Pages déjà revendiquées par une AUTRE pièce déjà identifiée dans ce
    // DAO (voir pagesNotClaimedByOtherItems côté appelant) : sert de
    // garde-fou pendant l'extension au-delà de candidatePages, pour ne
    // jamais avaler par erreur le début d'un autre document déjà repéré.
    claimedByOtherPages?: Set<number>;
  } = {},
): Promise<number[]> {
  if (!candidatePages.length) return candidatePages;
  const keywords = [...significantWords(title)].filter((word) => word.length >= 4);
  if (!keywords.length) return candidatePages;
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    // La page citée par l'IA (ou par le sommaire du DAO) peut être décalée
    // d'une unité (pagination différente entre le PDF et le sommaire, ou
    // simple erreur de l'IA) : on vérifie donc aussi la page juste avant et
    // juste après chaque page donnée, en plus de celle-ci — jamais à la
    // place, seulement en plus — avant de chercher le titre.
    const widened = new Set<number>();
    for (const page of candidatePages) for (const neighbor of [page - 1, page, page + 1]) if (neighbor >= 1) widened.add(neighbor);
    const sorted = [...widened].sort((a, b) => a - b);
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
    let stoppedEarly = false;
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
        } else if (isStopBoundary(firstLine, heading, referenceHeading, keywords)) {
          stoppedEarly = true;
          break; // Nouveau titre différent : un autre document (ou chapitre) commence ici.
        }
        kept.push(pageNumber);
        previousPage = pageNumber;
        if (isHeading) referenceHeading = heading;
      } catch {
        if (!isIsolatedJump) kept.push(pageNumber); // Page illisible au milieu d'un groupe contigu : gardée par prudence.
        previousPage = pageNumber;
      }
    }
    // On a épuisé toutes les pages DONNÉES sans rencontrer de nouveau titre :
    // rien ne dit que le document s'arrête vraiment là, l'IA (ou le
    // sommaire) n'a peut-être simplement pas cité toutes ses pages (ex. un
    // formulaire "A1 à A5" dont seule la première page A1 a été citée). On
    // continue alors à lire les VRAIES pages suivantes du document, avec
    // exactement la même règle d'arrêt, jusqu'à un nouveau titre, une page
    // déjà revendiquée par une autre pièce, la fin du document, ou une
    // limite de sécurité.
    if (!stoppedEarly) {
      let extraChecked = 0;
      let pageNumber = previousPage + 1;
      while (pageNumber <= doc.numPages && extraChecked < MAX_EXTRA_PAGES_BEYOND_CANDIDATES) {
        if (options.claimedByOtherPages?.has(pageNumber)) break;
        try {
          const { firstLine, heading, isHeading } = await pageHeadingLine(doc, pageNumber);
          if (isStopBoundary(firstLine, heading, referenceHeading, keywords)) break;
          kept.push(pageNumber);
          if (isHeading) referenceHeading = heading;
        } catch {
          kept.push(pageNumber); // Page illisible au milieu : gardée par prudence, comme ci-dessus.
        }
        pageNumber += 1;
        extraChecked += 1;
      }
    }
    return kept;
  } catch {
    return candidatePages;
  }
}
