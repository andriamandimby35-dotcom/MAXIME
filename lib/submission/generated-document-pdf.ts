import { PDFDocument, PDFFont, PDFForm, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { embedUnicodeFonts } from "@/lib/submission/pdf-font";

// NOUVELLE approche de génération de pièces (Lettre de soumission, garanties,
// et autres documents à base de texte/tableaux), demandée par Maxime après
// plusieurs heures à essayer de repérer précisément chaque pointillé sur LA
// VRAIE page du DAO (voir dao-template-pdf.ts / locate-field-positions.ts) :
// cette approche reste nécessaire pour les pièces qu'on doit reproduire
// EXACTEMENT comme le DAO (garanties bancaires avec un formalisme imposé,
// documents où la mise en page compte), mais elle est intrinsèquement fragile
// (un blanc mal repéré = une valeur mal placée). Pour un document qui est
// avant tout du TEXTE (une lettre, une déclaration) ou un TABLEAU dont on
// connaît déjà les colonnes/lignes exactes (template_tables, déjà structuré
// par l'analyse du DAO), il est bien plus fiable d'écrire nous-mêmes des
// paragraphes propres avec les valeurs insérées dedans, plutôt que de
// chercher à deviner où un pointillé se trouve sur la page d'origine. On
// garde le contenu légal (les mêmes paragraphes numérotés 1., 2., 3...), on
// insère les valeurs directement dans le texte (en gras, pour qu'elles
// ressortent), et on ne montre plus jamais de pointillés une fois qu'une
// valeur est connue.
// field:true marque une valeur INSÉRÉE (montant, date, référence, nom du
// signataire...) plutôt qu'un simple mot en gras (ex. un titre de section
// comme "Informations complémentaires :") : SEULES ces valeurs deviennent de
// vraies cases cliquables plus bas (voir addInlineValueField) — un mot en
// gras sans field ne devient jamais une case, juste du texte stylé comme
// avant.
export type TextRun = { text: string; bold?: boolean; field?: boolean };
export type ParagraphBlock = { kind: "paragraph"; runs: TextRun[] };
export type HeadingBlock = { kind: "heading"; text: string };
export type SpacerBlock = { kind: "spacer"; height?: number };
export type TableBlock = { kind: "table"; title?: string; columns: string[]; rows: string[][] };
export type DocumentBlock = ParagraphBlock | HeadingBlock | SpacerBlock | TableBlock;

const PAGE_WIDTH = 595.28; // A4 en points (72 dpi)
const PAGE_HEIGHT = 841.89;
const MARGIN = 56; // ~2cm
const BODY_FONT_SIZE = 10.5;
const LINE_HEIGHT = 15;
const HEADING_FONT_SIZE = 14;
const TABLE_FONT_SIZE = 9.5;
const TABLE_ROW_PADDING = 6;

function splitIntoWords(text: string): string[] {
  return text.split(/(\s+)/).filter((part) => part.length > 0);
}

// Découpe UNE ligne logique (une suite de runs, certains en gras) en lignes
// visuelles qui tiennent dans maxWidth, en conservant quel morceau de chaque
// ligne visuelle est en gras ou non (nécessaire pour dessiner ensuite chaque
// morceau avec la bonne police - pdf-lib ne sait pas mélanger gras/normal
// dans un seul drawText).
function wrapRuns(runs: TextRun[], maxWidth: number, font: PDFFont, boldFont: PDFFont, fontSize: number): TextRun[][] {
  const lines: TextRun[][] = [[]];
  let currentWidth = 0;
  for (const run of runs) {
    const words = splitIntoWords(run.text);
    const activeFont = run.bold ? boldFont : font;
    for (const word of words) {
      const wordWidth = activeFont.widthOfTextAtSize(word, fontSize);
      if (currentWidth + wordWidth > maxWidth && currentWidth > 0 && word.trim().length > 0) {
        lines.push([]);
        currentWidth = 0;
        // Un mot qui commence une nouvelle ligne ne doit jamais garder un
        // espace de début (resterait un espace fantôme en début de ligne).
        if (!word.trim()) continue;
      }
      const lastLine = lines[lines.length - 1];
      const lastRun = lastLine[lastLine.length - 1];
      // field doit aussi correspondre, pas seulement bold : sinon un mot
      // d'une valeur cliquable (field:true) pouvait fusionner avec un mot en
      // gras voisin qui n'en est pas une (ex. un titre de section), et toute
      // la fusion héritait alors à tort du statut du premier des deux.
      if (lastRun && Boolean(lastRun.bold) === Boolean(run.bold) && Boolean(lastRun.field) === Boolean(run.field)) {
        lastRun.text += word;
      } else {
        lastLine.push({ text: word, bold: run.bold, field: run.field });
      }
      currentWidth += wordWidth;
    }
  }
  // Une ligne purement faite d'espace(s) en fin de découpe (avant un retour
  // à la ligne naturel) est sans intérêt et gonflerait la hauteur pour rien.
  return lines.filter((line) => line.some((run) => run.text.trim().length > 0));
}

type Cursor = { page: PDFPage; y: number };

// Largeur réelle des pages du document en cours de génération : celle d'un A4,
// élargie seulement si un tableau a besoin de plus de place pour que ses
// colonnes montrent leur texte en entier (voir computeTableLayout). Le texte
// courant (paragraphes) continue, lui, à se couper à la largeur A4.
let activePageWidth = PAGE_WIDTH;

function ensureSpace(cursor: Cursor, doc: PDFDocument, needed: number): Cursor {
  if (cursor.y - needed >= MARGIN) return cursor;
  const page = doc.addPage([activePageWidth, PAGE_HEIGHT]);
  return { page, y: PAGE_HEIGHT - MARGIN };
}

// Compteur de cases partagé sur tout le document (form.createTextField exige
// un nom UNIQUE par case dans tout le PDF) — un simple objet plutôt qu'une
// variable de module, pour repartir de zéro à chaque appel de
// renderGeneratedDocumentPdf (deux appels concurrents ne doivent jamais se
// marcher dessus).
type FieldCounter = { current: number };

// Pose une VRAIE case à remplir cliquable directement là où le texte aurait
// été dessiné (même police, même position) — plutôt que du texte peint en
// dur — pour qu'une valeur insérée automatiquement (montant, date,
// référence...) reste modifiable dans notre lecteur PDF intégré, exactement
// comme sur une vraie page de DAO (voir dao-template-pdf.ts). Une ligne trop
// longue qui a été coupée en plusieurs morceaux par wrapRuns devient
// plusieurs petites cases à la suite plutôt qu'une seule : limitation connue
// (rare en pratique — une valeur assez courte pour tenir sur une ligne reste
// une seule case), acceptée pour ne pas complexifier tout le découpage de
// lignes existant.
function addInlineValueField(form: PDFForm, page: PDFPage, font: PDFFont, counter: FieldCounter, text: string, x: number, y: number, fontSize: number, maxWidth: number) {
  counter.current += 1;
  // BUG corrigé (signalé par Maxime : une valeur retapée dans notre lecteur
  // PDF intégré, plus longue que celle écrite ici par l'IA au départ,
  // restait "à moitié cachée" — seul le DÉBUT du texte visible, le reste
  // défilé hors du cadre). Cause : la largeur de cette case suivait
  // EXACTEMENT la largeur du texte d'origine, sans aucune marge pour un
  // texte différent (souvent plus long) tapé ensuite par la personne — un
  // cadre remplissable doit toujours pouvoir accueillir autre chose que ce
  // qui l'a rempli la première fois. On réserve donc une largeur
  // confortable (le texte d'origine + de la place en plus), sans jamais
  // dépasser maxWidth (calculé par drawWrappedLine : l'espace réellement
  // libre avant la marge de page ou le morceau de texte suivant sur la même
  // ligne, pour ne jamais chevaucher quoi que ce soit).
  const comfortableWidth = font.widthOfTextAtSize(text, fontSize) + Math.max(40, fontSize * 6);
  const width = Math.max(8, Math.min(comfortableWidth, Math.max(8, maxWidth)));
  const height = fontSize * 1.35;
  const field = form.createTextField(`valeur_generee_${counter.current}`);
  // ORDRE IMPORTANT (vérifié en testant les deux ordres, voir
  // dao-template-pdf.ts) : addToPage() AVANT setFontSize()/setText().
  field.addToPage(page, {
    x,
    y: y - height * 0.24,
    width,
    height,
    borderWidth: 0,
    textColor: rgb(0, 0, 0),
    font,
  });
  field.setFontSize(fontSize);
  field.setText(text);
}

function drawWrappedLine(page: PDFPage, line: TextRun[], x: number, y: number, font: PDFFont, boldFont: PDFFont, fontSize: number, form: PDFForm, counter: FieldCounter) {
  let cursorX = x;
  const rightMargin = PAGE_WIDTH - MARGIN;
  for (let index = 0; index < line.length; index += 1) {
    const run = line[index];
    const activeFont = run.bold ? boldFont : font;
    const textWidth = activeFont.widthOfTextAtSize(run.text, fontSize);
    if (run.field && run.text.trim()) {
      // Espace réellement libre après cette case, avant que le morceau de
      // texte SUIVANT sur la même ligne (s'il y en a un) ne commence — ou
      // jusqu'à la marge droite de la page si cette case termine la ligne.
      // Sans ça, élargir la case (voir addInlineValueField) risquerait de la
      // faire chevaucher le texte qui suit.
      let widthAfter = 0;
      for (let next = index + 1; next < line.length; next += 1) {
        const laterFont = line[next].bold ? boldFont : font;
        widthAfter += laterFont.widthOfTextAtSize(line[next].text, fontSize);
      }
      const maxWidth = rightMargin - cursorX - widthAfter;
      addInlineValueField(form, page, activeFont, counter, run.text, cursorX, y, fontSize, maxWidth);
    } else {
      page.drawText(run.text, { x: cursorX, y, size: fontSize, font: activeFont, color: rgb(0, 0, 0) });
    }
    cursorX += textWidth;
  }
}

function drawParagraph(doc: PDFDocument, cursor: Cursor, block: ParagraphBlock, font: PDFFont, boldFont: PDFFont, form: PDFForm, counter: FieldCounter): Cursor {
  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  const lines = wrapRuns(block.runs, maxWidth, font, boldFont, BODY_FONT_SIZE);
  let current = cursor;
  for (const line of lines) {
    current = ensureSpace(current, doc, LINE_HEIGHT);
    drawWrappedLine(current.page, line, MARGIN, current.y - BODY_FONT_SIZE, font, boldFont, BODY_FONT_SIZE, form, counter);
    current = { page: current.page, y: current.y - LINE_HEIGHT };
  }
  return current;
}

function drawHeading(doc: PDFDocument, cursor: Cursor, block: HeadingBlock, boldFont: PDFFont): Cursor {
  const current = ensureSpace(cursor, doc, HEADING_FONT_SIZE + 10);
  const textWidth = boldFont.widthOfTextAtSize(block.text, HEADING_FONT_SIZE);
  const x = (PAGE_WIDTH - textWidth) / 2;
  current.page.drawText(block.text, { x, y: current.y - HEADING_FONT_SIZE, size: HEADING_FONT_SIZE, font: boldFont, color: rgb(0, 0, 0) });
  return { page: current.page, y: current.y - HEADING_FONT_SIZE - 20 };
}

// Découpe le texte d'UNE cellule de tableau en lignes qui tiennent dans
// columnWidth, en tenant compte des marges internes de la cellule.
function wrapPlainText(text: string, maxWidth: number, font: PDFFont, fontSize: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

// Les colonnes s'ADAPTENT au contenu, la taille du texte ne change JAMAIS : une
// case de tableau s'affiche à l'écran en 11 pt (Times, réglage par défaut de
// l'application). Chaque colonne reçoit donc la largeur de son texte le plus
// long mesuré avec cette police et cette taille, plus la marge interne de la
// case ; si la somme dépasse la zone utile d'un A4, c'est la PAGE qui
// s'élargit. Règle générale, identique à celle de printable-pdf.ts.
const TABLE_SCREEN_FONT_SIZE = 11;
const TABLE_CELL_SIDE_PADDING = 30;
function computeTableLayout(block: TableBlock, timesFont: PDFFont, headerFont: PDFFont): { widths: number[]; tableWidth: number } {
  const baseWidth = PAGE_WIDTH - MARGIN * 2;
  const columnCount = block.columns.length || 1;
  const measure = (fontToUse: PDFFont, text: string, size: number) => {
    try { return fontToUse.widthOfTextAtSize(text, size); } catch { return text.length * size * 0.55; }
  };
  const needed = Array.from({ length: columnCount }, (_, columnIndex) => {
    const headerWidth = measure(headerFont, String(block.columns[columnIndex] ?? ""), TABLE_FONT_SIZE);
    const dataWidth = Math.max(0, ...block.rows.map((row) => measure(timesFont, String(row[columnIndex] ?? ""), TABLE_SCREEN_FONT_SIZE)));
    return Math.min(900, Math.max(headerWidth, dataWidth) + TABLE_CELL_SIDE_PADDING);
  });
  const neededSum = needed.reduce((sum, value) => sum + value, 0) || 1;
  if (neededSum <= baseWidth) return { widths: needed.map((value) => (value / neededSum) * baseWidth), tableWidth: baseWidth };
  return { widths: needed, tableWidth: neededSum };
}

function drawTable(doc: PDFDocument, cursor: Cursor, block: TableBlock, font: PDFFont, boldFont: PDFFont, form: PDFForm, counter: FieldCounter, layout: { widths: number[]; tableWidth: number }): Cursor {
  let current = cursor;
  if (block.title) {
    current = ensureSpace(current, doc, LINE_HEIGHT + 4);
    current.page.drawText(block.title, { x: MARGIN, y: current.y - BODY_FONT_SIZE, size: BODY_FONT_SIZE, font: boldFont, color: rgb(0, 0, 0) });
    current = { page: current.page, y: current.y - LINE_HEIGHT - 4 };
  }
  const tableWidth = layout.tableWidth;
  const columnCount = block.columns.length || 1;
  const cellPaddingX = 5;
  const allRows = [block.columns, ...block.rows];
  const columnWidths = layout.widths.length === columnCount ? layout.widths : Array.from({ length: columnCount }, () => tableWidth / columnCount);
  const columnOffsets = columnWidths.map((_, index) => columnWidths.slice(0, index).reduce((sum, value) => sum + value, 0));
  for (const [rowIndex, row] of allRows.entries()) {
    const isHeader = rowIndex === 0;
    const cellFont = isHeader ? boldFont : font;
    const wrappedCells = row.map((cell, columnIndex) => wrapPlainText(cell ?? "", (columnWidths[columnIndex] ?? columnWidths[0]) - cellPaddingX * 2, cellFont, TABLE_FONT_SIZE));
    const rowLineCount = Math.max(1, ...wrappedCells.map((lines) => lines.length));
    const rowHeight = rowLineCount * (TABLE_FONT_SIZE + 3) + TABLE_ROW_PADDING;
    current = ensureSpace(current, doc, rowHeight);
    const rowTopY = current.y;
    for (const [columnIndex, lines] of wrappedCells.entries()) {
      const columnWidth = columnWidths[columnIndex] ?? columnWidths[0];
      const cellX = MARGIN + (columnOffsets[columnIndex] ?? 0) + cellPaddingX;
      const rawValue = (row[columnIndex] ?? "").toString();
      // Une case de la ligne d'en-tête reste du texte fixe (jamais une valeur
      // à modifier). Une case de donnée devient une VRAIE case cliquable
      // couvrant toute la cellule, en mode multi-lignes — plutôt qu'un champ
      // par ligne déjà découpée comme pour un paragraphe : une cellule de
      // tableau a déjà un rectangle bien défini (sa ligne du tableau), donc
      // pas besoin de fragmenter une valeur un peu longue en plusieurs cases.
      if (!isHeader && rawValue.trim()) {
        counter.current += 1;
        const field = form.createTextField(`case_tableau_${counter.current}`);
        field.addToPage(current.page, {
          x: cellX - cellPaddingX + 2,
          y: rowTopY - rowHeight + 2,
          width: columnWidth - 4,
          height: rowHeight - 4,
          borderWidth: 0,
          textColor: rgb(0, 0, 0),
          font: cellFont,
        });
        // RÈGLE GÉNÉRALE demandée par Maxime (après le bug déjà corrigé une
        // fois ici avec un simple "if (rowLineCount > 1)", jugé encore trop
        // lié à la longueur du texte d'origine) : AUCUNE case cliquable de
        // toute l'application ne doit choisir son mode (une ligne / plusieurs
        // lignes) en fonction du texte — ni le texte généré par l'IA au
        // départ, ni celui retapé ensuite par Maxime. On ne calcule donc plus
        // jamais rowLineCount pour décider d'un enableMultiline() : cette
        // case, comme absolument toutes les autres cases générées par
        // l'appli (voir printable-pdf.ts/drawRow, qui suit déjà cette règle),
        // reste TOUJOURS en mode "une seule ligne" chez pdf.js — jamais de
        // relation case/texte, jamais de <textarea> défilant avec son
        // ascenseur par-dessus le texte. rowLineCount continue seulement à
        // servir plus haut pour la HAUTEUR VISUELLE de la rangée (afficher
        // proprement le texte d'origine sur plusieurs lignes dessinées en dur
        // quand il y en a besoin) : ça ne concerne que le dessin, jamais la
        // case remplissable elle-même. Si une case est trop petite pour ce
        // que Maxime veut y taper, c'est à lui de l'agrandir manuellement
        // (dans l'éditeur de mise en page) — l'appli ne doit plus jamais
        // essayer de deviner à sa place.
        field.setFontSize(TABLE_FONT_SIZE);
        field.setText(rawValue);
      } else {
        let lineY = rowTopY - TABLE_ROW_PADDING / 2 - TABLE_FONT_SIZE;
        for (const line of lines) {
          current.page.drawText(line, { x: cellX, y: lineY, size: TABLE_FONT_SIZE, font: cellFont, color: rgb(0, 0, 0) });
          lineY -= TABLE_FONT_SIZE + 3;
        }
      }
    }
    // Ligne de séparation sous chaque rangée (fine, grise) - repère visuel du
    // tableau sans avoir besoin de dessiner chaque cellule comme un rectangle.
    current.page.drawLine({
      start: { x: MARGIN, y: rowTopY - rowHeight },
      end: { x: MARGIN + tableWidth, y: rowTopY - rowHeight },
      thickness: isHeader ? 1 : 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    current = { page: current.page, y: rowTopY - rowHeight };
  }
  return { page: current.page, y: current.y - 10 };
}

/**
 * Construit un PDF propre à partir d'une liste de blocs (paragraphes,
 * titres, tableaux) plutôt que de reconstruire la page d'un DAO existant.
 * Utilisé quand on préfère réécrire le contenu (voir le commentaire en tête
 * de fichier) plutôt que de repérer des pointillés sur une page scannée.
 */
export async function renderGeneratedDocumentPdf(blocks: DocumentBlock[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  // subset:false — même raison que dans createFillableDaoTemplatePdf (voir
  // dao-template-pdf.ts) : ce document contient maintenant de VRAIES cases à
  // remplir, où l'utilisateur peut retaper une valeur avec des caractères qui
  // n'apparaissent nulle part ailleurs dans ce PDF précis.
  const { font, boldFont } = await embedUnicodeFonts(doc, { subset: false });
  const form = doc.getForm();
  const fieldCounter: FieldCounter = { current: 0 };
  const timesFont = await doc.embedFont(StandardFonts.TimesRoman);
  const tableLayouts = new Map<TableBlock, { widths: number[]; tableWidth: number }>();
  let documentPageWidth = PAGE_WIDTH;
  for (const block of blocks) {
    if (block.kind !== "table") continue;
    const layout = computeTableLayout(block, timesFont, boldFont);
    tableLayouts.set(block, layout);
    documentPageWidth = Math.max(documentPageWidth, Math.ceil(layout.tableWidth + MARGIN * 2));
  }
  activePageWidth = documentPageWidth;
  let cursor: Cursor = { page: doc.addPage([activePageWidth, PAGE_HEIGHT]), y: PAGE_HEIGHT - MARGIN };
  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        cursor = drawHeading(doc, cursor, block, boldFont);
        break;
      case "paragraph":
        cursor = drawParagraph(doc, cursor, block, font, boldFont, form, fieldCounter);
        cursor = { page: cursor.page, y: cursor.y - 8 }; // espace entre paragraphes
        break;
      case "table":
        cursor = drawTable(doc, cursor, block, font, boldFont, form, fieldCounter, tableLayouts.get(block) ?? computeTableLayout(block, timesFont, boldFont));
        break;
      case "spacer":
        cursor = ensureSpace(cursor, doc, block.height ?? LINE_HEIGHT);
        cursor = { page: cursor.page, y: cursor.y - (block.height ?? LINE_HEIGHT) };
        break;
    }
  }
  if (fieldCounter.current > 0) {
    try {
      form.updateFieldAppearances(font);
    } catch {
      // Repli silencieux : les valeurs restent enregistrées dans les cases
      // (visibles dans l'application de l'utilisateur) même si la
      // régénération de l'aperçu échoue exceptionnellement ici — même
      // principe que createFillableDaoTemplatePdf.
    }
  }
  return Buffer.from(await doc.save());
}
