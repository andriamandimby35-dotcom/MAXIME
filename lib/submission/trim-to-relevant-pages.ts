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
function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("fr-FR");
}

// Un intitulé de tableau connu (ex. "A2-a Matériel") n'est pas toujours écrit
// MOT POUR MOT sur la page du DAO (ponctuation, espaces ou tirets
// différents : "A2 - a) Matériel" par exemple) — une recherche de texte EXACTE
// (includes()) ratait alors des pages pourtant correctes. On compare plutôt
// les MOTS significatifs du titre (même méthode que findBestTitleMatch dans
// title-match.ts, déjà utilisée ailleurs dans le projet pour ce genre de
// rapprochement tolérant) à ceux réellement présents sur la page.
// BUG corrigé (signalé par Maxime sur "Annexe 6/7/8" — Andraikitry ny
// Ministera / Fifanarahana Fanamorana...) : un DAO malgache contient souvent
// une convention/annexe rédigée en malgache, où CHAQUE article a son propre
// titre en gras/majuscules (mise en forme tout à fait normale d'un document
// juridique à plusieurs articles) — pageHeadingLine (détection par simple
// mise en forme, voir plus bas) prenait alors CHACUN de ces titres d'article
// pour le début d'une toute nouvelle pièce à part entière, fragmentant un
// seul document en une dizaine de petites pièces inutilisables, toutes en
// malgache alors que Maxime veut du français. Générique par construction
// (une liste de mots grammaticaux propres au malgache — jamais des mots
// français — pas un titre ni un numéro codé en dur) : s'applique pareil à
// N'IMPORTE QUEL DAO malgache, pas seulement celui-ci. On exige au moins
// DEUX marqueurs distincts pour rester prudent (un seul mot court pourrait
// coïncider par hasard).
const MALAGASY_MARKERS = new Set([
  "ny", "sy", "ary", "amin", "tsy", "dia", "izay", "eo", "ao", "ho", "na",
  "sady", "satria", "raha", "mba", "araka", "kanefa", "fa", "tamin", "ireo",
  "ilay", "aza", "andraikitra", "andraikitry", "fanamorana", "fitanterana",
  "tompon", "mpahazo", "tombotsoa", "fotoana", "hanatanterahana",
  "fifanarahana", "fitantanana", "fitaovana", "akora",
]);
function looksMalagasy(text: string) {
  const words = text
    .toLocaleLowerCase("fr-FR")
    .replace(/['’]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let hits = 0;
  for (const word of words) if (MALAGASY_MARKERS.has(word)) hits += 1;
  return hits >= 2;
}
function pageWords(pageText: string) {
  return new Set(
    pageText
      .toLocaleLowerCase("fr-FR")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3),
  );
}
function pageLikelyContainsTitle(pageText: string, title: string, minRatio = 0.7) {
  const titleWords = significantWords(title);
  if (!titleWords.size) return false;
  const wordsOnPage = pageWords(pageText);
  let matched = 0;
  for (const word of titleWords) if (wordsOnPage.has(word)) matched += 1;
  return matched / titleWords.size >= minRatio;
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
  // Niveau de confiance le plus élevé (majuscules + gras + nettement plus
  // grand que le corps) : gardé pour le garde-fou juste plus bas — un vrai
  // titre court existe (rare, mais possible), et ce niveau, déjà confirmé par
  // la TAILLE en plus du style, reste fiable même sur un seul mot.
  const highConfidenceTier = enlargedBoldStartIndex !== -1;
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
  // BUG corrigé (Maxime, sur "COULEUR" pris à tort pour le titre d'une pièce
  // à part entière, alors que c'est juste l'étiquette d'un champ à
  // l'intérieur du modèle de panneau de chantier) : un vrai titre de pièce
  // DAO fait TOUJOURS plusieurs mots ("ANNEXE 7 : Modèle de PANNEAU DE
  // CHANTIER", "A2 : CAPACITES TECHNIQUES"...), jamais un seul mot isolé —
  // un simple en-tête de colonne de tableau ou une étiquette de champ
  // ("COULEUR", "DESIGNATION", "MONTANT"...) partage exactement la même mise
  // en forme (gras + majuscules) sans jamais être un vrai titre de document.
  // On applique ce garde-fou seulement aux niveaux de détection les MOINS
  // fiables (jamais le niveau 1, déjà confirmé par la taille en plus du
  // style, qui reste fiable même sur un titre court) pour ne pas perdre un
  // DAO qui aurait vraiment un titre court et fiable.
  if (!highConfidenceTier && titleLine && significantWords(titleLine).size < 2) {
    return { titleLine: null, heading: "" };
  }
  return { titleLine, heading: normalizeText(titleLine) };
}

// Renvoie, en plus des pages, le VRAI titre trouvé sur le DAO (tel qu'imprimé
// — majuscules et gras confirmés) : sert à afficher ce titre confirmé dans le
// document final, au lieu de laisser certains PDF générés sans aucun titre
// visible (voir printable-submission-document/route.ts).
export type RelevantPageRange = { pages: number[]; title: string | null };

export async function trimToRelevantStart(pdfBytes: Uint8Array, candidatePages: number[], title: string, claimedByOtherPages?: Set<number>, siblingTitles?: string[]): Promise<RelevantPageRange> {
  return extractRelevantPageRange(pdfBytes, candidatePages, title, { claimedByOtherPages, siblingTitles });
}

// Dernier recours quand l'IA n'a retrouvé AUCUNE page pour une pièce
// pourtant quasi toujours présente dans ce genre de DAO (CCAP, plans,
// calendrier cultural, code de conduite...) : au lieu d'abandonner, on
// cherche son titre directement dans TOUT le document, page par page,
// exactement comme extractRelevantPageRange le fait déjà à partir d'une
// plage connue — sauf qu'ici la "plage de départ" est le DAO entier.
// Générique par construction (le titre cherché est un paramètre) : sert
// n'importe quelle pièce, sur n'importe quel DAO, pas seulement le CCAP.
export async function locateTitleInFullDocument(pdfBytes: Uint8Array, title: string, claimedByOtherPages?: Set<number>, siblingTitles?: string[]): Promise<RelevantPageRange> {
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    const allPages = Array.from({ length: doc.numPages }, (_, index) => index + 1);
    return await extractRelevantPageRange(pdfBytes, allPages, title, { returnEmptyIfNotFound: true, claimedByOtherPages, siblingTitles });
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

// Cherche le titre EXACT (mot pour mot, déjà connu) d'une autre pièce du
// dossier n'importe où sur la page — pas seulement dans la zone de titre
// repérée par pageHeadingLine, qui exige une mise en forme distincte
// (majuscules/gras/couleur/taille) absente sur certains DAO. Un stockage
// séparé du texte complet de la page évite de le retélécharger deux fois
// (une fois ici, une fois dans pageHeadingLine) : l'appelant fournit déjà le
// texte normalisé, calculé une seule fois par page.
function pageContainsSiblingTitle(normalizedPageText: string, normalizedSiblingTitles: string[]) {
  return normalizedSiblingTitles.some((otherTitle) => otherTitle.length >= 12 && normalizedPageText.includes(otherTitle));
}

async function normalizedPageText(doc: Awaited<ReturnType<typeof getDocument>["promise"]>, pageNumber: number): Promise<string> {
  try {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    return normalizeText(content.items.map((item) => ("str" in item ? (item as { str?: string }).str ?? "" : "")).join(" "));
  } catch {
    return "";
  }
}

// Comme normalizedPageText, mais SANS mettre en minuscule ni retirer les
// accents : sert uniquement à extraire un texte à AFFICHER tel quel (le
// sommaire du DAO, voir extractAnnexeTableOfContents plus bas), jamais pour
// une comparaison (qui doit toujours passer par normalizedPageText/
// significantWords, insensibles à la casse et aux accents).
async function rawPageText(doc: Awaited<ReturnType<typeof getDocument>["promise"]>, pageNumber: number): Promise<string> {
  try {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    return content.items.map((item) => ("str" in item ? (item as { str?: string }).str ?? "" : "")).join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
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
    // Titres des AUTRES pièces du même dossier (voir siblingTitlesFor côté
    // appelant) : filet de sécurité complémentaire à isStopBoundary. Ce
    // dernier ne repère un changement de document que si le NOUVEAU titre
    // est bien écrit en majuscules ET en gras sur la page DAO (voir
    // pageHeadingLine) — or certains DAO écrivent le titre d'une pièce
    // suivante sans cette mise en forme distincte (constaté : le titre d'une
    // pièce "Sécurité de soumission" avalé par erreur à la fin d'une pièce
    // "Fiches de renseignements A1 à A5", les deux partageant la même page
    // physique du DAO sans qu'aucune mise en forme ne trahisse le nouveau
    // titre). Comme on connaît déjà, mot pour mot, le titre de CHAQUE autre
    // pièce du dossier (déjà extrait par l'IA), on peut chercher directement
    // ce texte précis sur la page, sans dépendre d'aucune mise en forme.
    siblingTitles?: string[];
  } = {},
): Promise<RelevantPageRange> {
  if (!candidatePages.length) return { pages: candidatePages, title: null };
  const keywords = phraseWords(title);
  if (!keywords.length) return { pages: candidatePages, title: null };
  const normalizedSiblingTitles = (options.siblingTitles ?? []).map((otherTitle) => normalizeText(otherTitle)).filter(Boolean);
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
        // Filet complémentaire (voir pageContainsSiblingTitle plus haut) :
        // avant même de se fier à isStopBoundary (qui exige une mise en
        // forme distincte), on vérifie si le titre EXACT d'une autre pièce
        // du dossier apparaît quelque part sur cette page précise.
        const siblingHit = normalizedSiblingTitles.length > 0 && pageContainsSiblingTitle(await normalizedPageText(doc, pageNumber), normalizedSiblingTitles);
        if (siblingHit) {
          if (isIsolatedJump) { previousPage = pageNumber; continue; } // Page isolée étrangère : simplement ignorée, comme d'habitude.
          stoppedEarly = true;
          break; // Une autre pièce déjà connue commence ici : on s'arrête net.
        }
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
          const siblingHit = normalizedSiblingTitles.length > 0 && pageContainsSiblingTitle(await normalizedPageText(doc, pageNumber), normalizedSiblingTitles);
          if (siblingHit || isStopBoundary(titleLine, heading, referenceHeading, keywords)) break;
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

// Repère, à l'intérieur des pages qu'un MÊME submission_item revendique
// (déjà connues, contrairement à extractRelevantPageRange plus haut qui les
// cherche depuis un titre), si plusieurs de ces pages affichent CHACUNE leur
// propre vrai titre de document — signe que l'IA a fusionné à tort plusieurs
// pièces distinctes en un seul item (voir splitMergedDaoItems dans
// build-dossier-items.ts, qui utilise ce découpage). Générique par
// construction : réutilise exactement le même signal de mise en forme
// (majuscules + gras, voir pageHeadingLine plus haut) que le reste de ce
// fichier, aucun mot ni numéro codé en dur — fonctionne pareil sur n'importe
// quel DAO.
export type MergedItemSegment = { pages: number[]; title: string };

// BUG corrigé (Maxime, sur la pièce malgache Annexe 6/7/8) : looksMalagasy()
// empêche bien la fragmentation en petites pièces (un article malgache =
// une pièce), mais laisse alors TOUTE la convention (Annexe 6, 7 ET 8)
// fusionnée en une seule pièce sans aucun titre propre à chacune — l'inverse
// de ce que demande Maxime (trois pièces bien distinctes "Annexe 6",
// "Annexe 7", "Annexe 8", visibles dans la liste AVANT même d'ouvrir un PDF,
// pour faciliter le contrôle visuel). Un numéro d'annexe imprimé ("Annexe
// 6", "ANNEXE 7", "Annexe n°8"...) est un signal bien plus fiable qu'une
// simple mise en forme (gras/majuscules/couleur) pour marquer le début
// d'une nouvelle pièce : il fonctionne même quand le DAO n'a mis AUCUNE
// mise en forme distincte sur ce mot précis, et il donne directement un
// titre propre et déjà en français, sans dépendre du contenu malgache
// environnant. On se limite au tout DÉBUT de la page (jamais tout son
// texte) pour ne jamais confondre un vrai intitulé d'annexe avec un simple
// renvoi cité en passant au milieu d'un paragraphe ("voir aussi l'annexe 6
// alinéa 2"). Générique par construction (le numéro est capturé, jamais
// codé en dur) : reconnaît "Annexe 6", "Annexe 7", "Annexe 8" pareil que
// n'importe quel autre numéro, sur n'importe quel DAO.
// BUG corrigé (Maxime, DAO Manongarivo/Vohibolo : "ANNEXE 05 : CODE DE
// CONDUITE" jamais reconnue) : cette fenêtre supposait le numéro d'annexe
// TOUT AU DÉBUT de la page, ce qui n'est pas toujours vrai — une page peut
// terminer le chapitre précédent avant de commencer une nouvelle annexe plus
// bas (constaté : le marqueur apparaît après ~330 caractères de texte de fin
// de chapitre, sur la même page). 500 caractères couvrent ce cas réel avec
// une marge confortable, tout en restant largement en dessous d'une page
// complète (~2000+ caractères) pour ne pas non plus attraper un simple
// renvoi en passant ("voir aussi l'annexe 6") qui apparaîtrait, lui, presque
// toujours plus loin dans le corps du texte.
const ANNEXE_HEADING_WINDOW = 500;
function annexeNumberAtPageStart(normalizedFullPageText: string): number | null {
  const start = normalizedFullPageText.slice(0, ANNEXE_HEADING_WINDOW);
  const match = /\bannexe\s*(?:n[o°]?\.?\s*)?(\d{1,2})\b/.exec(start);
  return match ? Number(match[1]) : null;
}

// BUG corrigé (Maxime, Annexe 6 introuvable dans la liste : "il faut trouver
// les annexes... et ces titres sont tirés des listes de dossier demandées
// par le DAO") : certaines annexes commencent par une page qui ne contient
// NULLE PART le mot "annexe" ni son numéro (ex. l'Annexe 6 du DAO
// Manongarivo/Vohibolo commence directement par le texte de la convention
// elle-même, "CONVENTION SUR LA FACILITATION DU TRANSPORT A DOS D'HOMME...",
// sans aucune mention de son numéro) — aucun signal sur CETTE page seule
// (mise en forme, numéro) ne permet alors de deviner qu'il s'agit bien de
// l'Annexe 6. Ce genre de DAO (modèle TALIM/FEFFI, vérifié identique sur
// deux DAO différents) a toujours, tout au début du document, un sommaire
// officiel qui énumère CHAQUE annexe avec son numéro ET son titre complet
// ("-Annexe 6 : Convention sur la facilitation de transport à dos d'homme
// entre CISCO et les bénéficiaires ... Page 252") : ce sommaire fait le lien
// que la page elle-même ne fait pas. Générique par construction (aucun titre
// n'est codé en dur, tout est lu depuis ce sommaire) : s'applique pareil à
// n'importe quel DAO qui a ce genre de sommaire ; un DAO qui n'en a pas (ou
// dont le sommaire ne suit pas ce format) renvoie simplement une liste vide
// ci-dessous, sans aucune régression (le reste du fichier continue de
// fonctionner exactement comme avant dans ce cas).
export type TocAnnexeEntry = { number: number; title: string };
const TOC_SCAN_PAGES = 20;
async function extractAnnexeTableOfContents(doc: Awaited<ReturnType<typeof getDocument>["promise"]>): Promise<TocAnnexeEntry[]> {
  const entries: TocAnnexeEntry[] = [];
  try {
    const maxPage = Math.min(TOC_SCAN_PAGES, doc.numPages);
    let combined = "";
    for (let page = 1; page <= maxPage; page += 1) combined += ` ${await rawPageText(doc, page)}`;
    // "-Annexe 6 : Titre ... Page 252" ou "-Annexe2. Titre ... Page 46" (sans
    // espace, ponctuation variable) : on capture tout jusqu'au prochain
    // "Page N", qui termine systématiquement chaque ligne de ce sommaire.
    const regex = /Annexe\s*(\d{1,2})\s*[:.]?\s*(.+?)\s*Page\s*\d+/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(combined)) !== null) {
      const number = Number(match[1]);
      const title = match[2].replace(/\s+/g, " ").trim().replace(/[;,.\-–]+$/, "").trim();
      // Filtre de sécurité : une entrée mal découpée (aucun "Page N" trouvé
      // avant longtemps, ex. une mention isolée du mot "annexe" ailleurs dans
      // les 20 premières pages) donnerait un titre anormalement long — jamais
      // utilisée ensuite, aucune vraie ligne de sommaire ne fait cette
      // longueur.
      if (title.length >= 4 && title.length <= 140 && !/^\d+$/.test(title)) entries.push({ number, title });
    }
  } catch {
    // DAO sans sommaire exploitable : liste vide, aucune régression (voir
    // matchTocEntry plus bas, qui se contente alors de ne jamais matcher).
  }
  return entries;
}

// Associe une page à une entrée du sommaire ci-dessus : par NUMÉRO explicite
// déjà repéré sur la page (annexeNumberAtPageStart) en priorité — s'il y a
// plusieurs entrées avec ce même numéro dans le sommaire (les numéros
// d'annexe recommencent à 1 dans chaque grande partie du DAO, voir plus
// haut), on choisit celle dont le TITRE correspond le mieux au texte réel de
// la page ; à défaut de numéro trouvé sur la page elle-même, par le TITRE
// SEUL (cas de l'Annexe 6 ci-dessus). referenceNumber empêche de revenir en
// arrière vers une entrée déjà dépassée (donc, de fait, vers les doublons de
// numéro des grandes parties déjà lues) : le numéro trouvé doit toujours
// être strictement supérieur à celui de l'annexe en cours.
//
// BUG corrigé (vérifié empiriquement sur un DAO réel : la pièce "B2 - Caution
// personnelle et solidaire" — un cautionnement bancaire — s'est fait
// renommer à tort en "Annexe 1 : Modèle de garantie bancaire de bonne
// exécution", les deux textes partageant assez de vocabulaire commun
// -garantie, bancaire, exécution- pour dépasser le seuil de correspondance
// par TITRE SEUL, alors qu'aucun numéro d'annexe n'apparaît sur cette page).
// Chercher par titre seul (sans aucun numéro trouvé sur la page) reste utile
// pour ÉTENDRE une pièce déjà identifiée vers ses pages suivantes (voir
// extendDaoItemPages plus bas, où un faux numéro trouvé ne fait au pire que
// mal régler un repère interne, jamais un titre affiché à Maxime), mais est
// TROP RISQUÉ pour RENOMMER une pièce déjà titrée par l'IA (voir la passe de
// correction de titre dans split-merged-dao-items.ts, qui l'exclut donc
// explicitement). allowTitleOnlyMatch (true par défaut, comme avant) laisse
// chaque appelant choisir selon ce risque.
function matchTocEntry(pageText: string, explicitNumber: number | null, toc: TocAnnexeEntry[], used: Set<number>, referenceNumber: number | null, allowTitleOnlyMatch = true): TocAnnexeEntry | null {
  if (explicitNumber !== null) {
    let bestIndex = -1;
    let bestScore = -1;
    for (let index = 0; index < toc.length; index += 1) {
      if (used.has(index) || toc[index].number !== explicitNumber) continue;
      const words = significantWords(toc[index].title);
      const onPage = pageWords(pageText);
      let matched = 0;
      for (const word of words) if (onPage.has(word)) matched += 1;
      const score = words.size ? matched / words.size : 0;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    if (bestIndex === -1) return null;
    used.add(bestIndex);
    return toc[bestIndex];
  }
  if (!allowTitleOnlyMatch) return null;
  const minNumber = referenceNumber ?? 0;
  for (let index = 0; index < toc.length; index += 1) {
    if (used.has(index) || toc[index].number <= minNumber) continue;
    if (pageLikelyContainsTitle(pageText, toc[index].title, 0.65)) {
      used.add(index);
      return toc[index];
    }
  }
  return null;
}

export async function splitPagesByOwnTitle(pdfBytes: Uint8Array, sortedPages: number[], ownTableTitles?: string[]): Promise<MergedItemSegment[]> {
  if (!sortedPages.length) return [];
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;

    // RÈGLE GÉNÉRALE (demandée après un cas réel, mais valable pour n'importe
    // quel DAO) : quand le DAO original demande deux tableaux sur DEUX PAGES
    // DIFFÉRENTES d'une même pièce fusionnée à tort par l'IA, il faut les
    // séparer en deux pièces distinctes — même quand la seconde page n'a pas
    // de titre visuellement distinct (gras/majuscules). Se fier UNIQUEMENT à
    // la mise en forme du titre a laissé des tableaux mal rattachés (ex. un
    // tableau "Litiges" retrouvé collé à une pièce qui n'est pas la sienne).
    // On repère donc, pour chaque tableau déjà connu de cette pièce, la toute
    // première page (parmi les pages de la pièce, dans l'ordre) où son
    // intitulé apparaît réellement dans le texte — cette page devient aussi
    // une limite de segment, en plus des titres détectés par mise en forme.
    // Aucun titre de tableau n'est codé en dur ici : la liste vient toujours
    // de template_tables de la pièce elle-même.
    const tableBoundaryPages = new Map<number, string>();
    const unmatchedTableTitles: string[] = [];
    for (const tableTitle of ownTableTitles ?? []) {
      if (!tableTitle.trim()) continue;
      let found = false;
      for (const pageNumber of sortedPages) {
        if (pageNumber < 1 || pageNumber > doc.numPages) continue;
        try {
          const text = await normalizedPageText(doc, pageNumber);
          if (pageLikelyContainsTitle(text, tableTitle)) { if (!tableBoundaryPages.has(pageNumber)) tableBoundaryPages.set(pageNumber, tableTitle); found = true; break; }
        } catch {
          // Page illisible pour cette recherche : ignorée, sans bloquer les autres tableaux.
        }
      }
      if (!found) unmatchedTableTitles.push(tableTitle);
    }

    // RÈGLE GÉNÉRALE : l'IA compte parfois les pages d'une pièce en dessous
    // de la réalité (ex. une seule page notée alors que le DAO en utilise
    // deux, une par tableau) — un tableau connu de la pièce n'est alors
    // trouvé sur AUCUNE des pages déclarées. On cherche ce tableau sur
    // quelques pages juste après la dernière page déclarée (bornée, jamais
    // tout le DAO), et s'il y est trouvé, cette page rejoint la plage de
    // travail de la pièce, exactement comme si l'IA l'avait citée dès le
    // départ.
    const workingPages = new Set(sortedPages);
    if (unmatchedTableTitles.length) {
      const lastKnownPage = sortedPages[sortedPages.length - 1];
      const EXTENSION_LIMIT = 6;
      for (let offset = 1; offset <= EXTENSION_LIMIT && unmatchedTableTitles.length; offset += 1) {
        const candidatePage = lastKnownPage + offset;
        if (candidatePage > doc.numPages || workingPages.has(candidatePage)) continue;
        let text = "";
        try {
          text = await normalizedPageText(doc, candidatePage);
        } catch {
          continue;
        }
        for (let index = unmatchedTableTitles.length - 1; index >= 0; index -= 1) {
          if (pageLikelyContainsTitle(text, unmatchedTableTitles[index])) {
            tableBoundaryPages.set(candidatePage, unmatchedTableTitles[index]);
            workingPages.add(candidatePage);
            unmatchedTableTitles.splice(index, 1);
          }
        }
      }
    }
    const workingSortedPages = [...workingPages].sort((a, b) => a - b);

    // Sommaire officiel du DAO (voir extractAnnexeTableOfContents plus haut) :
    // lu UNE SEULE FOIS par appel, puis consommé au fil des pages ci-dessous
    // (usedTocIndices) pour ne jamais réutiliser deux fois la même entrée.
    const tocEntries = await extractAnnexeTableOfContents(doc);
    const usedTocIndices = new Set<number>();
    const segments: MergedItemSegment[] = [{ pages: [workingSortedPages[0]], title: "" }];
    let referenceHeading = "";
    // Numéro de l'annexe en cours (voir annexeNumberAtPageStart plus haut) :
    // null tant qu'aucune page n'a encore montré de numéro d'annexe explicite.
    let referenceAnnexeNumber: number | null = null;
    try {
      const firstPageText = await normalizedPageText(doc, workingSortedPages[0]);
      const firstAnnexeNumber = annexeNumberAtPageStart(firstPageText);
      const firstTocEntry = matchTocEntry(firstPageText, firstAnnexeNumber, tocEntries, usedTocIndices, null);
      const firstResolvedNumber = firstTocEntry?.number ?? firstAnnexeNumber;
      if (firstResolvedNumber !== null) {
        segments[0].title = firstTocEntry ? `Annexe ${firstResolvedNumber} : ${firstTocEntry.title}` : `Annexe ${firstResolvedNumber}`;
        referenceAnnexeNumber = firstResolvedNumber;
      }
      if (!segments[0].title) {
        const first = await pageHeadingLine(doc, workingSortedPages[0]);
        if (first.titleLine && !looksMalagasy(first.titleLine)) { segments[0].title = first.titleLine; referenceHeading = first.heading; }
      }
    } catch {
      // Première page illisible : segment de départ gardé sans titre connu.
    }
    for (let index = 1; index < workingSortedPages.length; index += 1) {
      const pageNumber = workingSortedPages[index];
      const currentSegment = segments[segments.length - 1];
      if (pageNumber < 1 || pageNumber > doc.numPages) { currentSegment.pages.push(pageNumber); continue; }
      try {
        // Priorité au numéro d'annexe explicite (voir annexeNumberAtPageStart
        // plus haut) et/ou au sommaire du DAO (voir matchTocEntry plus haut,
        // pour une annexe dont la page de début ne contient elle-même aucun
        // numéro) : signal bien plus fiable que la mise en forme, et qui
        // donne directement un titre propre ("Annexe 6 : Convention sur la
        // facilitation...") même quand le corps de la page qui suit est
        // rédigé dans une langue où looksMalagasy bloque par ailleurs la
        // détection de titre par mise en forme (voir plus bas) — sans ce cas
        // prioritaire, plusieurs annexes différentes se retrouvaient
        // fusionnées en une seule pièce sans titre à elles.
        const pageText = await normalizedPageText(doc, pageNumber);
        const annexeNumber = annexeNumberAtPageStart(pageText);
        const tocEntry = matchTocEntry(pageText, annexeNumber, tocEntries, usedTocIndices, referenceAnnexeNumber);
        const resolvedNumber = tocEntry?.number ?? annexeNumber;
        if (resolvedNumber !== null && resolvedNumber !== referenceAnnexeNumber) {
          segments.push({ pages: [pageNumber], title: tocEntry ? `Annexe ${resolvedNumber} : ${tocEntry.title}` : `Annexe ${resolvedNumber}` });
          referenceAnnexeNumber = resolvedNumber;
          referenceHeading = ""; // Nouvelle annexe : un titre stylé à l'intérieur ne doit plus être comparé à l'ancienne pièce.
          continue;
        }
        const { heading, titleLine } = await pageHeadingLine(doc, pageNumber);
        // Un titre trouvé, différent du titre déjà en cours : une AUTRE
        // pièce commence ici, jamais une simple continuation (même règle que
        // isStopBoundary plus haut, sans comparaison à un titre demandé —
        // ici on compare seulement les titres trouvés entre eux).
        const newStyledTitle = Boolean(titleLine) && heading !== referenceHeading && !looksMalagasy(titleLine ?? "");
        // Même sans titre stylé détecté : un tableau de cette pièce démarre
        // justement sur cette page (voir tableBoundaryPages plus haut), donc
        // le DAO original les a mis sur des pages séparées — l'extraction
        // doit faire pareil.
        const matchedTableTitle = tableBoundaryPages.get(pageNumber);
        const newTableBoundary = !newStyledTitle && Boolean(matchedTableTitle);
        if (newStyledTitle || newTableBoundary) {
          // BUG corrigé : le titre stylé (gras + majuscules) l'emportait
          // encore ici sur le titre du tableau déjà connu (matchedTableTitle),
          // alors que "pageHeadingLine" (détection par simple mise en forme)
          // se trompe régulièrement sur l'EN-TÊTE DE COLONNES d'un tableau
          // ("NOM ET PRENOM DIPLOME FONCTION ANNEE D'EXPERIENCE..."), qui est
          // lui aussi en gras/majuscules mais n'est PAS un titre de section —
          // ce qui donnait ce texte comme titre de la pièce au lieu du vrai
          // titre du tableau ("A2-b Personnel"). Un tableau déjà identifié
          // par son propre intitulé (matchedTableTitle, trouvé plus haut dans
          // ownTableTitles) est une source bien plus fiable que cette
          // détection de mise en forme : il l'emporte donc TOUJOURS quand les
          // deux existent pour la même page, quel que soit l'ordre dans
          // lequel ils ont été détectés.
          segments.push({ pages: [pageNumber], title: matchedTableTitle ?? (titleLine ?? "") });
          if (newStyledTitle) referenceHeading = heading;
        } else {
          currentSegment.pages.push(pageNumber);
        }
      } catch {
        currentSegment.pages.push(pageNumber); // Page illisible : gardée dans le segment en cours, par prudence.
      }
    }
    return segments;
  } catch {
    return [];
  }
}

// Numéro d'annexe explicite (voir annexeNumberAtPageStart plus haut) sur LA
// PROPRE première page connue d'une pièce — exporté séparément de
// splitPagesByOwnTitle (qui ne s'applique qu'aux pièces déjà fusionnées sur
// PLUSIEURS pages) : sert aussi à corriger le TITRE affiché d'une pièce déjà
// détectée par l'IA comme une pièce à PART ENTIÈRE (une seule page connue),
// quand l'IA a retenu un autre texte de la page (souvent un en-tête, une
// mention en passant) au lieu du vrai "ANNEXE N" qui l'introduit — voir
// split-merged-dao-items.ts, passe finale de correction de titre.
export async function firstPageAnnexeNumber(pdfBytes: Uint8Array, pageNumber: number): Promise<number | null> {
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    if (pageNumber < 1 || pageNumber > doc.numPages) return null;
    return annexeNumberAtPageStart(await normalizedPageText(doc, pageNumber));
  } catch {
    return null;
  }
}

export type ResolvedAnnexeTitle = { number: number; title: string };

// Comme firstPageAnnexeNumber ci-dessus, mais va plus loin en s'appuyant
// AUSSI sur le sommaire officiel du DAO (voir extractAnnexeTableOfContents
// plus haut) : trouve le VRAI titre complet d'une annexe à partir de la
// seule page où elle commence — y compris quand cette page elle-même ne
// contient NULLE PART le mot "annexe" (cas de l'Annexe 6, signalée par
// Maxime : sa page de début est directement le texte de la convention,
// "CONVENTION SUR LA FACILITATION DU TRANSPORT A DOS D'HOMME...", sans
// aucune mention de son numéro — seul le sommaire du DAO fait ce lien).
// Exporté pour split-merged-dao-items.ts : sert à corriger le titre d'une
// pièce déjà détectée par l'IA comme une pièce à PART ENTIÈRE (une seule
// page connue) — pour une pièce fusionnée sur PLUSIEURS pages, voir
// directement splitPagesByOwnTitle plus haut, qui applique la même logique
// pièce par pièce lors du découpage. referenceNumber optionnel : permet
// d'exclure les annexes déjà dépassées quand l'appelant les connaît (voir
// son usage) ; laissé à null, seul le numéro/titre de CETTE page compte.
// allowTitleOnlyMatch (true par défaut) : voir le commentaire dans
// matchTocEntry plus haut — le passer à false pour un usage qui RENOMME une
// pièce déjà titrée (jamais fiable sans numéro explicite trouvé sur la
// page), true pour un usage interne (ex. amorcer extendDaoItemPages) où un
// faux numéro ne fait au pire que mal régler un repère, jamais un titre
// affiché à Maxime.
export async function resolveAnnexeTitleForPage(pdfBytes: Uint8Array, pageNumber: number, referenceNumber: number | null = null, allowTitleOnlyMatch = true): Promise<ResolvedAnnexeTitle | null> {
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    if (pageNumber < 1 || pageNumber > doc.numPages) return null;
    const pageText = await normalizedPageText(doc, pageNumber);
    const explicitNumber = annexeNumberAtPageStart(pageText);
    const toc = await extractAnnexeTableOfContents(doc);
    const entry = matchTocEntry(pageText, explicitNumber, toc, new Set(), referenceNumber, allowTitleOnlyMatch);
    if (entry) return { number: entry.number, title: entry.title };
    if (explicitNumber !== null) return { number: explicitNumber, title: "" };
    return null;
  } catch {
    return null;
  }
}

// BUG corrigé (Maxime, Annexe 6 tronquée à tort à la page 245 : sondage réel
// de la base de données montrant "Pages 240-245" alors que la vraie Annexe 6
// va jusqu'à la page 261) : l'IA a parfois retenu MOINS de pages qu'il n'en
// faut vraiment pour une pièce DAO — ici, ses propres sous-annexes rédigées
// en malgache (Tovana I, II, III) continuant jusqu'à la page 261, juste
// avant le début réel de l'Annexe 7 — ces pages ne sont alors rattachées à
// AUCUNE pièce et disparaissent purement et simplement, sans qu'aucune des
// corrections ci-dessus (qui ne travaillent QUE sur les pages déjà connues
// d'une pièce) ne puisse jamais les retrouver. On étend donc la plage
// connue d'une pièce DAO vers les pages suivantes tant qu'elles ne sont
// revendiquées par AUCUNE AUTRE pièce déjà identifiée (claimedPages) et
// qu'aucune NOUVELLE annexe n'y commence (numéro explicite ou titre du
// sommaire) — jamais au-delà. Générique par construction (aucune page ni
// aucun titre codé en dur) : s'applique à n'importe quelle pièce DAO
// tronquée par l'IA, pas seulement celle qui a révélé ce problème. Exporté
// pour split-merged-dao-items.ts, qui l'appelle pour CHAQUE pièce DAO, mais
// seulement APRÈS avoir décidé si un découpage (splitPagesByOwnTitle) est
// nécessaire — et uniquement sur la toute DERNIÈRE pièce ainsi obtenue (voir
// le commentaire dans split-merged-dao-items.ts : réutiliser ces pages
// étendues, non vérifiées par l'IA, comme entrée de splitPagesByOwnTitle a
// déjà provoqué une fragmentation en cascade sur un vrai DAO).
//
// BUG corrigé (vérifié empiriquement sur un DAO réel) : une première version
// s'arrêtait AUSSI dès qu'un titre stylé (gras+majuscules) différent
// apparaissait, comme le fait déjà splitPagesByOwnTitle — mais un simple
// EN-TÊTE DE COLONNES DE TABLEAU ("MATERIAUX QUANTITE UNITE", plusieurs mots
// donc jamais filtré par le garde-fou "un seul mot n'est pas un titre" de
// pageHeadingLine) partage exactement cette même mise en forme sans être un
// vrai changement de pièce, ce qui arrêtait l'extension dès la toute
// première page suivante à chaque fois qu'un tableau s'y trouvait — modifier
// pageHeadingLine lui-même casserait splitPagesByOwnTitle, qui a besoin de
// ce signal pour DÉCOUPER une pièce déjà validée par l'IA. Ici, en revanche,
// on avance en territoire que l'IA n'avait PAS validé du tout : seuls des
// signaux fiables (numéro d'annexe explicite, titre du sommaire, ou une page
// déjà revendiquée par une autre pièce) doivent arrêter l'extension — jamais
// un simple style de texte, trop souvent partagé par un en-tête de tableau.
//
// BUG corrigé (vérifié empiriquement : une pièce "Liste des plans" notée par
// l'IA "Page 119 et bloc plans 120-230" — une formulation que l'analyse de
// texte ne reconnaît que comme la page 119 seule — s'arrêtait à tort à la
// page 159, alors que la vraie limite (la page 231, déjà revendiquée par
// l'annexe suivante) se trouve bien plus loin) : maxExtra=40 avait été choisi
// en pensant au cas de l'Annexe 6 (21 pages de plus suffisaient), mais une
// annexe de plans architecturaux peut légitimement s'étaler sur une centaine
// de pages de plus. Ce plafond reste nécessaire (filet de sécurité si un DAO
// est illisible de bout en bout, ou si aucune pièce suivante ne revendique
// jamais la bonne page d'arrêt), mais 40 était trop bas pour ce cas réel —
// 200 couvre largement ce genre d'annexe sans jamais empêcher claimedPages
// ou un nouveau numéro d'annexe de s'arrêter bien avant si la vraie limite
// est plus proche (cas normal, largement majoritaire).
export async function extendDaoItemPages(pdfBytes: Uint8Array, lastKnownPage: number, claimedPages: Set<number>, referenceAnnexeNumber: number | null, maxExtra = 200): Promise<number[]> {
  const extra: number[] = [];
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    const toc = await extractAnnexeTableOfContents(doc);
    const used = new Set<number>();
    const reference = referenceAnnexeNumber;
    let pageNumber = lastKnownPage + 1;
    let checked = 0;
    while (pageNumber <= doc.numPages && checked < maxExtra) {
      if (claimedPages.has(pageNumber)) break; // Déjà à une AUTRE pièce déjà connue : on s'arrête net.
      const pageText = await normalizedPageText(doc, pageNumber);
      const explicitNumber = annexeNumberAtPageStart(pageText);
      const tocEntry = matchTocEntry(pageText, explicitNumber, toc, used, reference);
      const resolvedNumber = tocEntry?.number ?? explicitNumber;
      if (resolvedNumber !== null && resolvedNumber !== reference) break; // Nouvelle annexe : elle sera (ou est déjà) sa propre pièce.
      extra.push(pageNumber);
      pageNumber += 1;
      checked += 1;
    }
  } catch {
    // Erreur de lecture : on ne perd rien, la pièce garde simplement sa plage d'origine.
  }
  return extra;
}

// Cette page a-t-elle un vrai titre à elle (mise en forme distincte ET
// plusieurs mots, voir le garde-fou dans pageHeadingLine) ? Exporté pour
// split-merged-dao-items.ts : sert à décider si une pièce DAO d'une seule
// page, immédiatement collée à la dernière page d'une autre pièce déjà
// détectée, est une VRAIE pièce à part (elle a son propre titre) ou juste un
// fragment (étiquette de champ, fin de tableau...) à fusionner avec la
// pièce précédente — voir la passe finale de fusion dans ce même fichier.
export async function pageHasReliableOwnTitle(pdfBytes: Uint8Array, pageNumber: number): Promise<boolean> {
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    if (pageNumber < 1 || pageNumber > doc.numPages) return false;
    const { titleLine } = await pageHeadingLine(doc, pageNumber);
    return Boolean(titleLine);
  } catch {
    return false;
  }
}

// Les pages sur lesquelles le texte donné apparaît réellement (comparaison
// par mots significatifs, tolérante à la ponctuation/mise en forme — voir
// pageLikelyContainsTitle plus haut) — sert à rattacher un tableau déjà connu
// (son intitulé) au bon segment après un découpage, sans dépendre d'aucune
// mise en forme (un intitulé de tableau n'est pas toujours en gras/
// majuscules, contrairement à un vrai titre de pièce).
export async function pagesContainingText(pdfBytes: Uint8Array, pages: number[], needle: string): Promise<Set<number>> {
  const matches = new Set<number>();
  if (!needle.trim() || !pages.length) return matches;
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    for (const pageNumber of pages) {
      if (pageNumber < 1 || pageNumber > doc.numPages) continue;
      const text = await normalizedPageText(doc, pageNumber);
      if (pageLikelyContainsTitle(text, needle)) matches.add(pageNumber);
    }
    return matches;
  } catch {
    return matches;
  }
}
