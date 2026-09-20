import { PDFDocument, rgb } from "pdf-lib";
import { embedUnicodeFonts } from "./pdf-font";

type FillPosition = { page: number; field_key: string; x_percent: number; y_percent: number; width_percent: number };
type RedactionZone = { page: number; field_key: string | null; x_percent: number; y_percent: number; width_percent: number; height_percent: number };

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
export async function createFilledDaoTemplatePdf(source: Uint8Array, pageNumbers: number[], positions: FillPosition[], values: Record<string, string>, redactions: RedactionZone[] = [], documentTitle?: string | null) {
  const sourcePdf = await PDFDocument.load(source);
  const validPages = [...new Set(pageNumbers.map((page) => Math.floor(page)).filter((page) => page >= 1 && page <= sourcePdf.getPageCount()))];
  if (!validPages.length) throw new Error("Aucune page de modèle exploitable.");
  const result = await PDFDocument.create();
  if (documentTitle?.trim()) result.setTitle(compact(documentTitle.trim(), 200));
  const pages = await result.copyPages(sourcePdf, validPages.map((page) => page - 1));
  pages.forEach((page) => result.addPage(page));
  const { font } = await embedUnicodeFonts(result);
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
      page.drawText(compact(value, maxChars), { x, y: y + boxHeight * 0.18, size: fontSize, font, color: rgb(0, 0, 0) });
    }
  }
  for (const position of positions) {
    const outputIndex = validPages.indexOf(Math.floor(position.page));
    if (outputIndex < 0) continue;
    const value = values[position.field_key]?.trim();
    const page = result.getPage(outputIndex);
    const { width, height } = page.getSize();
    const fontSize = 8;
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
