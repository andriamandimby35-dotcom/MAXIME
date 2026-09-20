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
// données — tant qu'aucun NOUVEAU titre ne prend le relais.
//
// UNE SEULE RÈGLE pour reconnaître un vrai titre de document (à la place de
// plusieurs règles séparées essayées précédemment — Article/Partie/Annexe,
// sous-numérotation, casse seule... — devenues difficiles à suivre même pour
// vérifier le résultat) : sur les DAO observés, un vrai titre de document est
// TOUJOURS écrit à la fois EN MAJUSCULES ET EN GRAS, jamais l'un sans
// l'autre. Une ligne qui ne remplit pas les deux conditions à la fois (un
// numéro d'article, un simple retour à la ligne en milieu de phrase, un
// sommaire, une mention en passant...) ne compte jamais comme un changement
// de document, quel que soit son aspect par ailleurs — elle reste toujours
// une continuation du document en cours, quel que soit le nombre de pages.
const HEADING_SCAN_RUN_COUNT = 8;

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("fr-FR");
}

/** Une ligne réellement en majuscules — sans lettre minuscule, au moins 4 lettres. */
function isFullUppercase(line: string) {
  const letters = line.replace(/[^A-Za-zÀ-ÿ]/g, "");
  return letters.length >= 4 && letters === letters.toLocaleUpperCase("fr-FR") && letters !== letters.toLocaleLowerCase("fr-FR");
}

// Le nom de police d'un texte en gras contient presque toujours "Bold" (ex.
// "ABCDEF+Arial-BoldMT", "TimesNewRomanPS-BoldMT") — pdf.js expose ce nom via
// styles[fontName].fontFamily. Signal fiable pour repérer un VRAI titre de
// document sans deviner sur sa position ou sa formulation exacte.
function looksBold(fontFamily: string | undefined) {
  return Boolean(fontFamily && /bold/i.test(fontFamily));
}

type PageTitle = { titleLine: string | null; heading: string };

// Cherche, dans les toutes premières lignes de la page, la première portion
// de texte à la fois EN MAJUSCULES ET EN GRAS — le vrai titre de la page,
// s'il y en a un — puis y rattache les portions suivantes qui remplissent
// aussi ces deux conditions (un titre peut être coupé sur deux lignes).
// Aucune ligne trouvée : la page n'a pas de titre propre, elle appartient
// donc au document déjà en cours (voir isStopBoundary plus bas).
async function pageHeadingLine(doc: Awaited<ReturnType<typeof getDocument>["promise"]>, pageNumber: number): Promise<PageTitle> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const styles = (content.styles ?? {}) as Record<string, { fontFamily?: string }>;
  type RawItem = { str?: string; fontName?: string };
  const items = (content.items as RawItem[]).filter((item) => (item.str ?? "").trim());
  // La toute première ligne est souvent juste le numéro de page imprimé.
  const withoutPageNumber = items[0] && /^\d{1,4}$/.test((items[0].str ?? "").trim()) ? items.slice(1) : items;
  const zone = withoutPageNumber.slice(0, HEADING_SCAN_RUN_COUNT);
  const isUppercaseRun = (item: RawItem) => isFullUppercase((item.str ?? "").trim());
  const isBoldUppercaseRun = (item: RawItem) => isUppercaseRun(item) && looksBold(item.fontName ? styles[item.fontName]?.fontFamily : undefined);
  // Priorité au signal le plus fiable (majuscules ET gras). Certains DAO ne
  // marquent toutefois JAMAIS le gras dans le nom de police de leur PDF (gras
  // "simulé" sans changer de police, ou export d'un autre logiciel) : sans
  // filet de secours, aucun titre ne serait plus jamais trouvé sur CE DAO
  // précis, ce qui annulerait complètement la détection. Dès qu'AUCUNE ligne
  // en gras+majuscules n'est trouvée dans la zone, on retombe donc sur les
  // majuscules seules (le signal utilisé avec succès avant ce correctif).
  const boldStartIndex = zone.findIndex(isBoldUppercaseRun);
  const isTitleRun = boldStartIndex !== -1 ? isBoldUppercaseRun : isUppercaseRun;
  const startIndex = boldStartIndex !== -1 ? boldStartIndex : zone.findIndex(isUppercaseRun);
  if (startIndex === -1) return { titleLine: null, heading: "" };
  const runs = [zone[startIndex]];
  for (let index = startIndex + 1; index < zone.length && isTitleRun(zone[index]); index += 1) runs.push(zone[index]);
  const titleLine = runs.map((item) => (item.str ?? "").trim()).join(" ");
  return { titleLine, heading: normalizeText(titleLine) };
}

// Renvoie, en plus des pages, le VRAI titre trouvé sur le DAO (tel qu'imprimé
// — majuscules et gras confirmés) : sert à afficher ce titre confirmé dans le
// document final, au lieu de laisser certains PDF générés sans aucun titre
// visible (voir printable-submission-document/route.ts).
export type RelevantPageRange = { pages: number[]; title: string | null };

export async function trimToRelevantStart(pdfBytes: Uint8Array, candidatePages: number[], title: string, claimedByOtherPages?: Set<number>): Promise<RelevantPageRange> {
  return extractRelevantPageRange(pdfBytes, candidatePages, title, { claimedByOtherPages });
}

// Dernier recours quand l'IA n'a retrouvé AUCUNE page pour une pièce
// pourtant quasi toujours présente dans ce genre de DAO (CCAP, plans,
// calendrier cultural, code de conduite...) : au lieu d'abandonner, on
// cherche son titre directement dans TOUT le document, page par page,
// exactement comme extractRelevantPageRange le fait déjà à partir d'une
// plage connue — sauf qu'ici la "plage de départ" est le DAO entier.
// Générique par construction (le titre cherché est un paramètre) : sert
// n'importe quelle pièce, sur n'importe quel DAO, pas seulement le CCAP.
export async function locateTitleInFullDocument(pdfBytes: Uint8Array, title: string, claimedByOtherPages?: Set<number>): Promise<RelevantPageRange> {
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    const allPages = Array.from({ length: doc.numPages }, (_, index) => index + 1);
    return await extractRelevantPageRange(pdfBytes, allPages, title, { returnEmptyIfNotFound: true, claimedByOtherPages });
  } catch {
    return { pages: [], title: null };
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

// Un mot-clé du TITRE demandé peut être au pluriel ("Fiches de
// renseignements du candidat A1 à A5") alors que le vrai titre imprimé sur la
// page DAO est au singulier ("A1 - FICHE DE RENSEIGNEMENTS RELATIFS AU
// CANDIDAT", un -s de différence) — ou l'inverse. Un simple "includes" ne
// voit alors que "renseignements"/"candidat" comme partagés (2 mots sur 3),
// ce qui repasse SOUS le seuil de 85 % et fait déclarer la bonne page
// "non trouvée" à tort. Le pluriel français le plus courant n'ajoute qu'un
// -s final : on accepte donc un mot-clé même quand seule sa forme avec/sans
// ce -s apparaît dans la zone de titre.
function keywordAppearsIn(heading: string, keyword: string) {
  if (heading.includes(keyword)) return true;
  if (keyword.endsWith("s") && keyword.length > 4) return heading.includes(keyword.slice(0, -1));
  return heading.includes(`${keyword}s`);
}

function matchesTitle(heading: string, keywords: string[]) {
  if (!keywords.length) return false;
  const matched = keywords.filter((keyword) => keywordAppearsIn(heading, keyword)).length;
  return matched / keywords.length >= MIN_KEYWORD_MATCH_RATIO;
}

// Une page suivante marque-t-elle un VRAI changement de document (donc la
// fin de la pièce en cours) ? Partagé entre l'extension DANS candidatePages
// et l'extension AU-DELÀ (voir extractRelevantPageRange), pour appliquer
// exactement la même règle unique dans les deux cas : pas de titre (en
// majuscules ET en gras) sur cette page = jamais un arrêt, quel que soit son
// aspect par ailleurs (numéro d'article, saut de page...) ; un vrai titre
// trouvé ne compte comme arrêt que s'il ne correspond pas au sujet en cours.
function isStopBoundary(titleLine: string | null, heading: string, referenceHeading: string, keywords: string[]) {
  if (!titleLine) return false;
  if (heading === referenceHeading) return false; // Même titre répété (ex. en-tête courant) : pas un nouveau document.
  return !matchesTitle(heading, keywords);
}

// Une fois la pièce trouvée, elle continue tant qu'aucun nouveau titre ne
// prend le relais — MÊME au-delà des pages initialement données par l'IA ou
// par le sommaire du DAO (celles-ci ne couvrent pas toujours tout le
// document réel, ex. un formulaire "A1 à A5" dont l'IA n'a cité que la
// première page). MAX_EXTRA_PAGES_BEYOND_CANDIDATES n'est PAS une règle sur
// ce qui compte comme le même document (un document peut légitimement faire
// bien plus de pages) : c'est uniquement un filet de sécurité technique
// contre un balayage interminable si un document est illisible de bout en
// bout. On s'arrête aussi net dès qu'une page est déjà revendiquée par une
// AUTRE pièce déjà identifiée dans ce DAO (claimedByOtherPages).
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
): Promise<RelevantPageRange> {
  if (!candidatePages.length) return { pages: candidatePages, title: null };
  const keywords = [...significantWords(title)].filter((word) => word.length >= 4);
  if (!keywords.length) return { pages: candidatePages, title: null };
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
    // Titre TEL QU'IMPRIMÉ (pas normalisé) sur la page de départ — le vrai
    // titre confirmé du document, à afficher dans le PDF final.
    let detectedTitle: string | null = null;
    for (let index = 0; index < sorted.length; index += 1) {
      const pageNumber = sorted[index];
      if (pageNumber < 1 || pageNumber > doc.numPages) continue;
      try {
        const { heading, titleLine } = await pageHeadingLine(doc, pageNumber);
        if (titleLine && matchesTitle(heading, keywords)) {
          startIndex = index;
          referenceHeading = heading;
          detectedTitle = titleLine;
          break;
        }
      } catch {
        // Page illisible : on continue d'essayer les suivantes.
      }
    }
    // Sujet non trouvé : on ne devine pas. Comportement historique (garder
    // toute la plage de départ) sauf pour une recherche à l'aveugle, où
    // "toute la plage" serait le DAO entier — voir options ci-dessus.
    if (startIndex === -1) return { pages: options.returnEmptyIfNotFound ? [] : candidatePages, title: null };
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
      // l'absence de signal ne suffit plus, il faut un signal positif. Ce
      // garde-fou est indépendant de la règle du titre ci-dessus : il ne
      // concerne que les pages candidates données au départ, jamais
      // l'extension naturelle page après page plus bas.
      const isIsolatedJump = pageNumber - previousPage > 1;
      try {
        const { heading, titleLine } = await pageHeadingLine(doc, pageNumber);
        if (isIsolatedJump) {
          const fullPageHeading = normalizeText((await (await doc.getPage(pageNumber)).getTextContent()).items.map((item) => ("str" in item ? item.str : "")).join(" ").slice(0, 400));
          if (!matchesTitle(fullPageHeading, keywords)) { previousPage = pageNumber; continue; }
        } else if (isStopBoundary(titleLine, heading, referenceHeading, keywords)) {
          stoppedEarly = true;
          break; // Nouveau titre différent : un autre document commence ici.
        }
        kept.push(pageNumber);
        previousPage = pageNumber;
        if (titleLine) referenceHeading = heading;
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
          const { heading, titleLine } = await pageHeadingLine(doc, pageNumber);
          if (isStopBoundary(titleLine, heading, referenceHeading, keywords)) break;
          kept.push(pageNumber);
          if (titleLine) referenceHeading = heading;
        } catch {
          kept.push(pageNumber); // Page illisible au milieu : gardée par prudence, comme ci-dessus.
        }
        pageNumber += 1;
        extraChecked += 1;
      }
    }
    return { pages: kept, title: detectedTitle };
  } catch {
    return { pages: candidatePages, title: null };
  }
}
