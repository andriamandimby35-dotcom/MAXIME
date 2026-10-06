import { amountInWordsFr } from "@/lib/number-to-words-fr";

// Générateur du PDF "Situation de travaux" (facture d'avancement), avec la
// même technique bas niveau que le PDF de devis (lib/estimates/official-pdf.ts)
// mais un tableau plus simple, propre à cette situation. Ce fichier est
// volontairement indépendant (aucune dépendance croisée) pour ne jamais
// risquer de perturber la génération des devis en modifiant ce fichier-ci.

export type SituationPdfLine = {
  kind: "devis" | "depense";
  position: number;
  designation: string;
  unit: string;
  contractQuantity: number | null;
  unitPrice: number | null;
  previousQuantity: number;
  currentQuantity: number;
  previousAmount: number;
  currentAmount: number;
  amountThisTime: number;
  /** Titre de catégorie et de sous-catégorie du devis (facultatifs). */
  category?: string;
  subcategory?: string;
};

export type SituationPdfInput = {
  companyName: string;
  companyDetails: string[];
  claimNumber: string;
  issueDate: string;
  periodLabel?: string;
  projectName: string;
  projectLocation?: string;
  daoReference?: string;
  clientName?: string;
  legalMentions?: string[];
  lines: SituationPdfLine[];
  grossAmount: number;
  retentionRate: number;
  retentionAmount: number;
  advanceRepayment: number;
  otherDeductions: number;
  taxRate: number;
  taxAmount: number;
  netAmount: number;
  /** Anciennes factures seulement : la taxe s'ajoutait au total au lieu d'être déduite. */
  taxAdded?: boolean;
};

// Format A4 PORTRAIT, toujours (règle de l'application : tout PDF à imprimer
// est en portrait).
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const LEFT = 30;
const RIGHT = 30;
const TOP = 30;
const BOTTOM = 30;
const TABLE_WIDTH = PAGE_WIDTH - LEFT - RIGHT; // 535.28
const COLUMN_WIDTHS = [18, 132, 28, 36, 52, 36, 36, 62, 62, 73.28]; // somme = TABLE_WIDTH

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}
function repairMojibake(value: string) {
  let repaired = value;
  for (let pass = 0; pass < 2 && /[ÃÂâ]/.test(repaired); pass += 1) {
    const candidate = Buffer.from(repaired, "latin1").toString("utf8");
    if (candidate === repaired || candidate.includes("�")) break;
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
    .replace(/[^\x20-\x7e -ÿ]/g, "?");
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
function qty(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3 }).format(Number(value) || 0);
}
// Avancement d'une ligne du devis, en % : quantité réalisée / quantité du
// marché (cette quantité réalisée vient elle-même de l'avancement du planning).
// Les lignes de dépenses (sans quantité de marché) n'ont pas d'avancement.
function progressLabel(line: SituationPdfLine) {
  if (line.kind !== "devis" || !line.contractQuantity || line.contractQuantity <= 0) return "—";
  const percent = Math.max(0, Math.min(100, (line.currentQuantity / line.contractQuantity) * 100));
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(percent)} %`;
}
function binaryBytes(value: string) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}

type DrawCommand = { text: string; x: number; y: number; size: number; bold?: boolean };
type LineCommand = { x1: number; y1: number; x2: number; y2: number; width?: number };
type FillCommand = { x: number; y: number; width: number; height: number; gray: number };
type PageCommands = { draw: DrawCommand[]; lines: LineCommand[]; fills: FillCommand[] };

function pageStream(page: PageCommands) {
  const commands: string[] = ["0 G", "0 g"];
  for (const fill of page.fills) commands.push(`${fill.gray} g ${fill.x.toFixed(2)} ${fill.y.toFixed(2)} ${fill.width.toFixed(2)} ${fill.height.toFixed(2)} re f`, "0 g");
  for (const line of page.lines) commands.push(`${(line.width ?? 0.5).toFixed(2)} w ${line.x1.toFixed(2)} ${line.y1.toFixed(2)} m ${line.x2.toFixed(2)} ${line.y2.toFixed(2)} l S`);
  for (const item of page.draw) commands.push(`BT /${item.bold ? "F2" : "F1"} ${item.size.toFixed(2)} Tf ${item.x.toFixed(2)} ${item.y.toFixed(2)} Td (${pdfText(item.text)}) Tj ET`);
  return commands.join("\n");
}

export function generateProgressClaimPdf(input: SituationPdfInput) {
  const pages: PageCommands[] = [];
  let page: PageCommands = { draw: [], lines: [], fills: [] };
  let y = 0;
  const addText = (text: string, x: number, baseline: number, size = 9, bold = false) => page.draw.push({ text, x, y: baseline, size, bold });
  const headerLabels = ["N°", "DÉSIGNATION", "UNITÉ", "QTÉ MARCHÉ", "PRIX UNITAIRE", "QTÉ RÉALISÉE", "AVANC.", "MONTANT CUMULÉ", "DÉJÀ FACTURÉ", "À FACTURER"];
  const drawTableHeader = () => {
    const height = 24;
    page.fills.push({ x: LEFT, y: y - height + 5, width: TABLE_WIDTH, height, gray: 0.9 });
    let x = LEFT;
    headerLabels.forEach((label, index) => {
      wrapText(label, COLUMN_WIDTHS[index] - 12, 7.6).forEach((line, lineIndex) => addText(line, x + 3, y - 10 - lineIndex * 8, 6.4, true));
      x += COLUMN_WIDTHS[index];
    });
    y -= height;
  };
  const newPage = () => {
    page = { draw: [], lines: [], fills: [] }; pages.push(page); y = PAGE_HEIGHT - TOP;
    // En-tête portrait : la société à gauche, la facture et le chantier à droite
    // (les textes longs passent à la ligne, jamais l'un sous l'autre).
    const RIGHT_X = LEFT + 300;
    const RIGHT_WIDTH = PAGE_WIDTH - RIGHT - RIGHT_X;
    const top = y;
    let leftY = top;
    wrapText(input.companyName, 270, 15).slice(0, 2).forEach((part) => { addText(part, LEFT, leftY, 15, true); leftY -= 17; });
    for (const detail of input.companyDetails.slice(0, 3)) {
      wrapText(detail, 270, 7.5).slice(0, 2).forEach((part) => { addText(part, LEFT, leftY, 7.5); leftY -= 9.5; });
    }

    let rightY = top;
    addText(`FACTURE N° ${input.claimNumber}`, RIGHT_X, rightY, 12, true); rightY -= 17;
    const rightRows: Array<{ text: string; bold: boolean; size: number }> = [];
    const detailTexts = [`Chantier : ${input.projectName}`];
    if (input.clientName) detailTexts.push(`Client : ${input.clientName}`);
    if (input.projectLocation) detailTexts.push(`Localisation : ${input.projectLocation}`);
    if (input.daoReference) detailTexts.push(`Référence DAO : ${input.daoReference}`);
    detailTexts.forEach((text, index) => {
      const size = index === 0 ? 9 : 8;
      wrapText(text, RIGHT_WIDTH, size).slice(0, index === 0 ? 3 : 2).forEach((part) => rightRows.push({ text: part, bold: index === 0, size }));
    });
    rightRows.push({ text: `Date d'émission : ${input.issueDate}`, bold: false, size: 8 });
    if (input.periodLabel) rightRows.push({ text: `Période : ${input.periodLabel}`, bold: false, size: 8 });
    rightRows.forEach((row) => { addText(row.text, RIGHT_X, rightY, row.size, row.bold); rightY -= 11; });

    y = Math.min(leftY, rightY) - 4;
    page.lines.push({ x1: LEFT, y1: y, x2: PAGE_WIDTH - RIGHT, y2: y, width: 1 }); y -= 16;
    drawTableHeader();
  };
  const ensureSpace = (height: number) => { if (y - height < BOTTOM + 130) newPage(); };
  const horizontalLine = (baseline: number, width = 0.35) => page.lines.push({ x1: LEFT, y1: baseline, x2: PAGE_WIDTH - RIGHT, y2: baseline, width });

  newPage();
  let sectionShown = false;
  // Catégories et sous-catégories du devis : on les reprend ici comme sur le
  // devis (titre, lignes, sous-total avec avancement en %). Les lignes sans
  // catégorie (anciennes factures, dépenses diverses) restent à plat.
  type Acc = { title: string; current: number; previous: number; thisTime: number; contract: number };
  const newAcc = (title: string): Acc => ({ title, current: 0, previous: 0, thisTime: 0, contract: 0 });
  const columnX = (index: number) => LEFT + COLUMN_WIDTHS.slice(0, index).reduce((sum, width) => sum + width, 0);
  let currentCategory = "";
  let currentSubcategory = "";
  let categoryAcc: Acc | null = null;
  let subcategoryAcc: Acc | null = null;

  const drawHeading = (title: string, level: 1 | 2) => {
    const titleLines = wrapText(title, (TABLE_WIDTH - 30) * 0.8, level === 1 ? 8.5 : 7.8).slice(0, 2);
    const height = (level === 1 ? 20 : 17) + (titleLines.length - 1) * 9;
    ensureSpace(height + 34);
    page.fills.push({ x: LEFT, y: y - height + 5, width: TABLE_WIDTH, height, gray: level === 1 ? 0.86 : 0.94 });
    titleLines.forEach((text, index) => addText(text, LEFT + (level === 1 ? 6 : 16), y - 10 - index * 9, level === 1 ? 8.5 : 7.8, true));
    horizontalLine(y - height + 5, level === 1 ? 0.6 : 0.4);
    y -= height;
  };
  const drawSubtotal = (acc: Acc, label: string, level: 1 | 2) => {
    const height = 19;
    ensureSpace(height);
    page.fills.push({ x: LEFT, y: y - height + 5, width: TABLE_WIDTH, height, gray: level === 1 ? 0.88 : 0.95 });
    const text = `${label} ${acc.title}`;
    wrapText(text, (COLUMN_WIDTHS[1] + COLUMN_WIDTHS[2] + COLUMN_WIDTHS[3] + COLUMN_WIDTHS[4] + COLUMN_WIDTHS[5] - 8) * 0.85, 7).slice(0, 1)
      .forEach((line) => addText(line, LEFT + COLUMN_WIDTHS[0] + 3, y - 10, 7, true));
    const percent = acc.contract > 0 ? Math.max(0, Math.min(100, (acc.current / acc.contract) * 100)) : null;
    addText(percent === null ? "—" : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(percent)} %`, columnX(6) + 2, y - 10, 6.8, true);
    addText(money(acc.current), columnX(7) + 2, y - 10, 6.8, true);
    addText(money(acc.previous), columnX(8) + 2, y - 10, 6.8, true);
    addText(money(acc.thisTime), columnX(9) + 2, y - 10, 6.8, true);
    horizontalLine(y - height + 5, level === 1 ? 0.6 : 0.4);
    y -= height;
  };
  const closeSubcategory = () => {
    if (subcategoryAcc) drawSubtotal(subcategoryAcc, "Sous-total", 2);
    subcategoryAcc = null;
    currentSubcategory = "";
  };
  const closeCategory = () => {
    closeSubcategory();
    if (categoryAcc) drawSubtotal(categoryAcc, "Total", 1);
    categoryAcc = null;
    currentCategory = "";
  };

  for (const line of input.lines) {
    const category = cleanText(line.category);
    const subcategory = cleanText(line.subcategory);
    if (category || subcategory) {
      if (category && category !== currentCategory) {
        closeCategory();
        currentCategory = category;
        categoryAcc = newAcc(category);
        drawHeading(category, 1);
      }
      if (subcategory !== currentSubcategory) {
        closeSubcategory();
        if (subcategory) {
          currentSubcategory = subcategory;
          subcategoryAcc = newAcc(subcategory);
          drawHeading(subcategory, 2);
        }
      }
    } else if (currentCategory || currentSubcategory) {
      closeCategory();
    }

    if (line.kind === "depense" && !sectionShown && !category) {
      sectionShown = true;
      ensureSpace(24);
      const height = 20;
      page.fills.push({ x: LEFT, y: y - height + 5, width: TABLE_WIDTH, height, gray: 0.86 });
      addText(input.lines.some((l) => l.kind === "devis") ? "DÉPENSES DIVERSES" : "DÉTAIL DES TRAVAUX ET FOURNITURES", LEFT + 6, y - 10, 8.5, true);
      horizontalLine(y - height + 5, 0.6); y -= height;
    }
    const designationLines = wrapText(line.designation, COLUMN_WIDTHS[1] - 6, 7);
    const height = Math.max(22, designationLines.length * 9 + 10);
    ensureSpace(height);
    const values = [
      String(line.position), "", line.unit, qty(line.contractQuantity),
      line.unitPrice === null ? "—" : money(line.unitPrice),
      qty(line.currentQuantity), progressLabel(line), money(line.currentAmount), money(line.previousAmount), money(line.amountThisTime),
    ];
    let x = LEFT;
    values.forEach((value, index) => { if (index !== 1) addText(value, x + 2, y - 10, 6.6, false); x += COLUMN_WIDTHS[index]; });
    designationLines.forEach((text, index) => addText(text, LEFT + COLUMN_WIDTHS[0] + 3, y - 10 - index * 9, 7));
    horizontalLine(y - height + 4, 0.4);
    y -= height;

    const contractAmount = line.kind === "devis" && line.contractQuantity && line.unitPrice ? line.contractQuantity * line.unitPrice : 0;
    for (const acc of [categoryAcc, subcategoryAcc]) {
      if (!acc) continue;
      acc.current += line.currentAmount;
      acc.previous += line.previousAmount;
      acc.thisTime += line.amountThisTime;
      acc.contract += contractAmount;
    }
  }
  closeCategory();

  ensureSpace(30);
  const totalHeight = 22;
  page.fills.push({ x: LEFT, y: y - totalHeight + 5, width: TABLE_WIDTH, height: totalHeight, gray: 0.82 });
  addText("TOTAL À FACTURER SUR CETTE FACTURE", LEFT + COLUMN_WIDTHS[0] + 5, y - 12, 9, true);
  addText(money(input.grossAmount), LEFT + TABLE_WIDTH - COLUMN_WIDTHS[9] + 2, y - 12, 8.5, true);
  horizontalLine(y - totalHeight + 5, 1); y -= totalHeight + 16;

  // Retenue de garantie et taxe de l'État : lignes présentes seulement si
  // elles ont été mises sur la facture ; elles sont déduites du total (les
  // anciennes factures, où la taxe s'ajoutait, gardent leur « + »).
  const summaryRows: Array<[string, string, boolean]> = [
    ["Montant brut de cette situation", money(input.grossAmount), false],
    ...(input.retentionRate > 0 || input.retentionAmount > 0 ? [[`Retenue de garantie (${input.retentionRate.toFixed(1)} %)`, `- ${money(input.retentionAmount)}`, false] as [string, string, boolean]] : []),
    ...(input.advanceRepayment > 0 ? [["Remboursement d'avance", `- ${money(input.advanceRepayment)}`, false] as [string, string, boolean]] : []),
    ...(input.otherDeductions > 0 ? [["Autres déductions", `- ${money(input.otherDeductions)}`, false] as [string, string, boolean]] : []),
    ...(input.taxRate > 0 || input.taxAmount > 0 ? [[`Taxe de l'État (${input.taxRate.toFixed(1)} %)`, `${input.taxAdded ? "+" : "-"} ${money(input.taxAmount)}`, false] as [string, string, boolean]] : []),
    ["NET À PAYER SUR CETTE FACTURE", money(input.netAmount), true],
  ];
  ensureSpace(summaryRows.length * 20 + 20);
  const labelX = PAGE_WIDTH - RIGHT - 320;
  const valueX = PAGE_WIDTH - RIGHT - 130;
  summaryRows.forEach(([label, value, bold]) => {
    if (bold) y -= 5;
    if (bold) page.fills.push({ x: labelX - 6, y: y - 16, width: 326, height: 22, gray: 0.85 });
    addText(label, labelX, y - (bold ? 11 : 8), bold ? 10 : 8.5, bold);
    addText(value, valueX, y - (bold ? 11 : 8), bold ? 10 : 8.5, bold);
    y -= bold ? 24 : 14;
  });

  // Montant net en toutes lettres (arrêté de la facture).
  {
    const sentence = wrapText(`Arrêtée la présente facture à la somme de : ${amountInWordsFr(input.netAmount)}.`, TABLE_WIDTH * 0.88, 8.5);
    ensureSpace(sentence.length * 11 + 14);
    y -= 6;
    sentence.forEach((part) => { addText(part, LEFT, y, 8.5, true); y -= 11; });
    y -= 6;
  }

  if (input.legalMentions && input.legalMentions.length > 0) {
    const mentionLines = input.legalMentions.flatMap((mention) => wrapText(mention, TABLE_WIDTH, 7));
    ensureSpace(mentionLines.length * 10 + 16);
    horizontalLine(y, 0.3); y -= 12;
    for (const mention of mentionLines) {
      addText(mention, LEFT, y, 7, false);
      y -= 10;
    }
  }

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
