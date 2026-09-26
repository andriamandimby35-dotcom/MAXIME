import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
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
export type TextRun = { text: string; bold?: boolean };
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
      if (lastRun && Boolean(lastRun.bold) === Boolean(run.bold)) {
        lastRun.text += word;
      } else {
        lastLine.push({ text: word, bold: run.bold });
      }
      currentWidth += wordWidth;
    }
  }
  // Une ligne purement faite d'espace(s) en fin de découpe (avant un retour
  // à la ligne naturel) est sans intérêt et gonflerait la hauteur pour rien.
  return lines.filter((line) => line.some((run) => run.text.trim().length > 0));
}

type Cursor = { page: PDFPage; y: number };

function ensureSpace(cursor: Cursor, doc: PDFDocument, needed: number): Cursor {
  if (cursor.y - needed >= MARGIN) return cursor;
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  return { page, y: PAGE_HEIGHT - MARGIN };
}

function drawWrappedLine(page: PDFPage, line: TextRun[], x: number, y: number, font: PDFFont, boldFont: PDFFont, fontSize: number) {
  let cursorX = x;
  for (const run of line) {
    const activeFont = run.bold ? boldFont : font;
    page.drawText(run.text, { x: cursorX, y, size: fontSize, font: activeFont, color: rgb(0, 0, 0) });
    cursorX += activeFont.widthOfTextAtSize(run.text, fontSize);
  }
}

function drawParagraph(doc: PDFDocument, cursor: Cursor, block: ParagraphBlock, font: PDFFont, boldFont: PDFFont): Cursor {
  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  const lines = wrapRuns(block.runs, maxWidth, font, boldFont, BODY_FONT_SIZE);
  let current = cursor;
  for (const line of lines) {
    current = ensureSpace(current, doc, LINE_HEIGHT);
    drawWrappedLine(current.page, line, MARGIN, current.y - BODY_FONT_SIZE, font, boldFont, BODY_FONT_SIZE);
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

function drawTable(doc: PDFDocument, cursor: Cursor, block: TableBlock, font: PDFFont, boldFont: PDFFont): Cursor {
  let current = cursor;
  if (block.title) {
    current = ensureSpace(current, doc, LINE_HEIGHT + 4);
    current.page.drawText(block.title, { x: MARGIN, y: current.y - BODY_FONT_SIZE, size: BODY_FONT_SIZE, font: boldFont, color: rgb(0, 0, 0) });
    current = { page: current.page, y: current.y - LINE_HEIGHT - 4 };
  }
  const tableWidth = PAGE_WIDTH - MARGIN * 2;
  const columnCount = block.columns.length || 1;
  const columnWidth = tableWidth / columnCount;
  const cellPaddingX = 5;
  const allRows = [block.columns, ...block.rows];
  for (const [rowIndex, row] of allRows.entries()) {
    const isHeader = rowIndex === 0;
    const cellFont = isHeader ? boldFont : font;
    const wrappedCells = row.map((cell) => wrapPlainText(cell ?? "", columnWidth - cellPaddingX * 2, cellFont, TABLE_FONT_SIZE));
    const rowLineCount = Math.max(1, ...wrappedCells.map((lines) => lines.length));
    const rowHeight = rowLineCount * (TABLE_FONT_SIZE + 3) + TABLE_ROW_PADDING;
    current = ensureSpace(current, doc, rowHeight);
    const rowTopY = current.y;
    for (const [columnIndex, lines] of wrappedCells.entries()) {
      const cellX = MARGIN + columnIndex * columnWidth + cellPaddingX;
      let lineY = rowTopY - TABLE_ROW_PADDING / 2 - TABLE_FONT_SIZE;
      for (const line of lines) {
        current.page.drawText(line, { x: cellX, y: lineY, size: TABLE_FONT_SIZE, font: cellFont, color: rgb(0, 0, 0) });
        lineY -= TABLE_FONT_SIZE + 3;
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
  const { font, boldFont } = await embedUnicodeFonts(doc);
  let cursor: Cursor = { page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]), y: PAGE_HEIGHT - MARGIN };
  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        cursor = drawHeading(doc, cursor, block, boldFont);
        break;
      case "paragraph":
        cursor = drawParagraph(doc, cursor, block, font, boldFont);
        cursor = { page: cursor.page, y: cursor.y - 8 }; // espace entre paragraphes
        break;
      case "table":
        cursor = drawTable(doc, cursor, block, font, boldFont);
        break;
      case "spacer":
        cursor = ensureSpace(cursor, doc, block.height ?? LINE_HEIGHT);
        cursor = { page: cursor.page, y: cursor.y - (block.height ?? LINE_HEIGHT) };
        break;
    }
  }
  return Buffer.from(await doc.save());
}
