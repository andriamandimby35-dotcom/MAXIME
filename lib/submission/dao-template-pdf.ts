import { PDFDocument, PDFFont, rgb } from "pdf-lib";
import { embedUnicodeFonts } from "./pdf-font";
import "@/lib/submission/pdfjs-worker-setup";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { isBlankMarkerRun } from "./blank-marker";

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

function looksBoldFont(fontFamily: string | undefined) {
  return Boolean(fontFamily && /bold/i.test(fontFamily));
}

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

// Une taille de police en dehors de cette fourchette serait soit illisible
// (trop petite), soit ne rentrerait plus dans la case d'origine du DAO (trop
// grande) — les mêmes bornes que la boucle "redactions" plus bas, qui a fait
// ses preuves pour ce genre de valeur courte insérée sur une page existante.
function clampFontSize(size: number | undefined) {
  return Math.max(6, Math.min(11, size ?? 8));
}

// Même calcul que la boucle "positions" plus bas (garde le même rectangle
// blanchi), en zone à ne pas redessiner plutôt qu'en rectangle dessiné.
function positionRect(width: number, height: number, position: FillPosition): Rect {
  const fontSize = clampFontSize(position.font_size);
  const coverHeight = fontSize * 1.5;
  const available = Math.max(10, width * Math.max(1, Math.min(90, position.width_percent)) / 100);
  const x = width * Math.max(0, Math.min(100, position.x_percent)) / 100;
  const y = height - (height * Math.max(0, Math.min(100, position.y_percent)) / 100) - fontSize;
  return { x: x - 1, y: y - coverHeight * 0.25, width: available + 2, height: coverHeight };
}

// Reconstruit une page ENTIÈREMENT en texte (au lieu de copier l'image de la
// page du DAO et d'écrire par-dessus) : on redessine nous-mêmes chaque
// portion de texte lue sur la vraie page, à sa position et sa taille
// d'origine (gras conservé), sauf les pointillés/traits de blanc et les
// zones qui vont recevoir une valeur remplie. Comme on ne dessine plus RIEN
// à l'endroit d'un blanc, notre valeur ne peut plus jamais chevaucher un
// pointillé ou un texte déjà imprimé — le risque de superposition disparaît
// par construction plutôt que d'être corrigé au cas par cas. Les dessins
// (plans, logos, modèles de panneaux...) ne passent jamais par ici : voir
// l'appelant, qui garde la copie exacte de la page pour ce genre de pièce.
async function rebuildPageAsText(
  pdfJsDoc: Awaited<ReturnType<typeof getDocument>["promise"]>,
  pageNumber: number,
  target: PDFDocument,
  font: PDFFont,
  boldFont: PDFFont,
  suppressZones: Rect[],
) {
  const page = await pdfJsDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const styles = (content.styles ?? {}) as Record<string, { fontFamily?: string }>;
  type RawItem = { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string };
  const items = (content.items as RawItem[]).filter((item) => (item.str ?? "").length > 0);
  const newPage = target.addPage([viewport.width, viewport.height]);
  for (const item of items) {
    const text = item.str ?? "";
    if (isBlankMarkerRun(text)) continue;
    const transform = item.transform ?? [10, 0, 0, 10, 0, 0];
    const x = transform[4] ?? 0;
    const y = transform[5] ?? 0;
    let fontSize = Math.max(4, Math.hypot(transform[2] ?? 0, transform[3] ?? 10));
    const itemBox: Rect = { x, y, width: item.width || fontSize * text.length * 0.55, height: item.height || fontSize };
    if (suppressZones.some((zone) => rectsOverlap(zone, itemBox))) continue;
    const bold = looksBoldFont(item.fontName ? styles[item.fontName]?.fontFamily : undefined);
    const chosenFont = bold ? boldFont : font;
    const cleanedText = sanitizeForPdf(text);
    // Notre police de substitution (DejaVu Sans, seule à couvrir tout
    // l'Unicode nécessaire — voir pdf-font.ts) n'a pas forcément la même
    // largeur de caractère que la police d'origine du DAO. Comme chaque item
    // est redessiné à sa position d'origine SANS recalculer celle des items
    // suivants, un texte qui s'avère plus large avec notre police peut
    // déborder sur le début de l'item suivant, souvent collé juste derrière
    // (ex. la fin d'une phrase juste avant une instruction entre crochets) —
    // constaté sur un vrai DAO ("...la limite de [insérer..." devenu
    // illisible, les deux bouts de texte fusionnés). pdf.js connaît la
    // largeur RÉELLE de cet item sur la page d'origine (item.width) : on
    // réduit la taille jusqu'à rentrer dedans plutôt que de laisser déborder
    // sur le texte voisin — jamais l'inverse (agrandir), pour ne jamais
    // perdre en lisibilité un texte qui tenait déjà très bien.
    if (item.width && item.width > 0 && cleanedText.trim()) {
      const measuredWidth = chosenFont.widthOfTextAtSize(cleanedText, fontSize);
      if (measuredWidth > item.width) fontSize = Math.max(4, fontSize * (item.width / measuredWidth));
    }
    try {
      newPage.drawText(cleanedText, { x, y, size: fontSize, font: chosenFont, color: rgb(0, 0, 0) });
    } catch {
      // Un caractère non couvert même par notre police Unicode ne doit
      // jamais faire échouer toute la page : ce mot précis reste simplement
      // absent plutôt que de perdre tout le reste de la reconstruction.
    }
  }
  return newPage;
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
 * Keeps the DAO pages untouched and only writes values in the detected
 * candidate fields. documentTitle (facultatif) est le VRAI titre confirmé
 * (majuscules + gras) retrouvé sur la page DAO elle-même par
 * extractRelevantPageRange/locateTitleInFullDocument : il est écrit dans les
 * PROPRIÉTÉS du fichier PDF (titre du document), jamais dessiné sur la page
 * — la page réelle du DAO reste ainsi copiée à l'identique, sans rien y
 * ajouter, tout en donnant au PDF final un titre visible (onglet du
 * navigateur, propriétés du fichier) au lieu de rester sans titre.
 */
export async function createFilledDaoTemplatePdf(source: Uint8Array, pageNumbers: number[], positions: FillPosition[], values: Record<string, string>, redactions: RedactionZone[] = [], documentTitle?: string | null, options: { rebuildAsText?: boolean } = {}) {
  const sourcePdf = await PDFDocument.load(source);
  const validPages = [...new Set(pageNumbers.map((page) => Math.floor(page)).filter((page) => page >= 1 && page <= sourcePdf.getPageCount()))];
  if (!validPages.length) throw new Error("Aucune page de modèle exploitable.");
  // positions (recherche du libellé sur la page, une estimation "à côté ou en
  // dessous du texte") et redactions (un "[...]" repéré et effacé) sont
  // calculés INDÉPENDAMMENT, à partir des mêmes champs — un même champ peut
  // donc très bien être retrouvé par les deux méthodes à la fois. Sans ce
  // filtre, sa valeur était alors écrite DEUX FOIS sur la page, à deux
  // endroits différents (l'un des deux forcément un peu à côté de la vraie
  // case) — la cause la plus fréquente de chevauchement de texte constatée,
  // bien avant même la question de reconstruire la page ou non. Le crochet
  // repéré marque toujours l'emplacement exact de la case sur le modèle du
  // DAO (plus fiable qu'une estimation par libellé) : c'est donc toujours
  // lui qui l'emporte quand les deux se disputent le même champ.
  const fieldKeysHandledByRedaction = new Set(redactions.map((zone) => zone.field_key).filter((key): key is string => Boolean(key)));
  const dedupedPositions = positions.filter((position) => !fieldKeysHandledByRedaction.has(position.field_key));
  const result = await PDFDocument.create();
  if (documentTitle?.trim()) result.setTitle(compact(documentTitle.trim(), 200));
  const { font, boldFont } = await embedUnicodeFonts(result);
  // Reconstruire la page en texte n'a de sens QUE s'il y a vraiment quelque
  // chose à écrire dessus (sinon la copie exacte reste strictement
  // meilleure : fidélité parfaite, aucun risque). Un plan technique ou un
  // modèle de panneau/logo n'a de toute façon jamais de position à remplir
  // (voir l'appelant) : ce garde-fou suffit donc à les exclure aussi, sans
  // dépendre d'un indicateur séparé passé depuis la route.
  const shouldRebuild = Boolean(options.rebuildAsText) && (dedupedPositions.length > 0 || redactions.length > 0);
  let pdfJsDoc: Awaited<ReturnType<typeof getDocument>["promise"]> | null = null;
  if (shouldRebuild) {
    try {
      pdfJsDoc = await getDocument({ data: source.slice(), useSystemFonts: true }).promise;
    } catch {
      pdfJsDoc = null; // Repli automatique sur la copie exacte ci-dessous.
    }
  }
  if (pdfJsDoc) {
    const readyDoc = pdfJsDoc;
    for (const pageNumber of validPages) {
      const sourcePageSize = sourcePdf.getPage(pageNumber - 1).getSize();
      const pageRedactions = redactions.filter((zone) => Math.floor(zone.page) === pageNumber)
        .map((zone) => redactionRect(sourcePageSize.width, sourcePageSize.height, zone));
      const pagePositions = dedupedPositions.filter((position) => Math.floor(position.page) === pageNumber)
        .map((position) => positionRect(sourcePageSize.width, sourcePageSize.height, position));
      try {
        await rebuildPageAsText(readyDoc, pageNumber, result, font, boldFont, [...pageRedactions, ...pagePositions]);
      } catch {
        // Page illisible pour pdf.js : on ne perd jamais cette page, on
        // revient à la copie exacte pour elle uniquement.
        const [copiedPage] = await result.copyPages(sourcePdf, [pageNumber - 1]);
        result.addPage(copiedPage);
      }
    }
  } else {
    const pages = await result.copyPages(sourcePdf, validPages.map((page) => page - 1));
    pages.forEach((page) => result.addPage(page));
  }
  // Une instruction entre crochets du DAO ("[insérer nom de la banque]") est
  // d'abord effacée par un rectangle blanc, puis remplacée par la vraie
  // valeur si un champ correspond — sinon elle reste simplement blanche,
  // comme le DAO lui-même demande de le faire avant le dépôt final.
  for (const zone of redactions) {
    const outputIndex = validPages.indexOf(Math.floor(zone.page));
    if (outputIndex < 0) continue;
    const page = result.getPage(outputIndex);
    const { width, height } = page.getSize();
    const x = width * Math.max(0, Math.min(100, zone.x_percent)) / 100;
    const boxHeight = height * Math.max(0, Math.min(100, zone.height_percent)) / 100;
    const y = height - (height * Math.max(0, Math.min(100, zone.y_percent)) / 100) - boxHeight;
    const boxWidth = width * Math.max(1, Math.min(100, zone.width_percent)) / 100;
    page.drawRectangle({ x: x - 1, y: y - 1, width: boxWidth + 2, height: boxHeight + 2, color: rgb(1, 1, 1) });
    const value = zone.field_key ? values[zone.field_key]?.trim() : "";
    if (value) {
      const fontSize = Math.max(6, Math.min(9, boxHeight * 0.72));
      const maxChars = Math.max(4, Math.floor(boxWidth / (fontSize * 0.55)));
      // La valeur doit apparaître là où commençait le texte entre crochets
      // d'origine, donc en haut de la zone effacée — pas au milieu de sa
      // hauteur totale, qui peut désormais être grande pour une instruction
      // sur plusieurs lignes (sinon la valeur atterrit sur la dernière
      // ligne de la zone, au même endroit qu'un champ voisin sur cette
      // ligne). Un simple décalage fixe sous le haut de la boîte, basé sur
      // la taille de police, place le texte correctement quelle que soit
      // la hauteur de la boîte.
      const textY = y + boxHeight - fontSize * 1.05;
      page.drawText(compact(value, maxChars), { x, y: textY, size: fontSize, font, color: rgb(0, 0, 0) });
    }
  }
  for (const position of dedupedPositions) {
    const outputIndex = validPages.indexOf(Math.floor(position.page));
    if (outputIndex < 0) continue;
    const value = values[position.field_key]?.trim();
    const page = result.getPage(outputIndex);
    const { width, height } = page.getSize();
    const fontSize = clampFontSize(position.font_size);
    const available = Math.max(10, width * Math.max(1, Math.min(90, position.width_percent)) / 100);
    const x = width * Math.max(0, Math.min(100, position.x_percent)) / 100;
    const y = height - (height * Math.max(0, Math.min(100, position.y_percent)) / 100) - fontSize;
    // Le DAO imprime des points de suite, tirets ou soulignés à cet
    // emplacement ("Nom : .........", "Date : ______") pour indiquer où
    // écrire à la main. Dès qu'on connaît la vraie valeur, on efface d'abord
    // ces caractères avec un rectangle blanc avant d'écrire par-dessus,
    // exactement comme pour les zones de redaction ci-dessus, pour ne
    // jamais superposer la valeur remplie aux pointillés d'origine — cette
    // règle couvre aussi les cellules de tableau, qui utilisent les mêmes
    // positions. Sans valeur connue, on laisse les pointillés intacts pour
    // que la personne puisse encore les compléter à la main.
    if (value) {
      const coverHeight = fontSize * 1.5;
      page.drawRectangle({ x: x - 1, y: y - coverHeight * 0.25, width: available + 2, height: coverHeight, color: rgb(1, 1, 1) });
      const maxChars = Math.max(4, Math.floor(available / 4.2));
      page.drawText(compact(value, maxChars), { x, y, size: fontSize, font, color: rgb(0, 0, 0) });
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
