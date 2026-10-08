import { amountInWordsFr } from "@/lib/number-to-words-fr";

export type OfficialPdfRow =
  | { kind: "section"; title: string; number?: string }
  // unitPrice / total à null : prix pas encore connu, la case reste vide.
  | { kind: "item"; number: string; designation: string; /** Ligne « Concerne : … » du bordereau d'origine. */ concerne?: string; unit: string; quantity: number; unitPrice: number | null; total: number | null }
  | { kind: "subsection"; title: string }
  | { kind: "subtotal"; title: string; total: number };

export type OfficialPdfInput = {
  companyName: string;
  companyDetails: string[];
  daoTitle: string;
  /** Titre en haut à droite (par défaut « DEVIS OFFICIEL - DAO »). */
  documentLabel?: string;
  /** Lignes après le total (ex. « TMP 8 % » puis « TOTAL AVEC TMP 8 % »), dans le détail et dans la récapitulation. */
  extraTotals?: Array<{ label: string; amount: number }>;
  /** Mot devant le titre (par défaut « DAO » ; « Chantier » pour un devis ajouté par PDF). */
  titleLabel?: string;
  daoReference?: string;
  clientName?: string;
  estimateDate: string;
  rows: OfficialPdfRow[];
  grandTotal: number;
  recapGroups?: Array<{ reference?: string; title: string; entries: Array<{ reference?: string; title: string; total: number }> }>;
  bdqeLayout?: {
    annotations?: string[];
    detail_table?: { title?: string; columns?: string[]; total_label?: string; source_reference?: string };
    recap_tables?: Array<{ reference?: string; title?: string; columns?: string[]; row_titles?: string[]; total_label?: string }>;
  };
  includeExternalRecap?: boolean;
  internalFinancialSummary?: Array<{ title: string; total: number }>;
};

// Format A4 PORTRAIT, toujours (règle de l'application : tout PDF à imprimer
// est en portrait).
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const LEFT = 34;
const RIGHT = 34;
const TOP = 30;
const BOTTOM = 30;
const TABLE_WIDTH = PAGE_WIDTH - LEFT - RIGHT;
const COLUMN_WIDTHS = [40, 205, 36, 56, 86, 104.28]; // somme = TABLE_WIDTH (527.28)
const SECTION_FILL: [number, number, number] = [0.85, 0.92, 0.8]; // vert clair, comme les titres de section du bordereau

type DrawCommand = { text: string; x: number; y: number; size: number; bold?: boolean };
type LineCommand = { x1: number; y1: number; x2: number; y2: number; width?: number };
type FillCommand = { x: number; y: number; width: number; height: number; gray: number; rgb?: [number, number, number] };
type PageCommands = { draw: DrawCommand[]; lines: LineCommand[]; fills: FillCommand[] };

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function repairMojibake(value: string) {
  let repaired = value;
  for (let pass = 0; pass < 2 && /[ÃÂâ]/.test(repaired); pass += 1) {
    const candidate = Buffer.from(repaired, "latin1").toString("utf8");
    if (candidate === repaired || candidate.includes("\uFFFD")) break;
    repaired = candidate;
  }
  return repaired;
}

function pdfText(value: string) {
  return repairMojibake(cleanText(value)).normalize("NFC")
    .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
    .replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/œ/g, "oe").replace(/Œ/g, "OE")
    .replace(/\u2022/g, "-").replace(/\u2026/g, "...")
    .replace(/\u2039/g, "<").replace(/\u203a/g, ">").replace(/\u2122/g, "(TM)").replace(/[\u2020\u2021]/g, "")
    .replace(/[^\x20-\x7e\u00a0-\u00ff]/g, "?");
}

function wrapText(value: string, maxWidth: number, fontSize: number) {
  const words = cleanText(value).split(" ").filter(Boolean);
  const maxChars = Math.max(8, Math.floor(maxWidth / (fontSize * 0.52)));
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) current = candidate;
    else { if (current) lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function money(value: number) {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(value) || 0)} Ar`;
}

// Nombre dans une case du tableau (sans « Ar » : l'unité est dans l'en-tête de colonne).
function amountCell(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(value));
}

// Largeur approximative d'un texte en Helvetica (pour aligner à droite / centrer).
function textWidth(value: string, size: number, bold = false) {
  let em = 0;
  for (const char of cleanText(value)) {
    if (/\d/.test(char)) em += 0.556;
    else if (char === " " || char === "." || char === "," || char === "/" || char === ":" || char === ";" || char === "'") em += 0.278;
    else if (char === "-" || char === "(" || char === ")") em += 0.333;
    else if (/[A-ZÀ-ÖØ-Þ]/.test(char)) em += bold ? 0.74 : 0.68;
    else em += bold ? 0.56 : 0.5;
  }
  return em * size;
}

function quantity(value: number) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3 }).format(Number(value) || 0);
}

function binaryBytes(value: string) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

function pageStream(page: PageCommands) {
  const commands: string[] = ["0 G", "0 g"];
  for (const fill of page.fills) {
    const color = fill.rgb ? `${fill.rgb[0]} ${fill.rgb[1]} ${fill.rgb[2]} rg` : `${fill.gray} g`;
    commands.push(`${color} ${fill.x.toFixed(2)} ${fill.y.toFixed(2)} ${fill.width.toFixed(2)} ${fill.height.toFixed(2)} re f`, "0 g");
  }
  for (const line of page.lines) {
    commands.push(`${(line.width ?? 0.5).toFixed(2)} w ${line.x1.toFixed(2)} ${line.y1.toFixed(2)} m ${line.x2.toFixed(2)} ${line.y2.toFixed(2)} l S`);
  }
  for (const item of page.draw) {
    commands.push(`BT /${item.bold ? "F2" : "F1"} ${item.size.toFixed(2)} Tf ${item.x.toFixed(2)} ${item.y.toFixed(2)} Td (${pdfText(item.text)}) Tj ET`);
  }
  return commands.join("\n");
}

export function generateOfficialEstimatePdf(input: OfficialPdfInput) {
  const pages: PageCommands[] = [];
  let page: PageCommands = { draw: [], lines: [], fills: [] };
  let y = 0;
  const addText = (text: string, x: number, baseline: number, size = 9, bold = false) => page.draw.push({ text, x, y: baseline, size, bold });
  // Grille du tableau : traits verticaux entre les colonnes + cadre (+ trait du haut pour l'en-tête).
  const drawGrid = (top: number, bottom: number, withTop = false) => {
    let gx = LEFT;
    for (let index = 0; index <= COLUMN_WIDTHS.length; index += 1) {
      page.lines.push({ x1: gx, y1: top, x2: gx, y2: bottom, width: 0.5 });
      if (index < COLUMN_WIDTHS.length) gx += COLUMN_WIDTHS[index];
    }
    if (withTop) page.lines.push({ x1: LEFT, y1: top, x2: PAGE_WIDTH - RIGHT, y2: top, width: 0.6 });
    page.lines.push({ x1: LEFT, y1: bottom, x2: PAGE_WIDTH - RIGHT, y2: bottom, width: 0.5 });
  };
  const columnX = (index: number) => LEFT + COLUMN_WIDTHS.slice(0, index).reduce((sum, width) => sum + width, 0);
  // Texte dans une colonne : à gauche, centré ou aligné à droite (nombres).
  const addColumnText = (text: string, columnIndex: number, baseline: number, align: "left" | "center" | "right", size = 7.6, bold = false) => {
    if (!text) return;
    const x = columnX(columnIndex);
    const width = COLUMN_WIDTHS[columnIndex];
    const textW = textWidth(text, size, bold);
    const textX = align === "right" ? x + width - textW - 5 : align === "center" ? x + Math.max(2, (width - textW) / 2) : x + 5;
    addText(text, textX, baseline, size, bold);
  };
  const drawTableHeader = () => {
    const height = 26;
    page.fills.push({ x: LEFT, y: y - height + 5, width: TABLE_WIDTH, height, gray: 0.85 });
    const extractedLabels = input.bdqeLayout?.detail_table?.columns ?? [];
    const labels = extractedLabels.length === 6 ? extractedLabels : ["N°", "DÉSIGNATION", "UNITÉ", "QUANTITÉ", "PRIX UNITAIRE", "MONTANT (Ar)"];
    let x = LEFT;
    labels.forEach((label, index) => {
      // Titres de colonnes centrés dans leur case, sur une ou deux lignes.
      const parts = wrapText(label, COLUMN_WIDTHS[index] - 6, 7.6).slice(0, 2);
      const startY = parts.length === 1 ? y - 12 : y - 8;
      parts.forEach((part, lineIndex) => addText(part, x + Math.max(2, (COLUMN_WIDTHS[index] - textWidth(part, 7, true)) / 2), startY - lineIndex * 8, 7, true));
      x += COLUMN_WIDTHS[index];
    });
    drawGrid(y + 5, y - height + 5, true);
    y -= height;
  };
  // En-tête complet (société, devis, DAO, date) : identique sur TOUTES les pages, récapitulatifs compris.
  const drawPageHeader = () => {
    // En-tête portrait : la société à gauche, le devis et le DAO à droite.
    const RIGHT_X = LEFT + 290;
    const RIGHT_WIDTH = PAGE_WIDTH - RIGHT - RIGHT_X;
    const top = y;
    let leftY = top;
    wrapText(input.companyName, 260, 15).slice(0, 2).forEach((part) => { addText(part, LEFT, leftY, 15, true); leftY -= 17; });
    for (const detail of input.companyDetails.slice(0, 3)) {
      wrapText(detail, 260, 7.5).slice(0, 2).forEach((part) => { addText(part, LEFT, leftY, 7.5); leftY -= 9.5; });
    }
    let rightY = top;
    wrapText(input.documentLabel || "DEVIS OFFICIEL - DAO", RIGHT_WIDTH - 12, 13 * 1.3).slice(0, 3).forEach((part) => { addText(part, RIGHT_X, rightY, 13, true); rightY -= 16; });
    rightY -= 1;
    wrapText(`${input.titleLabel || "DAO"} : ${input.daoTitle}`, RIGHT_WIDTH, 9).slice(0, 3).forEach((part) => { addText(part, RIGHT_X, rightY, 9, true); rightY -= 11; });
    const extra = [input.daoReference ? `Référence : ${input.daoReference}` : "", input.clientName ? `Client : ${input.clientName}` : "", `Date : ${input.estimateDate}`].filter(Boolean);
    extra.forEach((text) => wrapText(text, RIGHT_WIDTH, 8).slice(0, 2).forEach((part) => { addText(part, RIGHT_X, rightY, 8); rightY -= 10.5; }));
    y = Math.min(leftY, rightY) - 6;
    page.lines.push({ x1: LEFT, y1: y, x2: PAGE_WIDTH - RIGHT, y2: y, width: 1 }); y -= 20;
  };
  const newPage = () => {
    page = { draw: [], lines: [], fills: [] }; pages.push(page); y = PAGE_HEIGHT - TOP;
    drawPageHeader();
    const detailTitle = cleanText(input.bdqeLayout?.detail_table?.title);
    if (detailTitle) { wrapText(detailTitle.toLocaleUpperCase("fr-FR"), TABLE_WIDTH * 0.78, 9).slice(0, 2).forEach((part) => { addText(part, LEFT, y, 9, true); y -= 12; }); y -= 3; }
    drawTableHeader();
  };
  const ensureSpace = (height: number) => { if (y - height < BOTTOM + 18) newPage(); };
  const horizontalLine = (baseline: number, width = 0.35) => page.lines.push({ x1: LEFT, y1: baseline, x2: PAGE_WIDTH - RIGHT, y2: baseline, width });
  const drawCell = (x: number, top: number, width: number, height: number, value: string, bold = false, align: "left" | "center" | "right" = "left", size = 8.2) => {
    page.lines.push({ x1: x, y1: top, x2: x + width, y2: top, width: 0.55 });
    page.lines.push({ x1: x, y1: top - height, x2: x + width, y2: top - height, width: 0.55 });
    page.lines.push({ x1: x, y1: top, x2: x, y2: top - height, width: 0.55 });
    page.lines.push({ x1: x + width, y1: top, x2: x + width, y2: top - height, width: 0.55 });
    let rendered = cleanText(value);
    // Texte trop long pour la case : on le raccourcit plutôt que de le laisser déborder.
    const charWidth = size * (rendered === rendered.toLocaleUpperCase("fr-FR") ? (bold ? 0.68 : 0.64) : 0.5); // les majuscules sont plus larges
    const maxChars = Math.max(4, Math.floor((width - 10) / charWidth));
    if (rendered.length > maxChars) rendered = `${rendered.slice(0, maxChars - 3)}...`;
    const estimatedWidth = rendered.length * charWidth;
    const textX = align === "center" ? x + Math.max(4, (width - estimatedWidth) / 2) : align === "right" ? x + Math.max(4, width - estimatedWidth - 4) : x + 5;
    addText(rendered, textX, top - Math.min(12 + (size - 8.2), height - 5), size, bold);
  };
  const recapPage = (title: string, entries: Array<{ reference?: string; title: string; total: number }>, withSignature = false, showTotal = true, reference = "", showExtras = false) => {
    page = { draw: [], lines: [], fills: [] }; pages.push(page); y = PAGE_HEIGHT - TOP;
    drawPageHeader();
    const template = (input.bdqeLayout?.recap_tables ?? []).find((item) => cleanText(item.reference) === cleanText(reference) || cleanText(item.title).toLocaleLowerCase("fr-FR") === cleanText(title).replace(/^récapitulation\s+/i, "").toLocaleLowerCase("fr-FR"));
    const labels = template?.columns?.length === 3 ? template.columns : ["REF", "DÉSIGNATION", "MONTANT (Ar)"];
    const refWidth = 50; const amountWidth = 120; const titleWidth = TABLE_WIDTH - refWidth - amountWidth;
    const headingHeight = 24;
    drawCell(LEFT, y, TABLE_WIDTH, headingHeight, title.toLocaleUpperCase("fr-FR"), true, "center");
    y -= headingHeight;
    drawCell(LEFT, y, refWidth, 20, labels[0] || "REF", true, "center");
    drawCell(LEFT + refWidth, y, titleWidth, 20, labels[1] || "DÉSIGNATION", true, "center");
    drawCell(LEFT + refWidth + titleWidth, y, amountWidth, 20, labels[2] || "MONTANT (Ar)", true, "center");
    y -= 20;
    for (const entry of entries) {
      if (y < BOTTOM + 90) {
        page = { draw: [], lines: [], fills: [] }; pages.push(page); y = PAGE_HEIGHT - TOP;
        drawPageHeader();
        drawCell(LEFT, y, TABLE_WIDTH, headingHeight, title.toLocaleUpperCase("fr-FR"), true, "center"); y -= headingHeight;
        drawCell(LEFT, y, refWidth, 20, labels[0] || "REF", true, "center"); drawCell(LEFT + refWidth, y, titleWidth, 20, labels[1] || "DÉSIGNATION", true, "center"); drawCell(LEFT + refWidth + titleWidth, y, amountWidth, 20, labels[2] || "MONTANT (Ar)", true, "center"); y -= 20;
      }
      // Récapitulatif lisible au premier coup d'œil : lignes en GRAS et MAJUSCULES.
      drawCell(LEFT, y, refWidth, 22, (entry.reference || "").toLocaleUpperCase("fr-FR"), true, "center");
      drawCell(LEFT + refWidth, y, titleWidth, 22, cleanText(entry.title).toLocaleUpperCase("fr-FR"), true);
      drawCell(LEFT + refWidth + titleWidth, y, amountWidth, 22, money(entry.total), true, "right");
      y -= 22;
    }
    if (showTotal) {
      const total = entries.reduce((sum, entry) => sum + entry.total, 0);
      // Total général : gras et plus grand que le reste.
      drawCell(LEFT, y, refWidth + titleWidth, 30, (template?.total_label || `TOTAL ${title}`).toLocaleUpperCase("fr-FR"), true, "right", 11);
      drawCell(LEFT + refWidth + titleWidth, y, amountWidth, 30, money(total), true, "right", 11);
      y -= 30;
      for (const extra of showExtras ? (input.extraTotals ?? []) : []) {
        drawCell(LEFT, y, refWidth + titleWidth, 22, cleanText(extra.label).toLocaleUpperCase("fr-FR"), true, "right");
        drawCell(LEFT + refWidth + titleWidth, y, amountWidth, 22, money(extra.amount), true, "right");
        y -= 22;
      }
      y -= 14;
    } else y -= 16;
    if (withSignature) {
      addText("Arrêté le présent bordereau détail quantitatif et estimatif à la somme de :", LEFT, y, 9); y -= 14;
      // Somme en toutes lettres (total de la récapitulation) ; à défaut de
      // montant, la ligne de points à remplir à la main.
      const sumWords = entries.reduce((sum, entry) => sum + entry.total, 0) > 0 ? `${amountInWordsFr(entries.reduce((sum, entry) => sum + entry.total, 0))}.` : "";
      if (sumWords) { wrapText(sumWords, TABLE_WIDTH * 0.88, 9).forEach((part) => { addText(part, LEFT, y, 9, true); y -= 12; }); y -= 4; }
      else { addText("................................................................................................................................", LEFT, y, 9); y -= 16; }
      addText("Fait à, ........................................ le ........................................", LEFT, y, 9); y -= 28;
      addText("Le Soumissionnaire", LEFT, y, 10, true); y -= 44;
      // Observations / notes du DAO : on retire celles que le PDF écrit déjà lui-même avec le vrai montant
      // (« Arrêté le présent bordereau… : ... (Montant en chiffres et en lettres) », « Fait à… », « Le Soumissionnaire »).
      const annotations = (input.bdqeLayout?.annotations ?? [])
        .map((annotation) => cleanText(annotation).replace(/arr[êe]t[ée]e?\s+le\s+pr[ée]sent[\s\S]*$/i, "").trim())
        .filter((annotation) => annotation && !/^fait\s+[àa]\b|^le\s+soumissionnaire\b/i.test(annotation));
      annotations.slice(0, 8).flatMap((annotation) => wrapText(annotation, TABLE_WIDTH, 8)).forEach((part) => { addText(part, LEFT, y, 8); y -= 11; });
    }
  };

  newPage();
  for (const row of input.rows) {
    if (row.kind === "section") {
      const hasNumber = Boolean(cleanText(row.number));
      const titleX = hasNumber ? columnX(1) + 5 : LEFT + 6;
      const sectionLines = wrapText(row.title.toLocaleUpperCase("fr-FR"), (TABLE_WIDTH - (titleX - LEFT) - 10) * 0.78, 9.5).slice(0, 2);
      const height = 22 + (sectionLines.length - 1) * 11;
      ensureSpace(height + 4);
      const top = y + 5; const bottom = y - height + 5;
      page.fills.push({ x: LEFT, y: bottom, width: TABLE_WIDTH, height, gray: 0.86, rgb: SECTION_FILL });
      if (hasNumber) addColumnText(cleanText(row.number), 0, y - 11, "center", 8.5, true);
      sectionLines.forEach((part, index) => addText(part, titleX, y - 11 - index * 11, 9.5, true));
      // cadre de la ligne de section (un seul trait vertical après le N°)
      page.lines.push({ x1: LEFT, y1: top, x2: LEFT, y2: bottom, width: 0.5 }, { x1: PAGE_WIDTH - RIGHT, y1: top, x2: PAGE_WIDTH - RIGHT, y2: bottom, width: 0.5 });
      if (hasNumber) page.lines.push({ x1: columnX(1), y1: top, x2: columnX(1), y2: bottom, width: 0.5 });
      page.lines.push({ x1: LEFT, y1: top, x2: PAGE_WIDTH - RIGHT, y2: top, width: 0.5 }, { x1: LEFT, y1: bottom, x2: PAGE_WIDTH - RIGHT, y2: bottom, width: 0.5 });
      y -= height; continue;
    }
    if (row.kind === "subsection") {
      // Sous-titre d'une rubrique (texte descriptif en gras, fond gris clair, sans numéro).
      const textX = columnX(1) + 5;
      const subLines = wrapText(row.title, (TABLE_WIDTH - (textX - LEFT) - 10) * 0.85, 8.2).slice(0, 4);
      const height = 12 + subLines.length * 10;
      ensureSpace(height + 4);
      const top = y + 5; const bottom = y - height + 5;
      page.fills.push({ x: LEFT, y: bottom, width: TABLE_WIDTH, height, gray: 0.94 });
      subLines.forEach((part, index) => addText(part, textX, y - 9 - index * 10, 8.2, true));
      page.lines.push({ x1: LEFT, y1: top, x2: LEFT, y2: bottom, width: 0.5 }, { x1: PAGE_WIDTH - RIGHT, y1: top, x2: PAGE_WIDTH - RIGHT, y2: bottom, width: 0.5 }, { x1: columnX(1), y1: top, x2: columnX(1), y2: bottom, width: 0.5 });
      page.lines.push({ x1: LEFT, y1: top, x2: PAGE_WIDTH - RIGHT, y2: top, width: 0.5 }, { x1: LEFT, y1: bottom, x2: PAGE_WIDTH - RIGHT, y2: bottom, width: 0.5 });
      y -= height; continue;
    }
    if (row.kind === "subtotal") {
      // « TOTAL <rubrique> » aligné à droite, montant dans la dernière colonne (comme le bordereau d'origine).
      const labelWidth = TABLE_WIDTH - COLUMN_WIDTHS[5] - 14;
      const subtotalLines = wrapText(`TOTAL ${row.title.toLocaleUpperCase("fr-FR")}`, labelWidth * 0.85, 8.2).slice(0, 2);
      const height = 20 + (subtotalLines.length - 1) * 9;
      ensureSpace(height + 3);
      const top = y + 5; const bottom = y - height + 5;
      subtotalLines.forEach((part, index) => addText(part, LEFT + TABLE_WIDTH - COLUMN_WIDTHS[5] - 8 - textWidth(part, 8.2, true), y - 9 - index * 9, 8.2, true));
      addColumnText(amountCell(row.total), 5, y - 9, "right", 8.2, true);
      page.lines.push({ x1: LEFT, y1: top, x2: LEFT, y2: bottom, width: 0.5 }, { x1: PAGE_WIDTH - RIGHT, y1: top, x2: PAGE_WIDTH - RIGHT, y2: bottom, width: 0.5 }, { x1: columnX(5), y1: top, x2: columnX(5), y2: bottom, width: 0.5 });
      page.lines.push({ x1: LEFT, y1: top, x2: PAGE_WIDTH - RIGHT, y2: top, width: 0.5 }, { x1: LEFT, y1: bottom, x2: PAGE_WIDTH - RIGHT, y2: bottom, width: 0.5 });
      y -= height; continue;
    }
    const designationLines = wrapText(row.designation, COLUMN_WIDTHS[1] - 10, 8);
    const concerneLines = cleanText(row.concerne) ? wrapText(`Concerne : ${cleanText(row.concerne)}`, COLUMN_WIDTHS[1] - 10, 8) : [];
    const textLines = [...designationLines, ...concerneLines];
    const height = Math.max(22, textLines.length * 10 + 10 + (concerneLines.length ? 3 : 0)); ensureSpace(height);
    const top = y + 5; const bottom = y - height + 5;
    // Numéro, unité, quantité, prix et montant : centrés ou alignés à droite, au milieu de la ligne.
    const middle = (top + bottom) / 2 - 2.6;
    addColumnText(cleanText(row.number), 0, middle, "center");
    addColumnText(cleanText(row.unit), 2, middle, "center");
    addColumnText(quantity(row.quantity), 3, middle, "right");
    addColumnText(amountCell(row.unitPrice), 4, middle, "right");
    addColumnText(amountCell(row.total), 5, middle, "right");
    designationLines.forEach((line, index) => addText(line, columnX(1) + 5, y - 9 - index * 10, 8));
    concerneLines.forEach((line, index) => addText(line, columnX(1) + 5, y - 9 - (designationLines.length + index) * 10 - 3, 8, true));
    drawGrid(top, bottom);
    y -= height;
  }
  ensureSpace(34);
  {
    const top = y + 5; const bottom = y - 23;
    page.fills.push({ x: LEFT, y: bottom, width: TABLE_WIDTH, height: 28, gray: 0.88 });
    addText("TOTAL GÉNÉRAL DU DEVIS", columnX(1) + 5, y - 12, 10, true);
    addColumnText(amountCell(input.grandTotal), 5, y - 12, "right", 10, true);
    page.lines.push({ x1: LEFT, y1: top, x2: PAGE_WIDTH - RIGHT, y2: top, width: 0.8 }, { x1: LEFT, y1: bottom, x2: PAGE_WIDTH - RIGHT, y2: bottom, width: 0.8 }, { x1: LEFT, y1: top, x2: LEFT, y2: bottom, width: 0.8 }, { x1: PAGE_WIDTH - RIGHT, y1: top, x2: PAGE_WIDTH - RIGHT, y2: bottom, width: 0.8 }, { x1: columnX(5), y1: top, x2: columnX(5), y2: bottom, width: 0.8 });
    y -= 28;
    for (const extra of input.extraTotals ?? []) {
      ensureSpace(30);
      const extraTop = y + 5; const extraBottom = y - 19;
      addText(cleanText(extra.label).toLocaleUpperCase("fr-FR"), columnX(1) + 5, y - 9, 9, true);
      addColumnText(amountCell(extra.amount), 5, y - 9, "right", 9, true);
      page.lines.push({ x1: LEFT, y1: extraTop, x2: PAGE_WIDTH - RIGHT, y2: extraTop, width: 0.6 }, { x1: LEFT, y1: extraBottom, x2: PAGE_WIDTH - RIGHT, y2: extraBottom, width: 0.6 }, { x1: LEFT, y1: extraTop, x2: LEFT, y2: extraBottom, width: 0.6 }, { x1: PAGE_WIDTH - RIGHT, y1: extraTop, x2: PAGE_WIDTH - RIGHT, y2: extraBottom, width: 0.6 }, { x1: columnX(5), y1: extraTop, x2: columnX(5), y2: extraBottom, width: 0.6 });
      y -= 24;
    }
  }

  // Les rubriques de récapitulation viennent du DAO et sont séparées du
  // détail du bordereau. Elles figurent dans les deux devis ; la page globale
  // avec signature ne figure que dans la version externe à soumettre.
  // Un récapitulatif à 0 Ar n'apporte rien : les lignes à 0 sont retirées, et une page
  // dont tout est à 0 n'est pas imprimée (ni dans le récapitulatif général).
  const positiveGroups = (input.recapGroups ?? [])
    .map((group) => ({ ...group, entries: group.entries.filter((entry) => Number(entry.total) > 0) }))
    .filter((group) => group.entries.length > 0);
  for (const group of positiveGroups) {
    const extractedTitle = (input.bdqeLayout?.recap_tables ?? []).find((item) => cleanText(item.reference) === cleanText(group.reference))?.title;
    recapPage(extractedTitle || `Récapitulation ${group.title}`, group.entries, false, true, group.reference || "", true);
  }
  if ((input.internalFinancialSummary?.length ?? 0) > 0) {
    recapPage("Synthèse financière interne", input.internalFinancialSummary!.map((entry) => ({ title: entry.title, total: entry.total })), false, false);
  }
  if (input.includeExternalRecap && positiveGroups.length > 0) {
    const generalTitle = (input.bdqeLayout?.recap_tables ?? []).find((item) => /récapitulation générale|recapitulation generale/i.test(cleanText(item.title)))?.title || "Récapitulation générale";
    recapPage(generalTitle, positiveGroups.map((group, index) => ({ reference: group.reference || String.fromCharCode(65 + index), title: group.title, total: group.entries.reduce((sum, entry) => sum + entry.total, 0) })), true);
  }

  // Numéros de page « Page X de Y » en bas de chaque page (comme le PDF des devis PDF).
  pages.forEach((commands, index) => {
    const label = `Page ${index + 1} de ${pages.length}`;
    commands.draw.push({ text: label, x: (PAGE_WIDTH - textWidth(label, 7)) / 2, y: 20, size: 7, bold: false });
  });

  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const pageObjectNumbers = pages.map((_, index) => 5 + index * 2);
  objects.push(`<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((commands, index) => {
    const pageNumber = 5 + index * 2; const streamNumber = pageNumber + 1; const stream = pageStream(commands);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamNumber} 0 R >>`);
    objects.push(`<< /Length ${binaryBytes(stream).length} >>\nstream\n${stream}\nendstream`);
  });
  let pdf = "%PDF-1.4\n%âãÏÓ\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(binaryBytes(pdf).length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xrefOffset = binaryBytes(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return binaryBytes(pdf);
}
