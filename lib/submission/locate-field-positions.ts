import "@/lib/submission/pdfjs-worker-setup";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, PDFFont, StandardFonts } from "pdf-lib";
import { significantWords } from "@/lib/submission/title-match";
import { isBlankMarkerRun } from "@/lib/submission/blank-marker";

// L'IA ne donne quasiment jamais de position fiable pour écrire une valeur
// sur la page DAO elle-même (constaté : 0 position sur 16 pièces d'un DAO
// réel, deux analyses de suite). Plutôt que de dépendre uniquement d'une
// coordonnée devinée par l'IA, on retrouve directement où se trouve le
// libellé du champ (ou, pour un tableau, le libellé de la ligne ET l'en-tête
// de la colonne) sur la page réelle, et on place la valeur juste à l'endroit
// normal du formulaire — exactement comme le ferait un candidat qui complète
// le modèle à la main, quel que soit le DAO.
type TextItem = { str?: string; transform?: number[]; width?: number };
type FieldTarget = { field_key: string; label: string; description?: string };
// font_size (facultatif) : taille de police réelle relevée sur la page DAO à
// cet emplacement précis (voir fontSizeOfItem plus bas) — transmise jusqu'à
// createFilledDaoTemplatePdf pour que la valeur écrite ait la même taille que
// le texte qu'elle remplace, au lieu d'une taille fixe qui jure avec le
// reste de la page.
// debug_matched_line (facultatif) : le texte de la ligne réelle de la page
// DAO sur laquelle ce champ a été placé — jamais utilisé pour dessiner quoi
// que ce soit, uniquement remonté jusqu'aux journaux Vercel (route.ts) pour
// vérifier, à distance, qu'un champ tombe bien sur la BONNE ligne du modèle
// et pas seulement qu'une position a été "trouvée" (un score de mots-clés
// suffisant peut très bien pointer vers une ligne qui n'est pas la bonne).
// debug_blank_kind (facultatif, même principe que debug_matched_line) :
// comment le blanc a été repéré pour ce champ — "blank-item" (un repère de
// blanc qui est son propre item), "embedded" (un pointillé caché au milieu
// d'une phrase), "inline-after-label" (aucun blanc trouvé, valeur juste
// après le libellé sur la même ligne) ou "below-line" (aucun blanc trouvé,
// valeur placée sur la ligne du dessous, jugée libre) — jamais utilisé pour
// dessiner quoi que ce soit, uniquement pour comprendre à distance pourquoi
// une valeur atterrit à tel endroit précis plutôt qu'à un autre.
type LocatedPosition = { page: number; field_key: string; x_percent: number; y_percent: number; width_percent: number; font_size?: number; debug_matched_line?: string; debug_blank_kind?: string };
type LineGroup = { items: TextItem[]; text: string; y: number };
type PageData = { items: TextItem[]; width: number; height: number; lineGroups: LineGroup[] };

function normalize(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function loadPageData(doc: Awaited<ReturnType<typeof getDocument>["promise"]>, pageNumber: number): Promise<PageData | null> {
  if (pageNumber < 1 || pageNumber > doc.numPages) return null;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = (content.items as TextItem[]).filter((item) => item.str?.trim() && item.transform);
    const lineGroups = new Map<string, LineGroup>();
    items.forEach((item) => {
      const y = Math.round((item.transform?.[5] ?? 0) / 2) * 2;
      const key = String(y);
      if (!lineGroups.has(key)) lineGroups.set(key, { items: [], text: "", y });
      const group = lineGroups.get(key)!;
      group.items.push(item);
      group.text += ` ${item.str}`;
    });
    return { items, width: viewport.width, height: viewport.height, lineGroups: [...lineGroups.values()] };
  } catch {
    return null;
  }
}

// Même calcul que dans dao-template-pdf.ts pour rester cohérent avec la
// taille utilisée pour masquer/écrire au même endroit sur la page :
// la diagonale de la partie "échelle" du transform pdf.js donne la taille de
// police réelle de cet item sur la page d'origine.
function fontSizeOfItem(item: TextItem | undefined): number | undefined {
  const transform = item?.transform;
  if (!transform) return undefined;
  return Math.hypot(transform[2] ?? 0, transform[3] ?? 0) || undefined;
}

// pdf.js ne renseigne pas toujours item.width pour un item de texte (constaté
// sur un vrai DAO, notamment pour une ligne de tableau sans pointillé comme
// "Numéro d'immatriculation Fiscale :") : le laisser tomber à 0 dans ce cas
// faisait croire que le libellé finissait là où il COMMENCE, donc que quasi
// toute la ligne était encore libre. La valeur se retrouvait alors placée
// PAR-DESSUS son propre libellé plutôt qu'à côté ; et dans dao-template-pdf.ts,
// la zone à masquer calculée à partir de cette position finissait par
// couvrir la quasi-totalité de l'item du libellé, qui disparaissait alors
// ENTIÈREMENT de la page — ne laissant que la valeur, flottante et sans
// étiquette (ex. un numéro d'immatriculation fiscale affiché seul, sans le
// texte "Numéro d'immatriculation Fiscale :" devant). Repli quand pdf.js ne
// donne pas de largeur : les métriques réelles d'une police standard
// (espacement différent selon la lettre, un "i" plus étroit qu'un "M") sont
// bien plus fiables qu'un simple facteur fixe par caractère — un premier
// essai avec un facteur fixe (0.55 fois la taille de police par caractère)
// sous-estimait encore ce même libellé et laissait déborder la valeur sur sa
// fin ("Numéro d'immatr" coupé, la valeur écrasant "iculation Fiscale :").
let widthEstimatorFontPromise: Promise<PDFFont> | null = null;
function getWidthEstimatorFont(): Promise<PDFFont> {
  if (!widthEstimatorFontPromise) {
    widthEstimatorFontPromise = PDFDocument.create().then((doc) => doc.embedFont(StandardFonts.Helvetica));
  }
  return widthEstimatorFontPromise;
}

function estimatedWidth(item: TextItem, fallbackFont: PDFFont): number {
  if (item.width) return item.width;
  const fontSize = fontSizeOfItem(item) ?? 10;
  try {
    return fallbackFont.widthOfTextAtSize(item.str ?? "", fontSize);
  } catch {
    // Un caractère que la police de secours ne sait pas mesurer ne doit
    // jamais faire échouer tout le repérage : on retombe sur l'ancienne
    // estimation approximative pour cet item précis seulement.
    return fontSize * (item.str ?? "").length * 0.55;
  }
}

// Avec exactement 2 mots-clés (un libellé court, très courant : "Date de
// signature", "Nom du signataire"...), le score ne peut valoir que 0%, 50%
// ou 100% — jamais 60% pile. Le seuil de 0.6 exige donc, sans le vouloir,
// que les DEUX mots correspondent pour ce genre de libellé, alors qu'un seul
// des deux mots correspond très souvent sur un DAO réel (le mot le plus
// spécifique, ex. "date" dans une case "Date: .........", pendant que
// "signature" n'apparaît nulle part sur cette ligne précise). minScore
// permet à l'appelant de retenter en seuil réduit UNIQUEMENT si la recherche
// stricte n'a rien trouvé, sans jamais changer un résultat déjà trouvé au
// seuil strict.
const STRICT_MATCH_SCORE = 0.6;
const RELAXED_MATCH_SCORE = 0.5;

// L'IA donne un vocabulaire "générique" pour chaque champ ("Nom du
// signataire", "Lieu de signature", "Raison sociale") mais un DAO réel utilise
// très souvent une formule juridique/administrative différente pour dire
// EXACTEMENT la même chose ("Je SOUSSIGNÉ...", "FAIT à...", "l'Entrepreneur",
// "les PRESTATIONS concernant..."). Ce n'est pas propre à un DAO précis : ce
// sont des formules standard qu'on retrouve d'un dossier à l'autre. Plutôt
// que de corriger au cas par cas à chaque nouveau DAO qui bute dessus, cette
// liste centralise les équivalences déjà repérées (un mot du libellé → ses
// synonymes usuels dans un DAO) : un mot du libellé compte comme trouvé sur
// une ligne si LUI ou l'un de ses synonymes y apparaît. Pour corriger un
// futur cas similaire, il suffit d'ajouter une entrée ici plutôt que de
// changer la logique de recherche.
const FIELD_LABEL_SYNONYMS: Record<string, string[]> = {
  signataire: ["soussigne"],
  lieu: ["fait"],
  raison: ["denomination"],
  sociale: ["societe", "entreprise", "entrepreneur", "candidat"],
  description: ["objet", "designation"],
  projet: ["marche", "convention", "offre", "prestations"],
  reference: ["numero"],
  delai: ["duree"],
  duree: ["delai"],
};

// Un DAO répète très souvent le même mot-clé sur PLUSIEURS lignes différentes
// (ex. "l'exécution" apparaît à la fois dans une ligne qui décrit juste le
// contexte, et dans la vraie ligne du blanc "...dans un délai de ..........
// Jours" un peu plus loin) — dans ce cas, les deux lignes obtiennent EXACTEMENT
// le même score, et seule la première rencontrée (la plus haute sur la page)
// l'emportait jusqu'ici, même si elle n'a aucun blanc à remplir. Une ligne qui
// contient VRAIMENT un pointillé est un bien meilleur candidat, à score égal,
// qu'une ligne de simple contexte sans aucun blanc — ce repère est générique
// (n'importe quel DAO répète du vocabulaire d'une ligne à l'autre).
const BLANK_RUN_PATTERN = /[.\-_·•∙]{4,}/;
function lineHasBlank(text: string): boolean {
  return BLANK_RUN_PATTERN.test(text);
}

/** Trouve, parmi les lignes de la page, celle qui correspond le mieux aux mots-clés d'un libellé. */
function findBestLine(lineGroups: LineGroup[], label: string, usedItems: Set<TextItem>, minScore: number = STRICT_MATCH_SCORE): LineGroup | null {
  const keywords = [...significantWords(label)].filter((word) => word.length >= 3);
  if (!keywords.length) return null;
  // Un mot très répété sur la page (le nom du DAO lui-même : "Appel
  // d'Offres" revient très souvent, dans quasiment tous les DAO) est un bien
  // moins bon indice qu'un mot rare et spécifique ("récépissé", "soussigné")
  // : il dit surtout "ceci est un DAO", pas "voici la bonne ligne". Sans cet
  // ajustement, un libellé qui contient LUI-MÊME ce genre de mot très
  // répété (ex. "Date de l'Appel d'Offres") pouvait s'accrocher à N'IMPORTE
  // laquelle des nombreuses lignes qui le mentionnent, y compris une ligne
  // sans aucun rapport — constaté sur un vrai DAO : ce champ volait le blanc
  // "...dans un délai de ...... Jours" destiné à un tout autre champ, juste
  // parce que "Appel d'Offres" y était aussi mentionné en passant. On calcule
  // ici, pour CHAQUE mot-clé, sa fréquence RÉELLE sur CETTE page précise
  // (jamais une liste de mots à écarter à la main : ça s'adapte tout seul au
  // vocabulaire propre à chaque DAO) et on réduit son poids en conséquence
  // seulement s'il dépasse 12% des lignes de la page — en dessous de ce
  // seuil, un mot qui revient 2 ou 3 fois reste un indice normal, à poids
  // plein.
  const totalLines = lineGroups.length || 1;
  const genericityFactor = new Map<string, number>();
  for (const word of keywords) {
    let frequency = 0;
    for (const group of lineGroups) {
      if (normalize(group.text).includes(word)) frequency += 1;
    }
    const ratio = frequency / totalLines;
    genericityFactor.set(word, ratio <= 0.12 ? 1 : Math.max(0.3, 0.12 / ratio));
  }
  let best: LineGroup | null = null;
  let bestScore = 0;
  let bestHasBlank = false;
  for (const group of lineGroups) {
    if (group.items.every((item) => usedItems.has(item))) continue;
    const normalizedLine = normalize(group.text);
    // Un mot du libellé retrouvé TEL QUEL sur la ligne est un indice bien plus
    // fiable qu'un de ses synonymes : un synonyme (ex. "offre" pour "projet",
    // "objet" pour "description") est très souvent AUSSI un mot courant du
    // jargon administratif d'un DAO qui revient un peu partout dans le texte
    // générique ("Appel d'Offres", "objet du présent marché"), sans rapport
    // avec le champ recherché. Compter un synonyme pour SEULEMENT 40% d'un
    // mot-clé (au lieu de 100% comme un mot trouvé tel quel) évite qu'un
    // champ s'accroche à une ligne de texte générique juste parce que deux
    // synonymes courants s'y trouvent par coïncidence — constaté sur un vrai
    // DAO : "Description du projet" (aucun des deux mots présent tel quel)
    // tombait sur une phrase parlant du délai d'exécution des travaux,
    // simplement parce qu'elle contenait "objets" et "offres", synonymes
    // respectifs de "description" et "projet".
    let weightedScore = 0;
    for (const word of keywords) {
      const factor = genericityFactor.get(word) ?? 1;
      if (normalizedLine.includes(word)) { weightedScore += 1 * factor; continue; }
      if ((FIELD_LABEL_SYNONYMS[word] ?? []).some((synonym) => normalizedLine.includes(synonym))) weightedScore += 0.4 * factor;
    }
    const score = weightedScore / keywords.length;
    if (score < minScore) continue;
    const hasBlank = lineHasBlank(group.text);
    // À score STRICTEMENT meilleur, on change toujours de ligne comme avant.
    // À score ÉGAL, on ne change que si la nouvelle ligne a un blanc à
    // remplir et pas l'actuelle — jamais l'inverse, pour ne jamais remplacer
    // une ligne déjà retenue par une moins bonne à score identique.
    if (score > bestScore || (score === bestScore && hasBlank && !bestHasBlank)) {
      bestScore = score;
      best = group;
      bestHasBlank = hasBlank;
    }
  }
  return best;
}

// Une fois le DÉBUT du blanc repéré avec précision (voir plus bas), il reste
// à savoir jusqu'où la zone à remplir peut s'agrandir SANS empiéter sur le
// texte qui vient juste après sur la même ligne. Repéré sur un vrai DAO :
// même avec un début de blanc mesuré au caractère près, un plancher fixe de
// largeur (pour qu'une valeur un peu longue tienne même si le pointillé
// d'origine était minuscule) agrandissait encore la zone bien au-delà du
// vrai pointillé et mangeait le début du texte suivant ("(nom, prénom,
// fonction)" affiché "f)", "concernant" affiché "ncernant") — cette mesure de
// précision ne servait qu'à trouver où le blanc COMMENCE, pas jusqu'où il est
// prudent de l'AGRANDIR ensuite. On cherche donc ici le premier texte RÉEL
// (pas un autre repère de blanc) sur la même ligne, à droite du blanc : la
// zone à remplir ne doit jamais s'étendre au-delà.
function nextRealTextX(items: TextItem[], afterX: number): number | null {
  let best: number | null = null;
  for (const item of items) {
    const itemX = item.transform?.[4] ?? 0;
    if (itemX <= afterX + 0.5) continue;
    if (isBlankMarkerRun(item.str ?? "")) continue;
    if (best === null || itemX < best) best = itemX;
  }
  return best;
}

// Quand la ligne trouvée pour un champ n'a AUCUN pointillé (ni en item à
// part, ni caché dans une phrase), on plaçait jusqu'ici la valeur juste EN
// DESSOUS de cette ligne, en supposant que cet espace était libre. Sur une
// lettre écrite en paragraphes qui s'enchaînent sans interligne (une phrase
// continue sur la ligne suivante), cet espace n'est PAS libre : il contient
// déjà la suite du texte du DAO, qui se retrouvait alors à moitié effacé par
// la valeur écrite par-dessus ("concernant l'exécution" affiché "ncernant
// l'exécution", "travaux" affiché "avaux" — constaté sur un vrai DAO). Cette
// fonction vérifie s'il existe déjà une ligne avec du texte RÉEL (pas
// seulement des pointillés) juste en dessous, pour ne jamais y placer une
// valeur à l'aveugle.
function hasRealContentBelow(lineGroups: LineGroup[], topY: number, fontSize: number): boolean {
  const minY = topY - fontSize * 2.2;
  const maxY = topY - fontSize * 0.4;
  return lineGroups.some((group) => group.y >= minY && group.y <= maxY && normalize(group.text).length > 4);
}

/** Cherche, pour chaque champ, la ligne de la page qui porte son libellé
 * (parmi candidatePages, dans l'ordre) et place la valeur juste à côté. */
export async function locateFieldPositions(pdfBytes: Uint8Array, candidatePages: number[], targets: FieldTarget[]): Promise<LocatedPosition[]> {
  if (!targets.length || !candidatePages.length) return [];
  const results: LocatedPosition[] = [];
  const foundKeys = new Set<string>();
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    const widthFont = await getWidthEstimatorFont();
    for (const pageNumber of candidatePages) {
      const pageTargets = targets.filter((target) => !foundKeys.has(target.field_key));
      if (!pageTargets.length) break;
      const pageData = await loadPageData(doc, pageNumber);
      if (!pageData) continue;
      const usedItems = new Set<TextItem>();
      for (const target of pageTargets) {
        // Le libellé donné par l'IA ("Nom du signataire") ne reprend pas
        // toujours le vocabulaire exact utilisé par LE DAO lui-même dans un
        // paragraphe de prose ("Je soussigné ... représentant ..."),
        // contrairement à un formulaire où le libellé du DAO est repris
        // quasi mot pour mot — constaté sur un vrai DAO ("Lettre de
        // soumission") : la plupart des champs ne trouvaient AUCUNE ligne
        // correspondante, qui gardait donc ses pointillés d'origine intacts
        // au lieu d'être remplie. On retente, dans l'ordre du plus fiable au
        // moins fiable, et on s'arrête au premier qui trouve quelque chose :
        // libellé seul (strict), libellé+description (strict), libellé seul
        // (seuil réduit), libellé+description (seuil réduit) — jamais
        // l'inverse, pour ne jamais remplacer un résultat déjà trouvé de
        // façon fiable par un résultat moins fiable.
        const bestLine = findBestLine(pageData.lineGroups, target.label, usedItems)
          ?? (target.description ? findBestLine(pageData.lineGroups, `${target.label} ${target.description}`, usedItems) : null)
          ?? findBestLine(pageData.lineGroups, target.label, usedItems, RELAXED_MATCH_SCORE)
          ?? (target.description ? findBestLine(pageData.lineGroups, `${target.label} ${target.description}`, usedItems, RELAXED_MATCH_SCORE) : null);
        if (!bestLine) continue;
        bestLine.items.forEach((item) => usedItems.add(item));
        const rightmost = bestLine.items.reduce((max, item) => Math.max(max, (item.transform?.[4] ?? 0) + estimatedWidth(item, widthFont)), 0);
        const topY = bestLine.items.reduce((min, item) => Math.min(min, item.transform?.[5] ?? min), bestLine.items[0].transform?.[5] ?? 0);
        // Le libellé lui-même est presque toujours suivi, SUR LA MÊME LIGNE,
        // d'un repère de blanc à remplir (".........", "______") : c'est LÀ,
        // et pas "à la fin de la ligne entière", que doit aller la valeur.
        // Sur une ligne de prose (lettre de soumission), la fin de la ligne
        // est presque toujours proche de la marge droite à cause de son
        // propre pointillé de fin de ligne — sans ce repérage, toutes les
        // valeurs de champs différents, sur des lignes différentes,
        // finissaient regroupées à la verticale près du bord droit de la
        // page au lieu d'apparaître chacune à l'endroit naturel de son
        // propre blanc.
        const blankRunItem = bestLine.items
          .filter((item) => isBlankMarkerRun(item.str ?? ""))
          .sort((left, right) => (left.transform?.[4] ?? 0) - (right.transform?.[4] ?? 0))[0];
        // Un DAO converti depuis Word regroupe très souvent TOUTE une phrase
        // dans un seul item pdf.js, pointillés compris ("Je soussigné
        // .............................. (nom, prénom, fonction)" est un
        // seul bloc) : le pointillé n'est alors jamais un item à part
        // entière (blankRunItem ci-dessus reste introuvable). On cherche
        // dans ce cas un ENCHAÎNEMENT de points/tirets/soulignés À
        // L'INTÉRIEUR d'un item plus long, et on interpole sa position
        // exacte au prorata de sa place dans le texte de cet item — même
        // principe que locateBracketPlaceholders pour un "[...]" qui ne
        // commence pas au tout début de son item.
        let embeddedBlank: { x: number; width: number; fontSize?: number; hardCap: boolean } | null = null;
        if (!blankRunItem) {
          const blankRunPattern = /[.\-_·•∙]{4,}/g;
          for (const item of bestLine.items) {
            const str = item.str ?? "";
            const itemX = item.transform?.[4] ?? 0;
            const itemFontSize = fontSizeOfItem(item) ?? 10;
            blankRunPattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = blankRunPattern.exec(str))) {
              // La position du pointillé À L'INTÉRIEUR de l'item se calculait
              // au prorata de son index de caractère (index / longueur totale
              // × largeur totale) — une estimation qui suppose que chaque
              // caractère a la MÊME largeur, ce qui n'est jamais vrai avec une
              // police à chasse variable (un "i" est bien plus étroit qu'un
              // "m"). Constaté sur un vrai DAO : ça décalait le début du
              // pointillé de quelques caractères vers la gauche, si bien que
              // la valeur écrite ensuite mangeait le début du mot suivant
              // ("en date du" affiché "n date du", "concernant" affiché
              // "ncernant"). On mesure ici la largeur RÉELLE du texte qui
              // précède le pointillé avec la même police de secours que
              // estimatedWidth, bien plus fidèle qu'une simple proportion.
              let startX: number;
              let endX: number;
              try {
                startX = itemX + widthFont.widthOfTextAtSize(str.slice(0, match.index), itemFontSize);
                endX = itemX + widthFont.widthOfTextAtSize(str.slice(0, match.index + match[0].length), itemFontSize);
              } catch {
                const itemWidth = estimatedWidth(item, widthFont);
                const itemLength = str.length || 1;
                startX = itemX + (match.index / itemLength) * itemWidth;
                endX = itemX + ((match.index + match[0].length) / itemLength) * itemWidth;
              }
              // Si du texte RÉEL (pas un autre repère de blanc) suit
              // IMMÉDIATEMENT le pointillé DANS LE MÊME ITEM ("....."
              // suivi tout de suite de "(nom, prénom, fonction)" dans le
              // même bloc de texte), ce texte reprend exactement à endX :
              // aucune marge d'agrandissement n'est alors possible sans
              // manger son tout début (voir nextSafeWidth plus bas).
              const trailingText = str.slice(match.index + match[0].length);
              const hardCap = trailingText.trim().length > 0 && !isBlankMarkerRun(trailingText);
              if (!embeddedBlank || startX < embeddedBlank.x) {
                embeddedBlank = { x: startX, width: Math.max(10, endX - startX), fontSize: fontSizeOfItem(item), hardCap };
              }
            }
          }
        }
        // estimatedWidth (et non ?? 40) : un repère de blanc qui est son
        // PROPRE item pdf.js entier (blankRunItem) n'a pas toujours de
        // item.width fiable non plus (même souci que pour le libellé, voir
        // plus haut) — un plancher fixe de 40 points tombait juste par
        // chance sur certains DAO, mais pas sur un pointillé nettement plus
        // court ou plus long que ça.
        const chosenBlank = blankRunItem
          ? { x: blankRunItem.transform?.[4] ?? rightmost + 4, width: Math.max(10, estimatedWidth(blankRunItem, widthFont)), fontSize: fontSizeOfItem(blankRunItem), hardCap: false }
          : embeddedBlank;
        // Largeur maximale que la zone à remplir peut atteindre sans jamais
        // empiéter sur le texte qui suit sur la même ligne : soit le texte
        // reprend tout de suite dans le MÊME item (hardCap → aucune marge
        // au-delà du pointillé mesuré), soit on cherche le prochain texte
        // réel parmi les autres items de la ligne (aucun trouvé → aucune
        // limite, la ligne est réellement libre au-delà du blanc).
        const maxSafeWidth = chosenBlank
          ? (chosenBlank.hardCap
            ? chosenBlank.width
            : (() => {
                const boundaryX = nextRealTextX(bestLine.items, chosenBlank.x);
                return boundaryX === null ? Infinity : Math.max(chosenBlank.width, boundaryX - chosenBlank.x - 2);
              })())
          : Infinity;
        const remainingWidth = pageData.width - rightmost;
        // Une valeur courte tient à droite du libellé sur la même ligne ;
        // sinon (label prenant déjà toute la largeur) on la place juste en
        // dessous, à l'alignement gauche de la ligne — mais SEULEMENT si
        // cette ligne du dessous est vraiment libre (voir hasRealContentBelow
        // plus haut) : sinon, mieux vaut une valeur un peu serrée en bout de
        // ligne d'origine qu'une valeur qui efface le début d'une phrase du
        // DAO qui continue juste en dessous.
        const placeBelow = !chosenBlank && remainingWidth < pageData.width * 0.12
          && !hasRealContentBelow(pageData.lineGroups, topY, fontSizeOfItem(bestLine.items[0]) ?? 10);
        const x = chosenBlank ? chosenBlank.x : placeBelow ? (bestLine.items[0].transform?.[4] ?? 0) : rightmost + 4;
        const y = placeBelow ? topY - 14 : topY;
        results.push({
          page: pageNumber,
          field_key: target.field_key,
          x_percent: Math.max(0, Math.min(96, (x / pageData.width) * 100)),
          y_percent: Math.max(0, Math.min(98, 100 - (y / pageData.height) * 100)),
          // Le plancher (15%) et le plafond (60%) donnent une largeur
          // confortable pour la valeur même quand le pointillé d'origine
          // était minuscule — mais jamais au prix de dépasser maxSafeWidth,
          // sous peine de manger le début du texte qui suit sur la même
          // ligne (voir maxSafeWidth plus haut).
          width_percent: chosenBlank
            ? Math.max(2, Math.min(Math.max(15, Math.min(60, (chosenBlank.width / pageData.width) * 100)), (maxSafeWidth / pageData.width) * 100))
            : placeBelow ? 60 : Math.max(15, Math.min(60, (remainingWidth / pageData.width) * 100 - 2)),
          // La taille du pointillé remplacé (ou, à défaut, celle du libellé
          // lui-même) reflète la taille de police réellement utilisée à cet
          // endroit précis de la page — plus fiable qu'une taille fixe.
          font_size: chosenBlank?.fontSize ?? fontSizeOfItem(bestLine.items[0]),
          debug_matched_line: bestLine.text.trim().slice(0, 100),
          debug_blank_kind: blankRunItem ? "blank-item" : embeddedBlank ? "embedded" : placeBelow ? "below-line" : "inline-after-label",
        });
        foundKeys.add(target.field_key);
      }
    }
  } catch {
    return results;
  }
  return results;
}

export type BracketZone = {
  page: number;
  field_key: string | null; // null = instruction pure (ex. "[insérer nom de la banque]" non reconnu) : à effacer sans rien écrire à la place
  x_percent: number;
  y_percent: number;
  width_percent: number;
  height_percent: number;
};

/**
 * Beaucoup de modèles DAO indiquent leurs blancs par une instruction entre
 * crochets en italique ("[insérer nom et adresse du Maître de l'Ouvrage]"),
 * que le DAO demande lui-même de retirer avant le dépôt ("le texte en
 * italique... devra être supprimé de la version officielle finale"). On
 * repère chaque crochet, on le fait correspondre à un champ connu par ses
 * mots-clés, et l'appelant efface la zone (rectangle blanc) avant d'écrire
 * la vraie valeur — ou la laisse simplement blanche si aucun champ ne
 * correspond (une pure instruction de préparation, pas un champ à remplir).
 */
export async function locateBracketPlaceholders(pdfBytes: Uint8Array, candidatePages: number[], fields: FieldTarget[]): Promise<BracketZone[]> {
  if (!candidatePages.length) return [];
  const results: BracketZone[] = [];
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    const widthFont = await getWidthEstimatorFont();
    for (const pageNumber of candidatePages) {
      if (pageNumber < 1 || pageNumber > doc.numPages) continue;
      try {
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items = (content.items as TextItem[]).filter((item) => item.str && item.transform);
        // Reconstruit le texte complet de la page avec, pour chaque
        // caractère, l'item pdf.js dont il provient — une instruction entre
        // crochets est parfois coupée sur plusieurs items (changement de
        // police italique en plein milieu), il faut donc pouvoir retrouver
        // TOUS les items couverts par un même "[...]".
        let fullText = "";
        const charItemMap: TextItem[] = [];
        // Position du caractère à l'intérieur de la chaîne de SON PROPRE item
        // (0, 1, 2, ...) — nécessaire pour retrouver la position horizontale
        // réelle d'un crochet qui ne commence pas au tout début de son item.
        const charLocalIndex: number[] = [];
        for (const item of items) {
          const str = item.str ?? "";
          for (let localIndex = 0; localIndex < str.length; localIndex += 1) {
            charItemMap.push(item);
            charLocalIndex.push(localIndex);
          }
          fullText += str;
        }
        const usedFieldKeys = new Set<string>();
        // Certaines instructions entre crochets sont de longs paragraphes
        // explicatifs (ex. "[La compagnie de garantie remplit cette garantie
        // d'offre conformément aux indications entre crochets...]" sur un
        // modèle de caution) : la limite précédente (220 caractères) était
        // trop courte pour ces cas-là, donc le crochet n'était jamais détecté
        // et son texte d'instruction restait visible tel quel dans le PDF
        // généré au lieu d'être effacé comme le DAO le demande lui-même.
        // Certains DAO (notamment les modèles de garantie/caution des DAO de
        // "fournitures") utilisent des chevrons "<...>" au lieu de crochets
        // "[...]" pour exactement le même genre d'instruction à remplacer
        // (ex. "<nom du Fournisseur>", "<insérer le montant en chiffres...>")
        // — sans cette deuxième alternative, ces pages n'avaient AUCUN
        // crochet détecté et gardaient tout le texte d'instruction original
        // visible, sans jamais recevoir de valeur.
        const bracketPattern = /\[([^[\]]{3,1200})\]|<([^<>]{3,1200})>/g;
        let match: RegExpExecArray | null;
        while ((match = bracketPattern.exec(fullText))) {
          const innerTextRaw = match[1] ?? match[2] ?? "";
          const innerStart = match.index + 1;
          const innerEnd = innerStart + innerTextRaw.length;
          const spanItems = [...new Set(charItemMap.slice(match.index, innerEnd + 1))];
          if (!spanItems.length) continue;
          // Sur un PDF à texte natif (ex. DAO "fournitures" converti depuis
          // Word), pdf.js regroupe souvent toute une phrase dans un SEUL item
          // au lieu d'un item par mot (contrairement aux DAO scannés/OCR où
          // chaque mot est presque toujours son propre item). Si un crochet
          // ne commence pas au tout début de son item ("ayant son siège
          // <adresse complète du Fournisseur>" est un seul item), prendre les
          // bornes de l'ITEM ENTIER comme largeur du crochet efface aussi le
          // texte légitime qui le précède ou le suit sur la même ligne — "ayant
          // son siège" disparaissait entièrement du document généré. On
          // interpole donc la position horizontale réelle de chaque caractère
          // du crochet au prorata de sa place dans la chaîne de son item,
          // plutôt que de prendre les bornes de l'item entier (comportement
          // inchangé quand un item ne contient QUE le crochet, comme sur les
          // DAO scannés : la portion couvre alors tout l'item de toute façon).
          let minX = Infinity;
          let maxX = -Infinity;
          for (let charIndex = match.index; charIndex <= innerEnd; charIndex += 1) {
            const item = charItemMap[charIndex];
            if (!item) continue;
            const itemX = item.transform?.[4] ?? 0;
            const localIndex = charLocalIndex[charIndex] ?? 0;
            const str = item.str ?? "";
            // Même mesure de largeur réelle que locateFieldPositions (au lieu
            // d'une proportion "index / longueur × largeur totale", imprécise
            // dès qu'un caractère plus étroit ou plus large que la moyenne
            // précède le crochet) — repli sur l'ancienne estimation
            // proportionnelle si un caractère n'est pas mesurable par la
            // police de secours.
            let charStartX: number;
            let charEndX: number;
            try {
              const itemFontSize = fontSizeOfItem(item) ?? 10;
              charStartX = itemX + widthFont.widthOfTextAtSize(str.slice(0, localIndex), itemFontSize);
              charEndX = itemX + widthFont.widthOfTextAtSize(str.slice(0, localIndex + 1), itemFontSize);
            } catch {
              const itemWidth = estimatedWidth(item, widthFont);
              const itemLength = str.length || 1;
              charStartX = itemX + (localIndex / itemLength) * itemWidth;
              charEndX = itemX + ((localIndex + 1) / itemLength) * itemWidth;
            }
            minX = Math.min(minX, charStartX);
            maxX = Math.max(maxX, charEndX);
          }
          if (!Number.isFinite(minX) || !Number.isFinite(maxX)) continue;
          const minY = spanItems.reduce((min, item) => Math.min(min, item.transform?.[5] ?? min), spanItems[0].transform?.[5] ?? 0);
          // Une instruction entre crochets peut s'étaler sur PLUSIEURS lignes
          // ("[insérer la somme en chiffres dans la monnaie du pays du Maître
          // de l'Ouvrage ou un montant équivalent...]" sur 3 lignes, constaté
          // sur un vrai DAO) : minY seul (la ligne la plus BASSE du crochet,
          // les coordonnées PDF montant vers le haut) ne couvrait alors que
          // la dernière ligne, laissant les lignes du dessus intactes avec
          // leur texte d'instruction original — jamais effacées comme le DAO
          // le demande, et un vrai risque de chevauchement avec la valeur
          // écrite juste en dessous. maxY (la ligne la plus HAUTE) permet de
          // couvrir tout l'intervalle vertical réellement occupé par le
          // crochet, qu'il tienne sur une seule ligne (minY === maxY, aucun
          // changement de comportement) ou plusieurs.
          const maxY = spanItems.reduce((max, item) => Math.max(max, item.transform?.[5] ?? max), spanItems[0].transform?.[5] ?? 0);
          const fontHeight = Math.max(8, ...spanItems.map((item) => Math.abs(item.transform?.[3] ?? 10)));
          const innerText = innerTextRaw;
          const keywords = [...significantWords(innerText)].filter((word) => word.length >= 3);
          let bestField: FieldTarget | null = null;
          let bestScore = 0;
          for (const field of fields) {
            if (usedFieldKeys.has(field.field_key)) continue;
            const fieldKeywords = [...significantWords(`${field.label} ${field.description ?? ""}`)].filter((word) => word.length >= 3);
            if (!fieldKeywords.length || !keywords.length) continue;
            const shared = fieldKeywords.filter((word) => keywords.includes(word)).length;
            // Diviser par le plus PETIT des deux côtés (comme avant) favorise
            // à tort un long paragraphe d'instruction générale ("[La banque
            // remplit ce modèle de garantie d'offre conformément aux
            // indications entre crochets]", 9 mots-clés) qui ne partage que
            // 2 mots très génériques ("garantie", "offre") avec un champ —
            // le score ne regarde alors que le côté du champ (3 mots-clés) et
            // ignore que ces 2 mots ne représentent presque rien du long
            // crochet en face. Constaté sur un vrai DAO : cette instruction
            // générale volait le champ "Garantie d'offre no." AVANT que le
            // vrai crochet "[insérer No de garantie]" ne soit lu, qui devait
            // alors se rabattre sur un autre champ, et ainsi de suite en
            // cascade sur plusieurs champs suivants. Le coefficient de Dice
            // (2×intersection / somme des deux tailles) exige que le
            // recoupement soit significatif des DEUX côtés à la fois, pas
            // seulement du plus petit — il rejette ce genre de faux positif
            // tout en acceptant toujours un crochet court et précis comme
            // "[insérer No de garantie]" face à son propre champ.
            const score = (2 * shared) / (fieldKeywords.length + keywords.length);
            if (score > bestScore && score >= 0.4) { bestScore = score; bestField = field; }
          }
          if (bestField) usedFieldKeys.add(bestField.field_key);
          results.push({
            page: pageNumber,
            field_key: bestField?.field_key ?? null,
            x_percent: Math.max(0, Math.min(98, (minX / viewport.width) * 100)),
            y_percent: Math.max(0, Math.min(99, 100 - (maxY / viewport.height) * 100) - (fontHeight / viewport.height) * 100),
            width_percent: Math.max(2, Math.min(90, ((maxX - minX) / viewport.width) * 100)),
            height_percent: Math.max(1, Math.min(40, ((maxY - minY + fontHeight * 1.3) / viewport.height) * 100)),
          });
        }
      } catch {
        // Page illisible : ces crochets resteront visibles sur cette page précise.
      }
    }
  } catch {
    return results;
  }
  return results;
}

/**
 * Mesure la largeur relative de chaque colonne d'un tableau telle qu'elle
 * apparaît réellement sur la page DAO (en repérant où commence l'en-tête de
 * chaque colonne), pour que le tableau reconstruit garde des proportions
 * proches de l'original au lieu d'une largeur égale arbitraire — une colonne
 * de désignation est presque toujours bien plus large qu'une colonne de
 * quantité ou d'unité à côté d'elle.
 */
export async function measureTableColumnRatios(pdfBytes: Uint8Array, candidatePages: number[], columns: string[]): Promise<number[] | null> {
  if (columns.length < 2 || !candidatePages.length) return null;
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    for (const pageNumber of candidatePages) {
      const pageData = await loadPageData(doc, pageNumber);
      if (!pageData) continue;
      const positions: number[] = [];
      const usedItems = new Set<TextItem>();
      // Plusieurs colonnes partagent souvent le même mot-clé ("Exercice du
      // 01/01/23", "01/01/24", "01/01/25" contiennent toutes "exercice") :
      // on cherche donc chaque colonne DANS L'ORDRE et on n'accepte qu'une
      // occurrence encore libre et située à droite de la colonne précédente,
      // pour assigner la bonne occurrence à la bonne colonne.
      let minX = -Infinity;
      for (const [columnIndex, column] of columns.entries()) {
        const keywords = [...significantWords(column)].filter((word) => word.length >= 3);
        if (!keywords.length) {
          // La toute première colonne d'un tableau DAO est presque toujours
          // la colonne de désignation, sans en-tête propre (juste ""), donc
          // sans aucun mot-clé à chercher : elle commence à la marge gauche
          // habituelle plutôt que d'être considérée comme introuvable.
          const assumed = columnIndex === 0 ? 54 : NaN;
          positions.push(assumed);
          if (!Number.isNaN(assumed)) minX = assumed;
          continue;
        }
        let bestItem: TextItem | null = null;
        let bestScore = 0;
        for (const group of pageData.lineGroups) {
          for (const item of group.items) {
            if (usedItems.has(item) || (item.transform?.[4] ?? -Infinity) <= minX) continue;
            const normalizedItem = normalize(item.str ?? "");
            if (!normalizedItem) continue;
            const matched = keywords.filter((word) => normalizedItem.includes(word)).length;
            const score = matched / keywords.length;
            if (score > bestScore && score >= 0.5) { bestScore = score; bestItem = item; }
          }
        }
        if (bestItem) { usedItems.add(bestItem); minX = bestItem.transform?.[4] ?? minX; }
        positions.push(bestItem?.transform?.[4] ?? NaN);
      }
      if (positions.some((value) => Number.isNaN(value))) continue;
      const sorted = [...positions].sort((left, right) => left - right);
      // Les positions doivent suivre le même ordre que les colonnes déclarées
      // (de gauche à droite) : sinon la mesure n'est pas fiable pour ce tableau.
      if (JSON.stringify(sorted) !== JSON.stringify(positions)) continue;
      const widths = positions.map((start, index) => (index < positions.length - 1 ? positions[index + 1] - start : Math.max(pageData.width - start, 20)));
      if (widths.some((width) => width <= 0)) continue;
      return widths;
    }
  } catch {
    return null;
  }
  return null;
}

type TableCellTarget = { field_key: string; row_label: string; column_label: string };

/**
 * Même principe que locateFieldPositions, mais pour une cellule de tableau :
 * la ligne qui porte le libellé de LIGNE donne le Y, la ligne d'en-tête qui
 * porte le libellé de COLONNE donne le X — la valeur va à leur intersection,
 * directement dans la case du tableau imprimé sur la page DAO.
 */
export async function locateTableCellPositions(pdfBytes: Uint8Array, candidatePages: number[], targets: TableCellTarget[]): Promise<LocatedPosition[]> {
  if (!targets.length || !candidatePages.length) return [];
  const results: LocatedPosition[] = [];
  const foundKeys = new Set<string>();
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    const widthFont = await getWidthEstimatorFont();
    for (const pageNumber of candidatePages) {
      const pageTargets = targets.filter((target) => !foundKeys.has(target.field_key));
      if (!pageTargets.length) break;
      const pageData = await loadPageData(doc, pageNumber);
      if (!pageData) continue;
      // Les en-têtes de colonnes sont toujours au-dessus des lignes de
      // données : on les cherche une seule fois par page, sans les marquer
      // "utilisés", puisque plusieurs lignes partagent la même colonne.
      const columnUsed = new Set<TextItem>();
      const rowUsed = new Set<TextItem>();
      for (const target of pageTargets) {
        const columnLine = findBestLine(pageData.lineGroups, target.column_label, columnUsed);
        const rowLine = findBestLine(pageData.lineGroups, target.row_label, rowUsed);
        if (!columnLine || !rowLine) continue;
        rowUsed.clear();
        rowLine.items.forEach((item) => rowUsed.add(item));
        const columnStart = columnLine.items.reduce((min, item) => Math.min(min, item.transform?.[4] ?? min), columnLine.items[0].transform?.[4] ?? 0);
        const columnEnd = columnLine.items.reduce((max, item) => Math.max(max, (item.transform?.[4] ?? 0) + estimatedWidth(item, widthFont)), 0);
        const rowY = rowLine.items.reduce((min, item) => Math.min(min, item.transform?.[5] ?? min), rowLine.items[0].transform?.[5] ?? 0);
        results.push({
          page: pageNumber,
          field_key: target.field_key,
          x_percent: Math.max(0, Math.min(96, (columnStart / pageData.width) * 100)),
          y_percent: Math.max(0, Math.min(98, 100 - (rowY / pageData.height) * 100)),
          width_percent: Math.max(10, Math.min(40, ((columnEnd - columnStart) / pageData.width) * 100 - 2)),
          // Taille du libellé de LIGNE ("Travaux", "Fournitures"...) : c'est
          // le texte le plus proche de la case remplie dans ce tableau.
          font_size: fontSizeOfItem(rowLine.items[0]),
        });
        foundKeys.add(target.field_key);
      }
    }
  } catch {
    return results;
  }
  return results;
}
