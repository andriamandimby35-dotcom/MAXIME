import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import { embedUnicodeFonts } from "./pdf-font";
import "@/lib/submission/pdfjs-worker-setup";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// field_size (facultatif) : taille de police RÉELLE du texte trouvé à cet
// emplacement sur la page DAO d'origine (calculée par locateFieldPositions /
// locateTableCellPositions à partir du "transform" pdf.js de l'item repéré),
// pour que la valeur écrite se fonde dans le texte environnant au lieu
// d'utiliser systématiquement une taille fixe qui jure avec le reste de la
// page (ex. libellés en 11pt, valeur toujours en 8pt) — constaté sur un vrai
// DAO ("Lettre de soumission") : les valeurs ajoutées semblaient "collées
// depuis un autre document" plutôt que recopiées à la main.
type FillPosition = { page: number; field_key: string; x_percent: number; y_percent: number; width_percent: number; font_size?: number };
type RedactionZone = { page: number; field_key: string | null; x_percent: number; y_percent: number; width_percent: number; height_percent: number };
type Rect = { x: number; y: number; width: number; height: number };

function rectsOverlap(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// Même calcul que la boucle "redactions" plus bas (garde le même rectangle
// blanchi), mais renvoyé comme zone à NE PAS redessiner pendant la
// reconstruction de la page, au lieu d'un rectangle dessiné par-dessus.
function redactionRect(width: number, height: number, zone: RedactionZone): Rect {
  const x = width * Math.max(0, Math.min(100, zone.x_percent)) / 100;
  const boxHeight = height * Math.max(0, Math.min(100, zone.height_percent)) / 100;
  const y = height - (height * Math.max(0, Math.min(100, zone.y_percent)) / 100) - boxHeight;
  const boxWidth = width * Math.max(1, Math.min(100, zone.width_percent)) / 100;
  return { x: x - 1, y: y - 1, width: boxWidth + 2, height: boxHeight + 2 };
}

// DejaVu Sans (notre police unique, voir pdf-font.ts) dessine sensiblement
// plus "large"/plus épais qu'une police système classique (Arial, Calibri...)
// à la même taille déclarée — vérifié en comparant un même mot dessiné avec
// notre police à deux tailles très différentes : l'écart de taille SEUL, avec
// une police pourtant identique, donne déjà l'impression d'"une autre
// police", plus grasse. Or le texte reconstruit (drawReconstructedItem)
// RÉDUIT sa taille dès que notre police déborderait la largeur d'origine
// (fréquent, justement à cause de cet écart), alors qu'une VALEUR insérée
// gardait jusqu'ici sa taille d'origine intacte, sans jamais subir la même
// réduction — repéré sur un vrai DAO ("Lettre de soumission") : les valeurs
// ajoutées ("ANDRIAMANDIMBY MAXIME", "150"...) semblaient dans une police
// différente, plus grasse, du texte reconstruit autour, alors que c'est
// exactement la même police de caractères. Ce facteur réduit LES DEUX
// (valeurs et texte reconstruit, voir plus bas) du même pourcentage avant
// toute autre logique, pour qu'elles restent visuellement cohérentes entre
// elles au lieu que seul le texte reconstruit compense l'écart.
const FONT_SIZE_SAFETY = 0.9;

// Une taille de police en dehors de cette fourchette serait soit illisible
// (trop petite), soit ne rentrerait plus dans la case d'origine du DAO (trop
// grande) — les mêmes bornes que la boucle "redactions" plus bas, qui a fait
// ses preuves pour ce genre de valeur courte insérée sur une page existante.
function clampFontSize(size: number | undefined) {
  return Math.max(6, Math.min(11, (size ?? 8) * FONT_SIZE_SAFETY));
}

// Même calcul que la boucle "positions" plus bas (garde le même rectangle
// blanchi), en zone à ne pas redessiner plutôt qu'en rectangle dessiné.
//
// y_percent vient directement de la ligne de base RÉELLE du texte repérée par
// locateFieldPositions/locateTableCellPositions sur la page (position "y" du
// texte pdf.js, déjà une ligne de base — pas le HAUT d'une case). Soustraire
// encore une fois fontSize ici (comme avant ce correctif) décalait la valeur
// ÉCRITE — et le rectangle blanc qui l'accompagne — d'une pleine taille de
// police plus bas que la ligne de base d'origine, soit quasiment UNE LIGNE
// ENTIÈRE plus bas sur la page. Repéré sur un vrai DAO : une valeur qui
// devrait apparaître à côté de son libellé atterrissait systématiquement sur
// la ligne SUIVANTE du modèle, effaçant et recouvrant le début du texte
// original qui s'y trouvait déjà ("concernant l'exécution" affiché "ncernant
// l'exécution", "travaux" affiché "avaux") — ce n'était donc pas un problème
// de largeur de zone ni de mauvaise ligne repérée, mais cette seule
// soustraction en trop à CET endroit précis, pour tous les documents.
function positionRect(width: number, height: number, position: FillPosition): Rect {
  const fontSize = clampFontSize(position.font_size);
  // 1.5x la taille de police dépassait souvent l'espacement RÉEL entre deux
  // lignes d'un DAO à simple interligne (repéré sur un vrai DAO : ~1.27x la
  // taille de police entre deux lignes, soit MOINS que 1.5x) — cette zone,
  // pourtant censée ne couvrir QUE le pointillé de sa propre ligne, débordait
  // alors sur la ligne du DESSUS et pouvait y trouver un autre pointillé
  // (parfois un simple trait décoratif du DAO, sans rapport avec ce champ) :
  // drawReconstructedItem l'effaçait et y écrivait la valeur par erreur, sur
  // la mauvaise ligne, pendant que la VRAIE ligne gardait son pointillé
  // effacé mais sans aucune valeur écrite à la place. 1.1x reste largement
  // suffisant pour couvrir un pointillé (qui ne dépasse jamais beaucoup la
  // ligne de base) sans jamais atteindre la ligne voisine.
  const coverHeight = fontSize * 1.1;
  const available = Math.max(10, width * Math.max(1, Math.min(90, position.width_percent)) / 100);
  const x = width * Math.max(0, Math.min(100, position.x_percent)) / 100;
  const y = height - (height * Math.max(0, Math.min(100, position.y_percent)) / 100);
  return { x: x - 1, y: y - coverHeight * 0.25, width: available + 2, height: coverHeight };
}

function estimatedWidth(text: string, fontSize: number, realWidth: number | undefined, fallbackFont: PDFFont): number {
  if (realWidth) return realWidth;
  try {
    return fallbackFont.widthOfTextAtSize(text, fontSize);
  } catch {
    return fontSize * text.length * 0.55;
  }
}

// Convertit une largeur cible (mesurée depuis le début du texte) en indice de
// caractère — nécessaire pour transformer le recouvrement GÉOMÉTRIQUE d'une
// zone entre crochets (qui n'a aucun motif de texte reconnaissable, contrairement
// à un pointillé) en une vraie portion de texte à ne pas redessiner.
function charIndexAtWidth(text: string, fontSize: number, font: PDFFont, targetWidth: number): number {
  if (targetWidth <= 0) return 0;
  let cumulative = 0;
  for (let index = 0; index < text.length; index += 1) {
    cumulative += estimatedWidth(text[index], fontSize, undefined, font);
    if (cumulative > targetWidth) return index;
  }
  return text.length;
}

// Redessine un item de texte de la page DAO d'origine sur la page NEUVE,
// exactement à sa position d'origine (même x/y, même taille de police
// estimée) — voir le commentaire au-dessus de createFilledDaoTemplatePdf pour
// le pourquoi de cette reconstruction complète plutôt qu'une copie masquée.
// Un DAO converti depuis Word regroupe très souvent TOUTE une phrase dans un
// SEUL item pdf.js ("La garantie est émise par [Nom de la banque] domiciliée
// à..." ou "Je soussigné .............. (nom, prénom, fonction)" restent un
// seul bloc de texte) : on ne saute donc jamais l'item ENTIER, seulement la
// portion précise concernée, pour ne jamais effacer du texte normal juste
// avant ou après elle.
// - Une zone entre crochets ("[Nom de la banque]") disparaît TOUJOURS, avec
//   ou sans valeur connue (c'est une instruction du DAO à effacer avant
//   dépôt, jamais un repère à laisser pour un remplissage à la main).
// - Un pointillé de blanc ("....... ", "______") ne disparaît LUI que s'il va
//   recevoir une vraie valeur à la place (filledZones) : sans valeur connue,
//   il reste affiché tel quel, pour qu'on puisse encore le compléter à la
//   main sur le document imprimé.
type FillZone = Rect & { field_key: string; value: string };

function drawReconstructedItem(
  page: PDFPage,
  item: { str?: string; transform?: number[]; width?: number },
  font: PDFFont,
  filledZones: FillZone[],
  redactionZones: Rect[],
  drawnFieldKeys: Set<string>,
) {
  const text = item.str ?? "";
  if (!text.trim()) return;
  const transform = item.transform ?? [10, 0, 0, 10, 0, 0];
  const x = transform[4] ?? 0;
  const y = transform[5] ?? 0;
  let fontSize = Math.max(4, Math.hypot(transform[2] ?? 0, transform[3] ?? 10) * FONT_SIZE_SAFETY);
  // La police qu'on dessine (DejaVu Sans, embarquée pour tout le document) ne
  // rend jamais un texte EXACTEMENT à la même largeur que la police d'origine
  // du DAO (souvent une police système différente) — mesurer et dessiner
  // avec CETTE MÊME police partout (jamais une police de secours séparée
  // seulement pour mesurer) évite déjà un premier décalage. Il reste un
  // second risque : même mesurée correctement, notre police peut rendre un
  // mot plus LARGE que sa place d'origine sur le DAO, empiétant alors sur le
  // mot suivant (repéré sur un vrai DAO : du texte qui se touchait, sans
  // aucun espace visible, à plusieurs endroits). Quand pdf.js connaît la
  // largeur RÉELLE d'origine de cet item, on réduit légèrement la taille de
  // police SEULEMENT pour lui si besoin, afin de ne jamais dépasser la place
  // qu'il occupait vraiment sur la page d'origine.
  const naturalWidth = estimatedWidth(text, fontSize, undefined, font);
  if (item.width && item.width > 0 && naturalWidth > item.width) {
    fontSize *= Math.max(0.6, item.width / naturalWidth);
  }
  const itemWidth = estimatedWidth(text, fontSize, undefined, font);
  const itemBox: Rect = { x, y: y - fontSize * 0.3, width: itemWidth, height: fontSize * 1.3 };

  const removedRanges: Array<[number, number]> = [];
  // La valeur d'un champ "embedded"/"blank-item" (un pointillé repéré DANS ou
  // COMME un item de texte, voir locate-field-positions.ts) est maintenant
  // écrite ICI MÊME, exactement là où le pointillé vient d'être effacé —
  // jamais plus via une position/taille recalculée séparément (x_percent...)
  // plus bas dans createFilledDaoTemplatePdf. Avant ce correctif, les deux
  // calculs (ici pour effacer, là-bas pour écrire) utilisaient déjà la même
  // police mais PAS la même taille : ICI la taille est celle RÉELLEMENT
  // utilisée pour cet item après réduction éventuelle (voir fontSize plus
  // haut), alors que la position/taille calculée séparément ignorait cette
  // réduction — repéré sur un vrai DAO : la valeur "150" (délai d'exécution)
  // atterrissait décalée, empiétant sur le mot "Jours" juste après, alors que
  // le pointillé lui-même était pourtant effacé au bon endroit. Réutiliser
  // ICI la géométrie déjà calculée pour l'effacement élimine ce décalage à la
  // racine, au lieu de faire confiance à un second calcul indépendant.
  const valuesToDraw: Array<{ x: number; text: string; maxWidth: number }> = [];
  if (itemWidth > 0) {
    for (const zone of redactionZones) {
      if (!rectsOverlap(zone, itemBox)) continue;
      const startWidth = Math.max(zone.x, x) - x;
      const endWidth = Math.min(zone.x + zone.width, x + itemWidth) - x;
      if (endWidth <= startWidth) continue;
      removedRanges.push([charIndexAtWidth(text, fontSize, font, startWidth), charIndexAtWidth(text, fontSize, font, endWidth)]);
    }
  }
  const blankPattern = /[.\-_·•∙\u2026]{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = blankPattern.exec(text))) {
    const startWidth = estimatedWidth(text.slice(0, match.index), fontSize, undefined, font);
    const endWidth = estimatedWidth(text.slice(0, match.index + match[0].length), fontSize, undefined, font);
    const segmentBox: Rect = { x: x + startWidth, y: y - fontSize * 0.3, width: endWidth - startWidth, height: fontSize * 1.3 };
    const matchedZone = filledZones.find((zone) => rectsOverlap(zone, segmentBox));
    if (!matchedZone) continue;
    removedRanges.push([match.index, match.index + match[0].length]);
    // Un champ trouvé par PLUSIEURS items (une zone large qui chevauche deux
    // bouts de texte voisins) ne doit être écrit qu'UNE SEULE fois — jamais
    // une deuxième fois sur un autre item qui chevauche la même zone.
    if (drawnFieldKeys.has(matchedZone.field_key)) continue;
    drawnFieldKeys.add(matchedZone.field_key);
    // La largeur disponible reste celle, généreuse, de la zone calculée par
    // locateFieldPositions (au moins 15% de la page) plutôt que la largeur
    // brute du pointillé d'origine (parfois minuscule) — pour qu'une valeur
    // plus longue que le pointillé garde de la place, comme avant.
    valuesToDraw.push({ x: x + startWidth, text: matchedZone.value, maxWidth: Math.max(endWidth - startWidth, matchedZone.width) });
  }
  if (!removedRanges.length) {
    page.drawText(sanitizeForPdf(text), { x, y, size: fontSize, font, color: rgb(0, 0, 0) });
    return;
  }

  // Fusionne les portions à ne pas redessiner (une zone entre crochets peut
  // très bien chevaucher un pointillé, ex. "[......]") avant de dessiner ce
  // qui reste, morceau par morceau, à sa vraie position dans l'item.
  removedRanges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of removedRanges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) {
      const slice = text.slice(cursor, start);
      const offsetX = estimatedWidth(text.slice(0, cursor), fontSize, undefined, font);
      if (slice.trim()) page.drawText(sanitizeForPdf(slice), { x: x + offsetX, y, size: fontSize, font, color: rgb(0, 0, 0) });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) {
    const slice = text.slice(cursor);
    const offsetX = estimatedWidth(text.slice(0, cursor), fontSize, undefined, font);
    if (slice.trim()) page.drawText(sanitizeForPdf(slice), { x: x + offsetX, y, size: fontSize, font, color: rgb(0, 0, 0) });
  }
  // Écrites en dernier, à la même taille (fontSize) que le reste de CET item
  // — jamais une taille recalculée ailleurs — pour ne jamais rejouer le
  // décalage décrit plus haut.
  for (const value of valuesToDraw) {
    const maxChars = Math.max(4, Math.floor(value.maxWidth / (fontSize * 0.55)));
    page.drawText(compact(value.text, maxChars), { x: value.x, y, size: fontSize, font, color: rgb(0, 0, 0) });
  }
}

// drawText lève une exception (qui fait échouer TOUT le PDF en silence,
// repli sur un résumé générique sans page réelle) dès qu'un caractère n'est
// pas encodable par la police utilisée — notamment l'espace fine insécable
// U+202F que toLocaleString("fr-FR") insère entre les milliers d'un montant.
// On remplace d'abord les espaces Unicode par un espace normal.
const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;
// Depuis l'usage d'une police DejaVu Sans embarquee (voir pdf-font.ts), la
// couverture Unicode est bien plus large que l'ancien encodage WinAnsi :
// alphabet latin etendu (oe, Y tremas, S caron...), grec, cyrillique,
// armenien, une bonne partie des symboles et de la ponctuation technique. On
// ne bloque donc plus que les blocs que cette police ne couvre vraiment pas
// (ideogrammes CJK, hangul, emojis...), pour que le repli "?" ne serve plus
// qu'en dernier recours au lieu d'etre la norme.
const UNSUPPORTED_BLOCKS = /[\u2E80-\uA4CF\uAC00-\uD7FF\uF900-\uFFFF\u{1F000}-\u{1FFFF}]/gu;

export function sanitizeForPdf(value: string) {
  return value.replace(UNICODE_SPACES, " ").replace(UNSUPPORTED_BLOCKS, "?");
}

function compact(value: string, maximum: number) {
  const safe = sanitizeForPdf(value);
  return safe.length > maximum ? `${safe.slice(0, Math.max(1, maximum - 1))}…` : safe;
}

/**
 * Reconstruit chaque page nous-mêmes, mot par mot, à sa position d'origine
 * exacte (repérée par pdf.js) — plus jamais une copie de la vraie page du DAO
 * masquée par un rectangle blanc avant d'écrire une valeur par-dessus.
 *
 * Historique : la première version de cette fonction gardait la page DAO
 * copiée à l'identique (cadres, pointillés, logos...) et peignait juste un
 * petit rectangle blanc sur chaque pointillé avant d'écrire la valeur. Ça
 * évitait de perdre les traits qui forment les cadres et tableaux du DAO,
 * mais restait fragile : un masquage un peu trop court laissait un bout de
 * pointillé visible à côté de la valeur, et le texte d'origine (police du
 * DAO) jurait visuellement avec la valeur ajoutée (police différente). En
 * reconstruisant nous-mêmes CHAQUE mot du texte d'origine sur une page vierge
 * (même position, même taille, une seule police cohérente pour toute la
 * page), ces deux défauts disparaissent : il n'y a plus rien à "masquer",
 * juste des pointillés qu'on choisit ou non de redessiner. Seul ce qui n'est
 * PAS du texte (traits de cadre, logos, tampons) disparaît avec cette
 * méthode — accepté : un tableau connu (voir route.ts, printable-pdf.ts) est
 * redessiné à part avec ses propres traits, et le reste d'un DAO est en
 * général du texte pur, sans élément graphique essentiel.
 *
 * documentTitle (facultatif) est le VRAI titre confirmé (majuscules + gras)
 * retrouvé sur la page DAO elle-même par
 * extractRelevantPageRange/locateTitleInFullDocument : écrit dans les
 * PROPRIÉTÉS du fichier PDF (titre du document), jamais dessiné sur la page.
 */
export async function createFilledDaoTemplatePdf(source: Uint8Array, pageNumbers: number[], positions: FillPosition[], rawValues: Record<string, string>, redactions: RedactionZone[] = [], documentTitle?: string | null, options: { rebuildAsText?: boolean } = {}) {
  // Une valeur censée être écrite telle quelle sur la page (ici, contrairement
  // au texte/tableaux de route.ts, jamais passée par replaceTemplateFields)
  // ne doit jamais contenir elle-même un repère "{{...}}" non résolu — ça
  // arrive quand l'IA d'analyse renvoie par erreur sa PROPRE syntaxe de
  // modèle comme valeur préremplie au lieu de la vraie donnée. Un tel repère
  // imprimé tel quel sur un document à signer a l'air d'un bug logiciel :
  // on l'efface plutôt, exactement comme une case sans valeur connue.
  const values = Object.fromEntries(
    Object.entries(rawValues).map(([key, value]) => [key, (value ?? "").replace(/\{\{[^{}]{1,80}\}\}/g, "").trim()]),
  );
  const sourcePdf = await PDFDocument.load(source);
  const validPages = [...new Set(pageNumbers.map((page) => Math.floor(page)).filter((page) => page >= 1 && page <= sourcePdf.getPageCount()))];
  if (!validPages.length) throw new Error("Aucune page de modèle exploitable.");
  // positions (recherche du libellé sur la page, une estimation "à côté ou en
  // dessous du texte") et redactions (un "[...]" repéré et effacé) sont
  // calculés INDÉPENDAMMENT, à partir des mêmes champs — un même champ peut
  // donc très bien être retrouvé par les deux méthodes à la fois. Sans ce
  // filtre, sa valeur était alors écrite DEUX FOIS sur la page, à deux
  // endroits différents. Le crochet repéré marque toujours l'emplacement
  // exact de la case sur le modèle du DAO (plus fiable qu'une estimation par
  // libellé) : c'est donc toujours lui qui l'emporte quand les deux se
  // disputent le même champ.
  const fieldKeysHandledByRedaction = new Set(redactions.map((zone) => zone.field_key).filter((key): key is string => Boolean(key)));
  const dedupedPositions = positions.filter((position) => !fieldKeysHandledByRedaction.has(position.field_key));
  const result = await PDFDocument.create();
  if (documentTitle?.trim()) result.setTitle(compact(documentTitle.trim(), 200));
  const { font } = await embedUnicodeFonts(result);

  if (!options.rebuildAsText) {
    // Un plan technique (dessin vectoriel, aucun texte à remplacer) ou un
    // modèle de panneau/logo (voir l'appelant) n'a jamais de position à
    // remplir : la page reste alors copiée à l'identique, jamais reconstruite
    // — la copie fidèle est strictement meilleure ici (fidélité parfaite,
    // aucun risque, et rien à reconstruire de toute façon).
    const copiedPages = await result.copyPages(sourcePdf, validPages.map((page) => page - 1));
    copiedPages.forEach((page) => result.addPage(page));
    return Buffer.from(await result.save());
  }

  let pdfJsDoc: Awaited<ReturnType<typeof getDocument>["promise"]> | null = null;
  try {
    pdfJsDoc = await getDocument({ data: source.slice(), useSystemFonts: true }).promise;
  } catch {
    pdfJsDoc = null; // Repli silencieux : la page reste vide plutôt que de faire échouer tout le document — n'arrive presque jamais en pratique.
  }
  for (const pageNumber of validPages) {
    const sourcePageSize = sourcePdf.getPage(pageNumber - 1).getSize();
    const page = result.addPage([sourcePageSize.width, sourcePageSize.height]);
    const pageRedactionZones = redactions.filter((zone) => Math.floor(zone.page) === pageNumber);
    const pageRedactionRects = pageRedactionZones.map((zone) => redactionRect(sourcePageSize.width, sourcePageSize.height, zone));
    const pagePositions = dedupedPositions.filter((position) => Math.floor(position.page) === pageNumber);
    // Un pointillé n'est effacé de la reconstruction QUE s'il va vraiment
    // recevoir une valeur (voir drawReconstructedItem) : un champ retrouvé
    // mais sans valeur connue garde ses pointillés d'origine intacts. Chaque
    // zone porte maintenant SA PROPRE valeur (field_key + value) : c'est
    // drawReconstructedItem qui écrit directement la valeur au bon endroit
    // pendant l'effacement, plutôt qu'un second calcul de position séparé.
    const pageFilledZones = pagePositions
      .filter((position) => values[position.field_key]?.trim())
      .map((position) => ({ ...positionRect(sourcePageSize.width, sourcePageSize.height, position), field_key: position.field_key, value: values[position.field_key].trim() }));
    // Rempli au fil de la reconstruction ci-dessous : les champs déjà écrits
    // directement dans leur pointillé d'origine (voir drawReconstructedItem)
    // ne doivent plus être réécrits une seconde fois par la boucle
    // "pagePositions" plus bas — celle-ci ne sert plus qu'aux champs SANS
    // aucun pointillé trouvé (blank_kind "inline-after-label"/"below-line").
    const drawnFieldKeys = new Set<string>();

    if (pdfJsDoc) {
      try {
        const pdfJsPage = await pdfJsDoc.getPage(pageNumber);
        const content = await pdfJsPage.getTextContent();
        const items = (content.items as Array<{ str?: string; transform?: number[]; width?: number }>).filter((item) => (item.str ?? "").trim().length > 0 && item.transform);
        for (const item of items) drawReconstructedItem(page, item, font, pageFilledZones, pageRedactionRects, drawnFieldKeys);
      } catch {
        // Page illisible pour pdf.js : elle reste vide plutôt que de faire
        // échouer tout le document généré — n'arrive presque jamais en
        // pratique (déjà lue une première fois avec succès pour calculer
        // positions/redactions).
      }
    }

    // Une instruction entre crochets du DAO ("[insérer nom de la banque]") a
    // déjà disparu ci-dessus (drawReconstructedItem saute tout item qui la
    // chevauche) : seule la vraie valeur reste à écrire, si elle existe.
    for (const zone of pageRedactionZones) {
      const value = zone.field_key ? values[zone.field_key]?.trim() : "";
      if (!value) continue;
      const rect = redactionRect(sourcePageSize.width, sourcePageSize.height, zone);
      const fontSize = Math.max(6, Math.min(9, rect.height * 0.72 * FONT_SIZE_SAFETY));
      const maxChars = Math.max(4, Math.floor(rect.width / (fontSize * 0.55)));
      // La valeur doit apparaître là où commençait le texte entre crochets
      // d'origine, donc en haut de la zone effacée — pas au milieu de sa
      // hauteur totale, qui peut être grande pour une instruction sur
      // plusieurs lignes.
      const textY = rect.y + rect.height - fontSize * 1.05;
      page.drawText(compact(value, maxChars), { x: rect.x + 1, y: textY, size: fontSize, font, color: rgb(0, 0, 0) });
    }
    // Champ SANS aucun pointillé trouvé sur la page (blank_kind
    // "inline-after-label"/"below-line" : la valeur est ajoutée après le
    // libellé ou sur la ligne du dessous, faute de repère précis à effacer).
    // Un champ "embedded"/"blank-item" a déjà été écrit directement dans son
    // pointillé ci-dessus (drawnFieldKeys) : ne plus le réécrire ici.
    for (const position of pagePositions) {
      if (drawnFieldKeys.has(position.field_key)) continue;
      const value = values[position.field_key]?.trim();
      if (!value) continue;
      const fontSize = clampFontSize(position.font_size);
      const available = Math.max(10, sourcePageSize.width * Math.max(1, Math.min(90, position.width_percent)) / 100);
      const x = sourcePageSize.width * Math.max(0, Math.min(100, position.x_percent)) / 100;
      const y = sourcePageSize.height - (sourcePageSize.height * Math.max(0, Math.min(100, position.y_percent)) / 100);
      const maxChars = Math.max(4, Math.floor(available / 4.2));
      page.drawText(compact(value, maxChars), { x, y, size: fontSize, font, color: rgb(0, 0, 0) });
    }
  }
  return Buffer.from(await result.save());
}

/**
 * NOUVELLE méthode demandée par Maxime : au lieu de redessiner nous-mêmes
 * chaque mot de la page (createFilledDaoTemplatePdf ci-dessus, méthode
 * fragile — des dizaines de corrections de décalage de quelques pixels ont
 * déjà été nécessaires), on garde la VRAIE page du DAO copiée à l'identique
 * (cadres, tableaux, papier en-tête, tout), et on pose par-dessus de VRAIES
 * cases à remplir cliquables (des champs de formulaire PDF, pas du texte
 * peint en dur) : préremplies quand la valeur est déjà connue, vides et
 * modifiables sinon. L'utilisateur peut alors les compléter lui-même dans
 * SA PROPRE application PDF (téléphone ou ordinateur), exactement comme un
 * formulaire PDF classique — plus besoin que l'application devine où écrire
 * une valeur sur une image plate.
 *
 * positions/redactions viennent des deux mêmes fonctions de repérage que
 * createFilledDaoTemplatePdf (locateFieldPositions/locateBracketPlaceholders/
 * locateTableCellPositions) : seul ce qui se passe APRÈS le repérage change.
 * Un fond blanc sur chaque case recouvre le pointillé ou le texte entre
 * crochets déjà imprimé au même endroit sur la vraie page.
 *
 * Réservée aux pièces avec un jeu de champs FIXE (voir route.ts) : un
 * tableau à nombre de lignes variable (personnel, litiges des 5 dernières
 * années...) garde sa propre méthode existante (texte proprement recomposé,
 * autant de lignes que l'utilisateur en ajoute dans le dossier) — dupliquer
 * une case cliquable un nombre de fois inconnu à l'avance n'a pas de sens ici.
 */
export async function createFillableDaoTemplatePdf(
  source: Uint8Array,
  pageNumbers: number[],
  positions: FillPosition[],
  redactions: RedactionZone[],
  rawValues: Record<string, string>,
  documentTitle?: string | null,
) {
  const values = Object.fromEntries(
    Object.entries(rawValues).map(([key, value]) => [key, (value ?? "").replace(/\{\{[^{}]{1,80}\}\}/g, "").trim()]),
  );
  const sourcePdf = await PDFDocument.load(source);
  const validPages = [...new Set(pageNumbers.map((page) => Math.floor(page)).filter((page) => page >= 1 && page <= sourcePdf.getPageCount()))];
  if (!validPages.length) throw new Error("Aucune page de modèle exploitable.");
  const result = await PDFDocument.create();
  if (documentTitle?.trim()) result.setTitle(compact(documentTitle.trim(), 200));
  // subset:false — voir le commentaire dans pdf-font.ts : une case encore
  // vide doit pouvoir recevoir N'IMPORTE quel caractère tapé plus tard par
  // l'utilisateur dans sa propre application, pas seulement les caractères
  // déjà utilisés ailleurs dans ce document précis.
  const { font } = await embedUnicodeFonts(result, { subset: false });
  const copiedPages = await result.copyPages(sourcePdf, validPages.map((page) => page - 1));
  copiedPages.forEach((page) => result.addPage(page));
  const pageIndexByNumber = new Map(validPages.map((pageNumber, index) => [pageNumber, index]));
  const form = result.getForm();

  // Même règle de priorité que createFilledDaoTemplatePdf : un crochet
  // repéré marque l'emplacement exact de la case (plus fiable qu'une
  // estimation par libellé) et l'emporte toujours sur une position estimée
  // pour le MÊME champ — sinon une case cliquable apparaissait deux fois.
  const fieldKeysHandledByRedaction = new Set(redactions.map((zone) => zone.field_key).filter((key): key is string => Boolean(key)));
  const dedupedPositions = positions.filter((position) => !fieldKeysHandledByRedaction.has(position.field_key));

  const usedFieldNames = new Map<string, number>();
  function uniqueFieldName(base: string): string {
    const safeBase = (base || "champ").replace(/[^a-zA-Z0-9_.-]/g, "_") || "champ";
    const count = usedFieldNames.get(safeBase) ?? 0;
    usedFieldNames.set(safeBase, count + 1);
    return count === 0 ? safeBase : `${safeBase}__${count}`;
  }

  let createdFieldCount = 0;
  function addTextField(pageNumber: number, fieldKey: string, rect: Rect, fontSize: number, value: string) {
    const pageIndex = pageIndexByNumber.get(pageNumber);
    if (pageIndex === undefined) return;
    const page = copiedPages[pageIndex];
    const { width: pageWidth } = page.getSize();
    const clampedWidth = Math.max(10, Math.min(rect.width, pageWidth - rect.x - 2));
    const textField = form.createTextField(uniqueFieldName(fieldKey));
    // ORDRE IMPORTANT : pdf-lib exige que addToPage() soit appelé (avec la
    // police) AVANT setFontSize()/setText() — sinon "No /DA (default
    // appearance) entry found for field", vérifié en testant les deux
    // ordres. addToPage() établit d'abord l'apparence par défaut de la case
    // (avec notre police embarquée), setFontSize/setText la complètent
    // ensuite.
    textField.addToPage(page, {
      x: rect.x,
      y: rect.y,
      width: clampedWidth,
      height: Math.max(rect.height, fontSize * 1.3),
      // Fond blanc : recouvre le pointillé/crochet déjà imprimé à cet
      // endroit précis sur la vraie page — même principe que le rectangle
      // blanc utilisé ailleurs avant d'écrire une valeur par-dessus.
      backgroundColor: rgb(1, 1, 1),
      borderWidth: 0,
      textColor: rgb(0, 0, 0),
      font,
    });
    textField.setFontSize(Math.max(6, Math.min(12, fontSize)));
    if (value) textField.setText(compact(value, 4000));
    createdFieldCount += 1;
  }

  for (const position of dedupedPositions) {
    const pageNumber = Math.floor(position.page);
    const pageIndex = pageIndexByNumber.get(pageNumber);
    if (pageIndex === undefined) continue;
    const { width, height } = sourcePdf.getPage(pageNumber - 1).getSize();
    const rect = positionRect(width, height, position);
    addTextField(pageNumber, position.field_key, rect, clampFontSize(position.font_size), values[position.field_key] ?? "");
  }
  for (const zone of redactions) {
    const pageNumber = Math.floor(zone.page);
    const pageIndex = pageIndexByNumber.get(pageNumber);
    if (pageIndex === undefined) continue;
    const { width, height } = sourcePdf.getPage(pageNumber - 1).getSize();
    const rect = redactionRect(width, height, zone);
    if (zone.field_key) {
      addTextField(pageNumber, zone.field_key, rect, clampFontSize(undefined), values[zone.field_key] ?? "");
    } else {
      // Une instruction entre crochets SANS champ associé ("[cachet et
      // signature de l'autorité]") n'a rien à faire remplir par le candidat :
      // on efface juste le crochet avec un rectangle blanc, sans case
      // cliquable inutile.
      copiedPages[pageIndex].drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: rgb(1, 1, 1) });
    }
  }

  if (createdFieldCount > 0) {
    try {
      form.updateFieldAppearances(font);
    } catch {
      // Repli silencieux : les valeurs restent enregistrées dans le PDF
      // (visibles dans l'application de l'utilisateur) même si la régénération
      // de l'aperçu échoue exceptionnellement ici.
    }
  }
  return Buffer.from(await result.save());
}

/**
 * Filet de sécurité général : quand l'IA n'a pas su repérer où écrire une
 * valeur sur la page DAO elle-même (aucune position calculée pour ce
 * formulaire), on ajoute une page récapitulative avec les vraies valeurs
 * plutôt que de rendre le modèle officiel entièrement vide.
 */
export async function appendFilledFieldsSummaryPage(pdf: Uint8Array, title: string, lines: string[]) {
  if (!lines.length) return Buffer.from(pdf);
  const doc = await PDFDocument.load(pdf);
  const { font, boldFont } = await embedUnicodeFonts(doc);
  let page = doc.addPage();
  const { width, height } = page.getSize();
  let y = height - 60;
  page.drawText(compact(title, 90), { x: 40, y, size: 13, font: boldFont, color: rgb(0, 0, 0) });
  y -= 24;
  page.drawText("Informations complétées pour ce formulaire :", { x: 40, y, size: 10, font, color: rgb(0.3, 0.3, 0.3) });
  y -= 20;
  for (const line of lines) {
    if (y < 50) { page = doc.addPage(); y = height - 60; }
    page.drawText(compact(line, 110), { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
    y -= 16;
  }
  return Buffer.from(await doc.save());
}

/** Ajoute au registre généré les pages originales des plans, sans les modifier. */
export async function appendDaoPagesToPdf(generatedPdf: Uint8Array, source: Uint8Array, pageNumbers: number[]) {
  const generated = await PDFDocument.load(generatedPdf);
  const dao = await PDFDocument.load(source);
  const validPages = [...new Set(pageNumbers.map((page) => Math.floor(page)).filter((page) => page >= 1 && page <= dao.getPageCount()))];
  if (!validPages.length) return Buffer.from(await generated.save());
  const pages = await generated.copyPages(dao, validPages.map((page) => page - 1));
  pages.forEach((page) => generated.addPage(page));
  return Buffer.from(await generated.save());
}

/**
 * Joint un fichier externe fourni par l'utilisateur (ici la CIN d'un
 * personnel, recto/verso) en pages SUPPLÉMENTAIRES à la fin d'un PDF déjà
 * généré — jamais mélangé avec ses propres pages. Si le fichier est déjà un
 * PDF (CIN scannée en PDF, éventuellement plusieurs pages pour recto/verso),
 * chacune de ses pages est copiée telle quelle. Si c'est une photo (jpg ou
 * png, cas le plus courant pour une CIN prise en photo), elle est centrée et
 * mise à l'échelle sur une nouvelle page A4, sans la déformer.
 */
export async function appendExternalFileAsPages(generatedPdf: Uint8Array, fileBytes: Uint8Array, mimeType: string) {
  const generated = await PDFDocument.load(generatedPdf);
  const normalizedMime = mimeType.toLowerCase();
  if (normalizedMime.includes("pdf")) {
    try {
      const external = await PDFDocument.load(fileBytes);
      const pages = await generated.copyPages(external, external.getPageIndices());
      pages.forEach((page) => generated.addPage(page));
    } catch {
      // Un PDF de CIN illisible ou corrompu ne doit jamais faire échouer tout
      // le contrat déjà généré : on le laisse simplement de côté.
    }
    return Buffer.from(await generated.save());
  }
  try {
    const image = normalizedMime.includes("png")
      ? await generated.embedPng(fileBytes)
      : await generated.embedJpg(fileBytes);
    // Format A4 portrait en points PDF (595 x 842), comme le reste des pages
    // générées par l'application.
    const pageWidth = 595;
    const pageHeight = 842;
    const page = generated.addPage([pageWidth, pageHeight]);
    const margin = 40;
    const maxWidth = pageWidth - margin * 2;
    const maxHeight = pageHeight - margin * 2;
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    page.drawImage(image, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  } catch {
    // Une image illisible (format non pris en charge, fichier corrompu) ne
    // doit pas non plus faire échouer le contrat déjà généré.
  }
  return Buffer.from(await generated.save());
}
