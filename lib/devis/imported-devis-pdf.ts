import { closingBlock } from "@/lib/pdf-closing";

// PDF d'un devis ajouté par PDF, présenté COMME LE PDF D'ORIGINE (bordereau
// détail quantitatif et estimatif) : titre centré sur deux lignes, tableau fin
// N° | DESIGNATION DES TRAVAUX | UNITE | QUANTITE | PRIX UNITAIRE | MONTANT Ar,
// ligne de rubrique grisée, texte complet de chaque article (retours à la ligne
// conservés), ligne « Concerne : … », « TOTAL <RUBRIQUE> », récapitulation,
// « Page X de Y ». Format A4 PORTRAIT. Le PDF des DAO (official-pdf.ts) n'est pas touché.

export type ImportedPdfRow =
  | { kind: "section"; number: string; title: string }
  | { kind: "subsection"; title: string }
  | { kind: "item"; number: string; text: string; concerne?: string; unit: string; quantity: number; unitPrice: number | null; total: number | null }
  | { kind: "subtotal"; title: string; total: number };

export type ImportedPdfInput = {
  /** En-tête de société, répété sur chaque page (comme les PDF du DAO). */
  header?: { companyName: string; companyDetails: string[]; documentLabel: string; titleLabel: string; date: string };
  title: string; // 2e ligne du titre (nom du chantier)
  subtitle?: string; // ex. « DEVIS INTERNE » (petite ligne en plus, seulement pour le devis interne)
  columns: [string, string, string, string, string, string];
  rows: ImportedPdfRow[];
  recap: Array<{ number: string; title: string; total: number }>;
  total: number;
  extraTotals?: Array<{ label: string; amount: number }>;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const LEFT = 34;
const RIGHT = 34;
const TOP = 34;
const BOTTOM = 40;
const TABLE_WIDTH = PAGE_WIDTH - LEFT - RIGHT;
const FONT = 7.6;
const LINE = 9.2;
const GREY: [number, number, number] = [0.85, 0.85, 0.85];

// Largeurs Helvetica (par 1000 em) pour ASCII 32..126.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Accents → lettre de base (même largeur), pour mesurer.
const BASE: Record<string, string> = { à: "a", â: "a", ä: "a", á: "a", ã: "a", é: "e", è: "e", ê: "e", ë: "e", î: "i", ï: "i", í: "i", ô: "o", ö: "o", ó: "o", õ: "o", ù: "u", û: "u", ü: "u", ú: "u", ç: "c", ñ: "n", ÿ: "y", À: "A", Â: "A", Ä: "A", É: "E", È: "E", Ê: "E", Ë: "E", Î: "I", Ï: "I", Ô: "O", Ö: "O", Ù: "U", Û: "U", Ü: "U", Ç: "C" };

function charWidth(char: string, bold: boolean) {
  const table = bold ? W_BOLD : W_REG;
  if (char === "œ" || char === "Œ") return 944;
  if (char === " " || char === " ") return 278;
  if (/[‘’]/.test(char)) return table[7] ?? 191;
  if (/[–—]/.test(char)) return 556;
  if (char === "•") return 350;
  const mapped = BASE[char] ?? char;
  const code = mapped.charCodeAt(0);
  if (code >= 32 && code <= 126) return table[code - 32];
  return 556;
}

function textWidth(text: string, size: number, bold = false) {
  let total = 0;
  for (const char of text) total += charWidth(char, bold);
  return (total * size) / 1000;
}

// Unicode → octet WinAnsi (cp1252) pour que « œ », « ’ », « – », « • » s'affichent comme dans l'original.
const CP1252: Record<string, number> = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f };

function pdfString(value: string) {
  let out = "";
  for (const char of value.normalize("NFC")) {
    let code = CP1252[char] ?? char.codePointAt(0)!;
    if (char === " " || char === " ") code = 0x20;
    if (code > 0xff) code = 0x3f;
    if (code < 0x20) code = 0x20;
    const ch = String.fromCharCode(code);
    out += ch === "\\" || ch === "(" || ch === ")" ? `\\${ch}` : ch;
  }
  return out;
}

function repairMojibake(value: string) {
  let repaired = value;
  for (let pass = 0; pass < 2 && /[ÃÂ]/.test(repaired); pass += 1) {
    const candidate = Buffer.from(repaired, "latin1").toString("utf8");
    if (candidate === repaired || candidate.includes("�")) break;
    repaired = candidate;
  }
  return repaired;
}

function wrap(text: string, maxWidth: number, size: number, bold = false) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, size, bold) <= maxWidth) { current = candidate; continue; }
    if (current) lines.push(current);
    // mot seul plus large que la case : on le coupe
    if (textWidth(word, size, bold) > maxWidth) {
      let piece = "";
      for (const char of word) {
        if (textWidth(piece + char, size, bold) > maxWidth) { lines.push(piece); piece = char; } else piece += char;
      }
      current = piece;
    } else current = word;
  }
  if (current) lines.push(current);
  return lines;
}

// Texte d'un article : chaque retour à la ligne du texte d'origine est conservé.
function paragraphLines(text: string, maxWidth: number, size: number, bold = false) {
  const out: string[] = [];
  for (const paragraph of repairMojibake(text).replace(/\r/g, "").split("\n")) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    out.push(...wrap(trimmed, maxWidth, size, bold));
  }
  return out;
}

// 1 500 000.00 : espaces pour les milliers, point pour les décimales (comme le devis d'origine).
export function formatAmount(value: number, decimals = 2) {
  const fixed = Math.abs(Number(value) || 0).toFixed(decimals);
  const [integer, decimal] = fixed.split(".");
  const spaced = integer.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${value < 0 ? "-" : ""}${spaced}${decimal ? `.${decimal}` : ""}`;
}

function formatQuantity(value: number) {
  const n = Number(value) || 0;
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? formatAmount(n, 2) : formatAmount(n, 3);
}

type Cmd = { text: string; x: number; y: number; size: number; bold: boolean };
type Ln = { x1: number; y1: number; x2: number; y2: number; w: number };
type Fill = { x: number; y: number; w: number; h: number; rgb: [number, number, number] };
type Page = { text: Cmd[]; lines: Ln[]; fills: Fill[] };

function binaryBytes(value: string) {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff;
  return bytes;
}

export function generateImportedDevisPdf(input: ImportedPdfInput) {
  // Colonnes : les deux colonnes de nombres s'élargissent si un montant est très grand.
  const priceTexts = input.rows.flatMap((row) => (row.kind === "item" ? [row.unitPrice === null ? "" : formatAmount(row.unitPrice)] : []));
  const amountTexts = [
    ...input.rows.flatMap((row) => (row.kind === "item" ? [row.total === null ? "" : formatAmount(row.total)] : row.kind === "subtotal" ? [formatAmount(row.total)] : [])),
    ...input.recap.map((entry) => formatAmount(entry.total)), formatAmount(input.total), ...(input.extraTotals ?? []).map((extra) => formatAmount(extra.amount)),
  ];
  const widest = (texts: string[], bold: boolean) => texts.reduce((max, text) => Math.max(max, textWidth(text, FONT, bold)), 0);
  const quantityTexts = input.rows.flatMap((row) => (row.kind === "item" ? [formatQuantity(row.quantity)] : []));
  const colN = 34;
  const colUnit = 32;
  const colQty = Math.max(46, widest(quantityTexts, false) + 10);
  const colPrice = Math.max(62, widest(priceTexts, false) + 10);
  const colAmount = Math.max(66, widest(amountTexts, true) + 10);
  const colText = TABLE_WIDTH - colN - colUnit - colQty - colPrice - colAmount;
  const widths = [colN, colText, colUnit, colQty, colPrice, colAmount];
  const xs: number[] = [LEFT];
  widths.forEach((width, index) => xs.push(xs[index] + width));
  const RIGHT_EDGE = xs[6];
  const TEXT_W = colText - 10;

  const pages: Page[] = [];
  let page: Page = { text: [], lines: [], fills: [] };
  let y = 0; // haut du prochain bloc

  const addText = (text: string, x: number, baseline: number, size = FONT, bold = false) => page.text.push({ text, x, y: baseline, size, bold });
  const hline = (yy: number, x1 = LEFT, x2 = RIGHT_EDGE, w = 0.5) => page.lines.push({ x1, y1: yy, x2, y2: yy, w });
  const vline = (x: number, top: number, bottom: number, w = 0.5) => page.lines.push({ x1: x, y1: top, x2: x, y2: bottom, w });
  const grid = (top: number, bottom: number) => { xs.forEach((x) => vline(x, top, bottom)); hline(bottom); };
  const centered = (text: string, columnIndex: number, baseline: number, size = FONT, bold = false) => addText(text, xs[columnIndex] + (widths[columnIndex] - textWidth(text, size, bold)) / 2, baseline, size, bold);
  const rightAligned = (text: string, columnIndex: number, baseline: number, size = FONT, bold = false) => addText(text, xs[columnIndex + 1] - textWidth(text, size, bold) - 5, baseline, size, bold);

  const header = () => {
    const labelLines = input.columns.map((label, index) => wrap(label, widths[index] - 4, 7, true));
    const lineCount = Math.max(1, ...labelLines.map((l) => l.length));
    const height = 8 + lineCount * 8.4;
    page.fills.push({ x: LEFT, y: y - height, w: TABLE_WIDTH, h: height, rgb: GREY });
    labelLines.forEach((parts, index) => {
      const startY = y - (height - parts.length * 8.4) / 2 - 6.4;
      parts.forEach((part, k) => addText(part, xs[index] + (widths[index] - textWidth(part, 7, true)) / 2, startY - k * 8.4, 7, true));
    });
    hline(y); grid(y, y - height);
    y -= height;
  };

  const newPage = (first = false, withTableHeader = true) => {
    page = { text: [], lines: [], fills: [] };
    pages.push(page);
    y = PAGE_HEIGHT - TOP;
    if (input.header) {
      // En-tête sur chaque page : la société à gauche, le type de devis, le chantier et la date à droite.
      const h = input.header;
      const rightX = LEFT + 290;
      const rightWidth = PAGE_WIDTH - RIGHT - rightX;
      let leftY = y;
      for (const part of wrap(repairMojibake(h.companyName), 260, 15, true).slice(0, 2)) { addText(part, LEFT, leftY - 12, 15, true); leftY -= 17; }
      for (const detail of h.companyDetails.filter(Boolean).slice(0, 3)) {
        for (const part of wrap(repairMojibake(detail), 260, 7.5).slice(0, 2)) { addText(part, LEFT, leftY - 8, 7.5); leftY -= 9.5; }
      }
      let rightY = y;
      for (const part of wrap(h.documentLabel, rightWidth - 12, 13, true).slice(0, 2)) { addText(part, rightX, rightY - 12, 13, true); rightY -= 16; }
      rightY -= 1;
      for (const part of wrap(`${h.titleLabel} : ${repairMojibake(input.title)}`, rightWidth, 9, true).slice(0, 3)) { addText(part, rightX, rightY - 9, 9, true); rightY -= 11; }
      addText(`Date : ${h.date}`, rightX, rightY - 8, 8); rightY -= 10.5;
      y = Math.min(leftY, rightY) - 6;
      hline(y, LEFT, PAGE_WIDTH - RIGHT, 1);
      y -= 16;
    }
    if (first) {
      const t1 = "BORDEREAU DES DETAILS QUANTITATIFS ET ESTIMATIFS";
      addText(t1, (PAGE_WIDTH - textWidth(t1, 9, true)) / 2, y - 8, 9, true);
      y -= 20;
      for (const part of wrap(repairMojibake(input.title).toLocaleUpperCase("fr-FR"), TABLE_WIDTH - 40, 9, true).slice(0, 3)) {
        addText(part, (PAGE_WIDTH - textWidth(part, 9, true)) / 2, y - 8, 9, true);
        y -= 11;
      }
      if (input.subtitle) {
        addText(input.subtitle, (PAGE_WIDTH - textWidth(input.subtitle, 8, true)) / 2, y - 8, 8, true);
        y -= 11;
      }
      y -= 12;
    }
    if (withTableHeader) header();
  };
  const ensure = (height: number) => { if (y - height < BOTTOM + 14) newPage(); };

  newPage(true);

  for (const row of input.rows) {
    if (row.kind === "section") {
      const lines = wrap(repairMojibake(row.title).toLocaleUpperCase("fr-FR"), colText + colUnit + colQty + colPrice + colAmount - 12, FONT, true);
      const height = 4 + lines.length * LINE;
      ensure(height + LINE * 2);
      page.fills.push({ x: LEFT, y: y - height, w: TABLE_WIDTH, h: height, rgb: GREY });
      centered(row.number, 0, y - 2 - LINE + 2.2, FONT, true);
      lines.forEach((part, index) => addText(part, xs[1] + 5, y - 2 - LINE + 2.2 - index * LINE, FONT, true));
      hline(y); hline(y - height); vline(LEFT, y, y - height); vline(xs[1], y, y - height); vline(RIGHT_EDGE, y, y - height);
      y -= height;
      continue;
    }
    if (row.kind === "subsection") {
      const lines = wrap(repairMojibake(row.title), TEXT_W, FONT, true);
      const height = 4 + lines.length * LINE;
      ensure(height + LINE * 2);
      lines.forEach((part, index) => addText(part, xs[1] + 5, y - 2 - LINE + 2.2 - index * LINE, FONT, true));
      grid(y, y - height);
      y -= height;
      continue;
    }
    if (row.kind === "subtotal") {
      const label = `TOTAL ${repairMojibake(row.title).toLocaleUpperCase("fr-FR")}`;
      const lines = wrap(label, xs[5] - LEFT - 12, FONT, true);
      const height = 4 + lines.length * LINE;
      ensure(height + 2);
      lines.forEach((part, index) => addText(part, xs[5] - 6 - textWidth(part, FONT, true), y - 2 - LINE + 2.2 - index * LINE, FONT, true));
      rightAligned(formatAmount(row.total), 5, y - 2 - LINE + 2.2, FONT, true);
      hline(y); hline(y - height); vline(LEFT, y, y - height); vline(xs[5], y, y - height); vline(RIGHT_EDGE, y, y - height);
      y -= height;
      continue;
    }

    // Article : texte complet (retours à la ligne gardés) puis « Concerne : … ».
    const bodyLines = paragraphLines(row.text, TEXT_W, FONT);
    const concerneText = String(row.concerne ?? "").trim();
    const concerneLines = concerneText && !/^concerne\b/i.test(concerneText) ? paragraphLines(`Concerne : ${concerneText}`, TEXT_W, FONT) : concerneText ? paragraphLines(concerneText, TEXT_W, FONT) : [];
    const alreadyHasConcerne = bodyLines.some((line) => /^concerne\b/i.test(line));
    const allLines = alreadyHasConcerne ? bodyLines : [...bodyLines, ...concerneLines];
    let index = 0;
    let firstChunk = true;
    while (index < allLines.length || firstChunk) {
      const available = Math.floor((y - (BOTTOM + 14) - 6) / LINE);
      if (available < Math.min(3, allLines.length - index || 1)) { newPage(); continue; }
      const take = Math.max(1, Math.min(allLines.length - index, available));
      const height = 6 + take * LINE;
      const chunk = allLines.slice(index, index + take);
      chunk.forEach((line, k) => addText(line, xs[1] + 5, y - 3 - LINE + 2.2 - k * LINE, FONT));
      if (firstChunk) {
        const middle = y - height / 2 - FONT * 0.35;
        centered(row.number, 0, middle);
        const unitSize = textWidth(row.unit, FONT) > colUnit - 4 ? Math.max(5.5, FONT * (colUnit - 4) / textWidth(row.unit, FONT)) : FONT;
        centered(row.unit, 2, middle, unitSize);
        rightAligned(formatQuantity(row.quantity), 3, middle);
        if (row.unitPrice !== null) rightAligned(formatAmount(row.unitPrice), 4, middle);
        if (row.total !== null) rightAligned(formatAmount(row.total), 5, middle);
      }
      grid(y, y - height);
      y -= height;
      index += take;
      firstChunk = false;
      if (index < allLines.length) newPage();
    }
  }

  // Récapitulatif : EXACTEMENT la présentation du récapitulatif du DAO (cases encadrées,
  // titre, en-tête REF / DÉSIGNATION / MONTANT (Ar), lignes en gras et majuscules,
  // total général gras et plus grand). Montants écrits comme dans le DAO (« 1 234 567 Ar »).
  {
    const recapMoney = (value: number) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(value) || 0).replace(/[\u202f\u00a0]/g, " ")} Ar`;
    const refWidth = 50;
    const amountWidth = 120;
    const titleWidth = TABLE_WIDTH - refWidth - amountWidth;
    const cell = (x: number, top: number, width: number, height: number, value: string, bold = false, align: "left" | "center" | "right" = "left", size = 8.2) => {
      hline(top, x, x + width, 0.55); hline(top - height, x, x + width, 0.55);
      vline(x, top, top - height, 0.55); vline(x + width, top, top - height, 0.55);
      let fontSize = size;
      while (fontSize > 6 && textWidth(value, fontSize, bold) > width - 10) fontSize -= 0.4;
      const w = textWidth(value, fontSize, bold);
      const tx = align === "center" ? x + Math.max(4, (width - w) / 2) : align === "right" ? x + Math.max(4, width - w - 5) : x + 5;
      addText(value, tx, top - (height + fontSize * 0.7) / 2 + 1, fontSize, bold);
    };
    const recapTitle = "RECAPITULATION GENERALE";
    const drawHead = () => {
      cell(LEFT, y, TABLE_WIDTH, 24, recapTitle, true, "center"); y -= 24;
      cell(LEFT, y, refWidth, 20, "REF", true, "center");
      cell(LEFT + refWidth, y, titleWidth, 20, "DÉSIGNATION", true, "center");
      cell(LEFT + refWidth + titleWidth, y, amountWidth, 20, "MONTANT (Ar)", true, "center");
      y -= 20;
    };
    // Comme le DAO : une rubrique à 0 n'apparaît pas dans le récapitulatif.
    const recapEntries = input.recap.filter((entry) => Number(entry.total) > 0);
    const totals = [{ label: "TOTAL", amount: input.total }, ...(input.extraTotals ?? []).map((extra) => ({ label: extra.label, amount: extra.amount }))];
    const needed = 24 + 20 + recapEntries.length * 22 + 30 + Math.max(0, totals.length - 1) * 22;
    // Tient sur la page du bordereau → pas de page supplémentaire ; sinon une page à part, avec le même en-tête.
    if (y - needed < BOTTOM + 14) newPage(false, false); else y -= 18;
    drawHead();
    for (const entry of recapEntries) {
      if (y - 22 < BOTTOM + 14) { newPage(false, false); drawHead(); }
      cell(LEFT, y, refWidth, 22, String(entry.number).toLocaleUpperCase("fr-FR"), true, "center");
      cell(LEFT + refWidth, y, titleWidth, 22, repairMojibake(entry.title).toLocaleUpperCase("fr-FR"), true);
      cell(LEFT + refWidth + titleWidth, y, amountWidth, 22, recapMoney(entry.total), true, "right");
      y -= 22;
    }
    totals.forEach((total, index) => {
      const height = index === 0 ? 30 : 22;
      const size = index === 0 ? 11 : 8.2;
      if (y - height < BOTTOM + 14) { newPage(false, false); drawHead(); }
      cell(LEFT, y, refWidth + titleWidth, height, total.label.toLocaleUpperCase("fr-FR"), true, "right", size);
      cell(LEFT + refWidth + titleWidth, y, amountWidth, height, recapMoney(total.amount), true, "right", size);
      y -= height;
    });
  }

  // Fin du devis (dernière page seulement) : somme en lettres, « Fait à », signature, texte de loi — comme les DAO.
  {
    const lastExtra = (input.extraTotals ?? []).length > 0 ? input.extraTotals![input.extraTotals!.length - 1].amount : input.total;
    const block = closingBlock(lastExtra, "Arrêté le présent devis à la somme de :");
    const SIZE = 8.2;
    const strongLines = block.strong.map((text) => wrap(text, TABLE_WIDTH, SIZE, true));
    const smallLines = block.small.flatMap((text) => wrap(text, TABLE_WIDTH, 7));
    const needed = 30 + strongLines.reduce((sum, parts) => sum + parts.length * 12 + 6, 0) + 44 + smallLines.length * 9.5 + 10;
    if (y - needed < BOTTOM + 14) newPage(false, false);
    y -= 14;
    strongLines.forEach((parts, index) => {
      parts.forEach((part) => { addText(part, LEFT, y - 8, SIZE, true); y -= 12; });
      y -= index === block.strong.length - 2 ? 18 : index === block.strong.length - 1 ? 40 : 6;
    });
    smallLines.forEach((part) => { addText(part, LEFT, y - 8, 7); y -= 9.5; });
  }

  // Numéros de page « Page X de Y ».
  pages.forEach((p, index) => {
    const label = `Page ${index + 1} de ${pages.length}`;
    p.text.push({ text: label, x: (PAGE_WIDTH - textWidth(label, 7)) / 2, y: BOTTOM - 10, size: 7, bold: false });
  });

  const streamOf = (p: Page) => {
    const c: string[] = ["0 G", "0 g"];
    for (const f of p.fills) c.push(`${f.rgb[0]} ${f.rgb[1]} ${f.rgb[2]} rg ${f.x.toFixed(2)} ${f.y.toFixed(2)} ${f.w.toFixed(2)} ${f.h.toFixed(2)} re f`, "0 g");
    for (const l of p.lines) c.push(`${l.w.toFixed(2)} w ${l.x1.toFixed(2)} ${l.y1.toFixed(2)} m ${l.x2.toFixed(2)} ${l.y2.toFixed(2)} l S`);
    for (const t of p.text) c.push(`BT /${t.bold ? "F2" : "F1"} ${t.size.toFixed(2)} Tf ${t.x.toFixed(2)} ${t.y.toFixed(2)} Td (${pdfString(t.text)}) Tj ET`);
    return c.join("\n");
  };

  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  objects.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((p, i) => {
    const stream = streamOf(p);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${binaryBytes(stream).length} >>\nstream\n${stream}\nendstream`);
  });
  let pdf = "%PDF-1.4\n%âãÏÓ\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(binaryBytes(pdf).length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = binaryBytes(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return binaryBytes(pdf);
}
