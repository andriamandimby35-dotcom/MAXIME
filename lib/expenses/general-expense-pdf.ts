// PDF du « Résumé dépense » d'un chantier, fabriqué directement par
// l'application (pdf-lib) plutôt que par l'impression du navigateur.
//
// Pourquoi : window.print() imprimait toute la page (2 feuilles blanches
// avant la bonne, vérifié en vrai) et le navigateur ajoutait lui-même en
// haut et en bas la date, le titre du site et l'adresse de la page. Ici le
// PDF ne contient QUE le résumé, sur des pages A4 qui se suivent, avec pour
// seul élément répété le numéro de page. Même fichier pour enregistrer,
// partager (WhatsApp...) et imprimer.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export type ExpensePdfRow = { label: string; value: string; highlight?: boolean; variant?: "sub" | "line" | "total" };
export type ExpensePdfSection = { heading: string; rows: ExpensePdfRow[]; emptyText?: string };
export type ExpensePdfData = {
  title: string;
  subtitle: string;
  sections: ExpensePdfSection[];
  totalLabel: string;
  totalValue: string;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 42;
const MARGIN_TOP = 46;
const MARGIN_BOTTOM = 52; // place pour le numéro de page seul
const GREEN = rgb(0.078, 0.357, 0.208);
const DARK = rgb(0.06, 0.1, 0.08);
const GRAY = rgb(0.4, 0.45, 0.42);
const RED = rgb(0.64, 0.23, 0.24);
const LINE = rgb(0.82, 0.88, 0.84);

// Les polices standard du PDF ne savent écrire que le jeu de caractères
// « WinAnsi » : on remplace les espaces insécables fines des montants
// (« 1 500 000 ») par de simples espaces et on retire tout ce qu'elles ne
// connaissent pas (ex. le rond rouge 🔴), sinon la création du PDF échoue.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split(""));
export function toPdfText(value: string): string {
  return value
    .replace(/[    ]/g, " ")
    .replace(/🔴\s*/gu, "")
    .split("")
    .filter((char) => char.charCodeAt(0) <= 0xff || WIN_ANSI_EXTRA.has(char))
    .join("")
    .replace(/[\r\n\t]+/g, " ");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = toPdfText(text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { current = candidate; continue; }
    if (current) lines.push(current);
    // Mot plus long que la ligne : on le coupe par morceaux.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export async function buildGeneralExpensePdf(data: ExpensePdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const contentWidth = PAGE_WIDTH - MARGIN_X * 2;

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN_TOP;
  const ensureSpace = (needed: number) => {
    if (y - needed >= MARGIN_BOTTOM) return;
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN_TOP;
  };

  // Titre
  for (const line of wrap(data.title, bold, 17, contentWidth)) {
    ensureSpace(22);
    page.drawText(line, { x: MARGIN_X, y: y - 15, size: 17, font: bold, color: DARK });
    y -= 22;
  }
  y -= 2;
  for (const line of wrap(data.subtitle, regular, 9.5, contentWidth)) {
    ensureSpace(14);
    page.drawText(line, { x: MARGIN_X, y: y - 9, size: 9.5, font: regular, color: GRAY });
    y -= 13;
  }
  y -= 8;

  for (const section of data.sections) {
    // Un titre de section ne reste jamais seul en bas de page.
    ensureSpace(60);
    y -= 8;
    page.drawText(toPdfText(section.heading), { x: MARGIN_X, y: y - 12, size: 12.5, font: bold, color: GREEN });
    y -= 20;
    page.drawLine({ start: { x: MARGIN_X, y }, end: { x: PAGE_WIDTH - MARGIN_X, y }, thickness: 1, color: GREEN });
    y -= 6;
    if (!section.rows.length) {
      ensureSpace(18);
      page.drawText(toPdfText(section.emptyText ?? "Aucune donnée."), { x: MARGIN_X, y: y - 11, size: 10, font: regular, color: GRAY });
      y -= 20;
      continue;
    }
    for (const row of section.rows) {
      const variant = row.variant;
      const indent = variant === "line" ? 12 : 0;
      const font = variant === "line" ? regular : bold;
      const size = variant === "line" ? 9.5 : 10;
      const value = toPdfText(row.value);
      const valueWidth = font.widthOfTextAtSize(value, size);
      const labelMax = Math.max(120, contentWidth - indent - valueWidth - 16);
      const labelLines = wrap(row.label, font, size, labelMax);
      const lineHeight = size + 3;
      const height = labelLines.length * lineHeight + 8;
      ensureSpace(height);
      const color = row.highlight ? RED : DARK;
      if (variant === "sub") page.drawRectangle({ x: MARGIN_X, y: y - height + 2, width: contentWidth, height: height - 2, color: rgb(0.93, 0.96, 0.94) });
      if (variant === "total") page.drawLine({ start: { x: MARGIN_X, y: y + 1 }, end: { x: PAGE_WIDTH - MARGIN_X, y: y + 1 }, thickness: 1, color: GREEN });
      labelLines.forEach((line, index) => page.drawText(line, { x: MARGIN_X + indent + (variant === "sub" ? 4 : 0), y: y - 12 - index * lineHeight, size, font, color: variant === "sub" ? GREEN : color }));
      page.drawText(value, { x: PAGE_WIDTH - MARGIN_X - valueWidth - (variant === "sub" ? 4 : 0), y: y - 12, size, font, color: row.highlight ? RED : (variant === "line" ? DARK : GREEN) });
      y -= height;
      if (variant !== "sub" && variant !== "total") page.drawLine({ start: { x: MARGIN_X, y: y + 2 }, end: { x: PAGE_WIDTH - MARGIN_X, y: y + 2 }, thickness: 0.4, color: LINE });
    }
  }

  // Total général (jamais coupé en deux pages).
  ensureSpace(52);
  y -= 14;
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: PAGE_WIDTH - MARGIN_X, y }, thickness: 2, color: GREEN });
  y -= 24;
  const totalValue = toPdfText(data.totalValue);
  page.drawText(toPdfText(data.totalLabel), { x: MARGIN_X, y, size: 12, font: bold, color: DARK });
  page.drawText(totalValue, { x: PAGE_WIDTH - MARGIN_X - bold.widthOfTextAtSize(totalValue, 16), y: y - 1, size: 16, font: bold, color: GREEN });

  // Seul élément répété : le numéro de page (pas de date, de titre ni d'adresse).
  const pages = doc.getPages();
  pages.forEach((current, index) => {
    const label = `${index + 1} / ${pages.length}`;
    current.drawText(label, { x: (PAGE_WIDTH - regular.widthOfTextAtSize(label, 9)) / 2, y: 26, size: 9, font: regular, color: GRAY });
  });

  doc.setTitle(toPdfText(data.title));
  return doc.save();
}
