import { PDFDocument, rgb } from "pdf-lib";
import { sanitizeForPdf } from "./dao-template-pdf";
import { embedUnicodeFonts } from "./pdf-font";

/** Répare les anciennes chaînes UTF-8 lues comme du latin-1 (ex. ReprÃ©sentant). */
function repairMojibake(value: string) {
  let repaired = value;
  for (let pass = 0; pass < 2 && /[ÃÂâ]/.test(repaired); pass += 1) {
    const candidate = Buffer.from(repaired, "latin1").toString("utf8");
    if (candidate === repaired || candidate.includes("�")) break;
    repaired = candidate;
  }
  return repaired;
}

function cleanText(value: string) {
  return sanitizeForPdf(repairMojibake(value).normalize("NFC"));
}

function wrapLine(value: string, maximum = 100) {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (`${current} ${word}`.trim().length > maximum && current) { lines.push(current); current = word; }
    else current = `${current} ${word}`.trim();
  }
  if (current || !lines.length) lines.push(current);
  return lines;
}

// column_ratios (facultatif) donne la largeur relative de chaque colonne
// telle que mesurée sur la vraie page du DAO (ex. [0.4, 0.2, 0.2, 0.2]) —
// sans ça, les colonnes étaient toutes divisées à égalité, ce qui ne
// ressemble presque jamais au tableau réel du DAO (une colonne de
// désignation est presque toujours bien plus large que les colonnes de
// quantité/unité qui l'entourent).
type PrintableTable = { title: string; columns: string[]; rows: string[][]; column_ratios?: number[] };

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN_X = 54;
const TOP_Y = 790;
const BOTTOM_Y = 50;

export async function createPrintableSubmissionPdf(title: string, company: Record<string, unknown>, extraLines: string[] = [], tables: PrintableTable[] = []) {
  const doc = await PDFDocument.create();
  const { font, boldFont } = await embedUnicodeFonts(doc);

  const lines = [
    title.toUpperCase(), "", `Entreprise : ${company.legal_name || company.trade_name || "À compléter"}`,
    `Représentant : ${company.representative_name || "À compléter"}`,
    `Fonction : ${company.representative_role || "À compléter"}`,
    `Adresse : ${company.address || "À compléter"}`, `NIF : ${company.nif || "À compléter"}   STAT : ${company.stat || "À compléter"}`,
    "", ...extraLines, "", "Document à lire, imprimer et signer ou parapher selon les exigences du DAO.",
    "", "Lieu et date : ________________________________", "", "Signature et cachet :", "", "", "_______________________________",
  ].flatMap((line) => wrapLine(cleanText(line)));

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = TOP_Y;
  for (const line of lines) {
    if (y < BOTTOM_Y) { page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]); y = TOP_Y; }
    if (line.trim()) page.drawText(line, { x: MARGIN_X, y, size: 11, font, color: rgb(0, 0, 0) });
    y -= 17;
  }

  // Le DAO présente souvent plusieurs petits tableaux à la suite SUR LA MÊME
  // page (ex. deux tableaux de chiffre d'affaires l'un sous l'autre) : les
  // forcer chacun sur sa propre page ne ressemble plus du tout à l'original.
  // On les empile donc avec un curseur Y commun, et on ne change de page que
  // lorsqu'il n'y a vraiment plus la place.
  const ROW_HEIGHT = 19;
  const TITLE_GAP = 24;
  const TABLE_GAP = 16;
  for (const table of tables) {
    const columns = table.columns.slice(0, 6);
    if (!columns.length) continue;
    const rows = table.rows.length ? table.rows : [columns.map(() => "")];
    const totalWidth = 487;
    const ratios = table.column_ratios?.length === columns.length && table.column_ratios.every((value) => value > 0)
      ? table.column_ratios
      : columns.map(() => 1);
    const ratioSum = ratios.reduce((sum, value) => sum + value, 0) || 1;
    const widths = ratios.map((ratio) => (ratio / ratioSum) * totalWidth);
    const offsets = widths.reduce<number[]>((acc, width, index) => [...acc, (acc[index - 1] ?? 0) + (index === 0 ? 0 : widths[index - 1])], []);

    if (y - (TITLE_GAP + ROW_HEIGHT) < BOTTOM_Y) { page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]); y = TOP_Y; }
    page.drawText(cleanText(table.title || "Tableau du DAO"), { x: MARGIN_X, y, size: 12, font: boldFont, color: rgb(0, 0, 0) });
    y -= TITLE_GAP;

    const drawRow = (values: string[]) => {
      if (y - ROW_HEIGHT < BOTTOM_Y) { page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]); y = TOP_Y; }
      values.forEach((value, columnIndex) => {
        const width = widths[columnIndex];
        const x = MARGIN_X + offsets[columnIndex];
        page.drawRectangle({ x, y: y - ROW_HEIGHT, width, height: ROW_HEIGHT, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.7 });
        const clipped = cleanText(value).slice(0, Math.max(8, Math.floor(width / 5.2)));
        if (clipped.trim()) page.drawText(clipped, { x: x + 3, y: y - ROW_HEIGHT + 6, size: 8, font, color: rgb(0, 0, 0) });
      });
      y -= ROW_HEIGHT;
    };
    drawRow(columns);
    for (const row of rows) drawRow(columns.map((_, columnIndex) => String(row[columnIndex] ?? "")));
    y -= TABLE_GAP;
  }

  return Buffer.from(await doc.save());
}
