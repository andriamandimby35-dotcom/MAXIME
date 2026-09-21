import "@/lib/submission/pdfjs-worker-setup";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

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

// Certains DAO (contrats-cadres de fournitures notamment) ne mettent JAMAIS
// leurs titres de pièce en majuscules ("Annexe 1", "Annexe 2 : Bordereau De
// Prix Unitaires...") : seule une couleur distincte (bleu, le plus souvent)
// les distingue du corps de texte, toujours noir. isFullUppercase/looksBold
// seuls ne les voient donc jamais. pdf.js ne donne pas la couleur directement
// dans getTextContent() (aucune clé "color" sur un TextItem) : on la
// retrouve en rejouant la liste d'opérateurs de la page (getOperatorList),
// qui contient un ordre de dessin identique à celui des items de texte —
// chaque "showText" y est précédé de l'instruction de couleur de remplissage
// en vigueur à ce moment (setFillRGBColor le plus souvent). On associe donc,
// dans l'ORDRE, chaque item de texte non vide au N-ième "showText" rencontré
// — un léger décalage est possible sur de rares pages (quelques opérations
// de dessin sans texte associé), sans conséquence pratique : ce signal ne
// sert qu'en dernier recours, jamais comme seule source de vérité.
async function buildItemColorMap<T extends { str?: string }>(page: Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>["promise"]>["getPage"]>>, items: T[]): Promise<Map<T, string>> {
  // Indexé par référence d'objet (pas par position numérique) : le tableau
  // "zone" passé par l'appelant est un sous-ensemble filtré/tronqué de
  // "items" (items vides retirés, éventuel numéro de page en tête retiré) —
  // une correspondance par simple décalage numérique serait fausse dès qu'un
  // seul item vide a été filtré avant la zone de titre.
  const colorByItem = new Map<T, string>();
  try {
    const opList = await page.getOperatorList();
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const OPS = (pdfjsLib as unknown as { OPS: Record<string, number> }).OPS;
    const opNames = new Map<number, string>();
    for (const key of Object.keys(OPS)) opNames.set(OPS[key], key);
    let currentColor: string | null = null;
    const colorPerShow: (string | null)[] = [];
    for (let index = 0; index < opList.fnArray.length; index += 1) {
      const name = opNames.get(opList.fnArray[index]);
      if (name === "setFillRGBColor" && typeof opList.argsArray[index]?.[0] === "string") {
        currentColor = opList.argsArray[index][0];
      } else if (name === "setFillColorN" || name === "setFillGray" || name === "setFillCMYKColor" || name === "setFillColorSpace") {
        // Espace de couleur non directement convertible ici : signal inconnu
        // plutôt qu'une fausse couleur — jamais traité comme "coloré".
        currentColor = null;
      } else if (name === "showText" || name === "showSpacedText") {
        colorPerShow.push(currentColor);
      }
    }
    let showIndex = 0;
    for (const item of items) {
      if (!(item.str ?? "").trim()) continue;
      if (showIndex < colorPerShow.length) {
        const color = colorPerShow[showIndex];
        if (color) colorByItem.set(item, color);
      }
      showIndex += 1;
    }
  } catch {
    // Page illisible pour la liste d'opérateurs : aucune couleur connue,
    // les autres signaux (majuscules, gras) restent seuls utilisés.
  }
  return colorByItem;
}

// Un titre distinctement coloré tranche toujours nettement sur le noir
// (quasi universel pour le corps de texte d'un DAO) : on ne cherche pas une
// teinte précise (bleu, vert...), seulement un écart net avec le noir ET le
// blanc (une couleur presque blanche serait de toute façon invisible sur la
// page et n'est donc jamais un vrai titre imprimé).
function isDistinctColor(color: string | undefined) {
  if (!color) return false;
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return false;
  const value = match[1];
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const nearBlack = r <= 60 && g <= 60 && b <= 60;
  const nearWhite = r >= 235 && g >= 235 && b >= 235;
  return !nearBlack && !nearWhite;
}

function fontSizeOf(item: { transform?: number[] }) {
  const transform = item.transform;
  return transform ? Math.hypot(transform[2] ?? 0, transform[3] ?? 0) : null;
}

// Un DAO exporté par un logiciel de bureautique (Word/LibreOffice → PDF) ne
// nomme presque jamais sa police "Bold" même quand le texte est visuellement
// gras (pdf.js ne rapporte alors qu'une famille générique "serif"/
// "sans-serif", constaté sur un vrai contrat-cadre de fournitures) :
// looksBold() reste alors bloqué à faux pour TOUT le document, y compris ses
// vrais titres. La taille de police, elle, reste toujours lisible quel que
// soit le logiciel d'export : un titre de section y est presque toujours
// visiblement plus grand que le corps de texte qui l'entoure sur la MÊME
// page (ex. 14pt de titre contre 10pt de corps). On calcule ici la taille la
// plus fréquente de la page (le corps de texte), pour comparer chaque
// candidat à SA propre page plutôt qu'à un seuil absolu arbitraire.
function dominantFontSize(items: { str?: string; transform?: number[] }[]) {
  const counts = new Map<number, number>();
  for (const item of items) {
    if (!(item.str ?? "").trim()) continue;
    const size = fontSizeOf(item);
    if (size === null) continue;
    const rounded = Math.round(size * 2) / 2;
    counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [size, count] of counts) if (count > bestCount) { bestCount = count; best = size; }
  return best;
}

function isNoticeablyLarger(item: { transform?: number[] }, bodySize: number) {
  const size = fontSizeOf(item);
  return size !== null && bodySize > 0 && size >= bodySize * 1.15;
}

type PageTitle = { titleLine: string | null; heading: string };

// Cherche, sur TOUTE la page (pas seulement ses toutes premières lignes), la
// première portion de texte à la fois EN MAJUSCULES ET EN GRAS — le vrai
// titre, s'il y en a un — puis y rattache les portions suivantes qui
// remplissent aussi ces deux conditions (un titre peut être coupé sur deux
// lignes). Balayer la page ENTIÈRE, pas juste son début, est nécessaire car
// deux pièces du DAO peuvent se partager la MÊME page sans saut de page entre
// elles (ex. la fin de l'Annexe 5 et le titre de l'Annexe 6 juste en dessous,
// sur la même page) : un titre plus loin dans la page compte tout autant
// qu'un titre tout en haut, sinon la fin d'une pièce était mal coupée alors
// qu'un nouveau titre pourtant bien en gras et en majuscules était déjà là,
// juste plus bas sur la page. Aucune ligne trouvée : la page n'a pas de
// titre propre, elle appartient donc au document déjà en cours (voir
// isStopBoundary plus bas).
async function pageHeadingLine(doc: Awaited<ReturnType<typeof getDocument>["promise"]>, pageNumber: number): Promise<PageTitle> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const styles = (content.styles ?? {}) as Record<string, { fontFamily?: string }>;
  type RawItem = { str?: string; fontName?: string; transform?: number[] };
  const allItems = content.items as RawItem[];
  const items = allItems.filter((item) => (item.str ?? "").trim());
  // La toute première ligne est souvent juste le numéro de page imprimé.
  const withoutPageNumber = items[0] && /^\d{1,4}$/.test((items[0].str ?? "").trim()) ? items.slice(1) : items;
  const zone = withoutPageNumber;
  const isBlankRun = (item: RawItem) => !(item.str ?? "").trim();
  const isUppercaseRun = (item: RawItem) => isFullUppercase((item.str ?? "").trim());
  const isBoldUppercaseRun = (item: RawItem) => isUppercaseRun(item) && looksBold(item.fontName ? styles[item.fontName]?.fontFamily : undefined);
  // La taille de police ne coûte rien à calculer (déjà dans le "transform" de
  // chaque item, aucun appel supplémentaire) : autant s'en servir tout de
  // suite pour départager DEUX runs en majuscules ET en gras sur la même
  // page — un vrai titre de section est presque toujours agrandi par rapport
  // au corps de texte, alors qu'un simple en-tête de colonne de tableau
  // ("DESIGNATIONS", "DELAI DE LIVRAISON"...) ou une locution juridique
  // ("EN CONSEQUENCE") reste à la taille du corps. Sans cette préférence, le
  // premier en-tête de tableau rencontré (souvent bien avant le vrai titre
  // dans l'ordre de lecture) gagnait à tort, et le vrai titre plus bas sur la
  // page n'était plus jamais vu par l'appelant.
  const bodySize = dominantFontSize(items);
  const isBoldUppercaseTitleRun = (item: RawItem) => isBoldUppercaseRun(item) && isNoticeablyLarger(item, bodySize);
  // Priorité au signal le plus fiable (majuscules ET gras ET agrandi) ; à
  // défaut, on retombe sur n'importe quel majuscules+gras (comportement
  // historique, toujours nécessaire pour les DAO dont les titres ne sont
  // jamais agrandis par rapport au corps).
  const enlargedBoldStartIndex = zone.findIndex(isBoldUppercaseTitleRun);
  const plainBoldStartIndex = enlargedBoldStartIndex === -1 ? zone.findIndex(isBoldUppercaseRun) : -1;
  let isTitleRun = enlargedBoldStartIndex !== -1 ? isBoldUppercaseTitleRun : isBoldUppercaseRun;
  let startIndex = enlargedBoldStartIndex !== -1 ? enlargedBoldStartIndex : plainBoldStartIndex;
  if (startIndex === -1) {
    // Un contrat-cadre de fournitures, par exemple, n'écrit jamais ses titres
    // de pièce en majuscules ("Annexe 1", "Annexe 2 : Bordereau De Prix
    // Unitaires...") — seule une couleur distincte du corps de texte (noir)
    // les repère (constaté : bleu). D'autres titres du même DAO, eux, restent
    // en noir mais sont simplement écrits nettement plus grand que le corps
    // de texte qui les entoure (constaté : 14pt de titre contre 10-11pt de
    // corps). On calcule la couleur ET la taille dominante de la page ICI
    // seulement (jamais pour les DAO où le premier signal a déjà réussi) pour
    // ne payer le coût de la liste d'opérateurs que quand c'est vraiment
    // nécessaire. On exige un deuxième signal quand la couleur est le seul
    // indice disponible (gras) pour ne jamais confondre un vrai titre avec
    // une simple instruction ou un champ à remplir écrit dans la même
    // couleur mais à la même taille que le reste du paragraphe (constaté sur
    // un vrai DAO : "Dénomination sociale : <...>" en bleu, jamais agrandi
    // comme un vrai titre de section) — une taille nettement plus grande, en
    // revanche, suffit à elle seule, coloré ou non (looksBold() reste tenté
    // en premier pour la combinaison avec la couleur ; il ne peut pas servir
    // seul, une police "gras" n'étant pas toujours nommée comme telle par le
    // logiciel d'export, cas observé d'un export LibreOffice où toutes les
    // polices ne sont que "serif"/"sans-serif").
    const colorByItem = await buildItemColorMap(page, allItems);
    const isEmphasizedRun = (item: RawItem) => {
      const big = isNoticeablyLarger(item, bodySize);
      if (big) return true;
      const bold = looksBold(item.fontName ? styles[item.fontName]?.fontFamily : undefined);
      return bold && isDistinctColor(colorByItem.get(item));
    };
    const emphasizedStartIndex = zone.findIndex(isEmphasizedRun);
    if (emphasizedStartIndex !== -1) {
      isTitleRun = isEmphasizedRun;
      startIndex = emphasizedStartIndex;
    } else {
      // Certains DAO ne marquent JAMAIS le gras dans le nom de police de leur
      // PDF (gras "simulé" sans changer de police, export d'un autre
      // logiciel) : sans filet de secours, aucun titre ne serait plus jamais
      // trouvé sur ce DAO précis. Dernier recours : les majuscules seules
      // (signal le moins fiable — un simple "ATTENDU QUE" en plein milieu
      // d'un formulaire peut le déclencher — mais mieux que rien trouver).
      isTitleRun = isUppercaseRun;
      startIndex = zone.findIndex(isUppercaseRun);
    }
  }
  if (startIndex === -1) return { titleLine: null, heading: "" };
  const runs = [zone[startIndex]];
  // Un titre de pièce colorée s'étale souvent sur deux paragraphes séparés
  // ("Annexe 1" puis "Modèle de garantie bancaire de soumission" juste en
  // dessous) avec un item vide entre les deux (retour à la ligne) : on
  // saute ces items vides sans arrêter la lecture du titre, pour ne perdre
  // ni l'un ni l'autre des deux morceaux du même titre.
  for (let index = startIndex + 1; index < zone.length; index += 1) {
    if (isBlankRun(zone[index])) continue;
    if (!isTitleRun(zone[index])) break;
    runs.push(zone[index]);
  }
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
// On compare la PHRASE ENTIÈRE du titre demandé (tous ses mots, sans en
// écarter certains comme "spéciaux" ou "significatifs") à la zone de titre
// repérée sur la page — jamais seulement un ou deux mots choisis à part :
// choisir seulement quelques mots-clés a déjà fait prendre une page
// totalement différente pour la bonne (ex. "cahier" seul matche aussi bien
// "CCAP / Cahier des Clauses..." qu'un simple "cahier des charges" mentionné
// en passant, sur une page totalement différente). On exige donc de
// retrouver PRESQUE TOUS les mots de la phrase — pas forcément mot pour mot
// (un DAO peut l'écrire avec un accent ou une ponctuation différente de
// celle donnée), mais assez pour exclure une simple mention en passant.
const MIN_KEYWORD_MATCH_RATIO = 0.85;

function phraseWords(title: string) {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

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
  const keywords = phraseWords(title);
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
