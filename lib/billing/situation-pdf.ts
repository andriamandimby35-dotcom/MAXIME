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
};

const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const LEFT = 30;
const RIGHT = 30;
const TOP = 30;
const BOTTOM = 30;
const TABLE_WIDTH = PAGE_WIDTH - LEFT - RIGHT; // 781.89
const COLUMN_WIDTHS = [24, 206, 38, 58, 78, 66, 88, 88, 135.89]; // somme = TABLE_WIDTH

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
  const headerLabels = ["N°", "DÉSIGNATION", "UNITÉ", "QTÉ MARCHÉ", "PRIX UNITAIRE", "QTÉ RÉALISÉE", "MONTANT CUMULÉ", "DÉJÀ FACTURÉ", "À FACTURER"];
  const drawTableHeader = () => {
    const height = 24;
    page.fills.push({ x: LEFT, y: y - height + 5, width: TABLE_WIDTH, height, gray: 0.9 });
    let x = LEFT;
    headerLabels.forEach((label, index) => {
      wrapText(label, COLUMN_WIDTHS[index] - 6, 6.4).forEach((line, lineIndex) => addText(line, x + 3, y - 10 - lineIndex * 8, 6.4, true));
      x += COLUMN_WIDTHS[index];
    });
    y -= height;
  };
  const newPage = () => {
    page = { draw: [], lines: [], fills: [] }; pages.push(page); y = PAGE_HEIGHT - TOP;
    addText(input.companyName, LEFT, y, 15, true);
    addText(`FACTURE N° ${input.claimNumber}`, PAGE_WIDTH - RIGHT - 330, y, 12, true); y -= 18;
    for (const detail of input.companyDetails.slice(0, 3)) { addText(detail, LEFT, y, 7.5); y -= 10; }

    const leftDetails = [`Chantier : ${input.projectName}`];
    if (input.clientName) leftDetails.push(`Client : ${input.clientName}`);
    if (input.projectLocation) leftDetails.push(`Localisation : ${input.projectLocation}`);
    if (input.daoReference) leftDetails.push(`Référence DAO : ${input.daoReference}`);
    const rightDetails = [`Date d'émission : ${input.issueDate}`];
    if (input.periodLabel) rightDetails.push(`Période : ${input.periodLabel}`);
    leftDetails.forEach((text, index) => addText(text, LEFT + 330, PAGE_HEIGHT - TOP - 20 - index * 12, index === 0 ? 9 : 8, index === 0));
    rightDetails.forEach((text, index) => addText(text, LEFT + 560, PAGE_HEIGHT - TOP - 20 - index * 12, 8));

    const headerLines = Math.max(leftDetails.length, rightDetails.length);
    y = PAGE_HEIGHT - TOP - 20 - (headerLines - 1) * 12 - 14;
    page.lines.push({ x1: LEFT, y1: y, x2: PAGE_WIDTH - RIGHT, y2: y, width: 1 }); y -= 16;
    drawTableHeader();
  };
  const ensureSpace = (height: number) => { if (y - height < BOTTOM + 130) newPage(); };
  const horizontalLine = (baseline: number, width = 0.35) => page.lines.push({ x1: LEFT, y1: baseline, x2: PAGE_WIDTH - RIGHT, y2: baseline, width });

  newPage();
  let sectionShown = false;
  for (const line of input.lines) {
    if (line.kind === "depense" && !sectionShown) {
      sectionShown = true;
      ensureSpace(24);
      const height = 20;
      page.fills.push({ x: LEFT, y: y - height + 5, width: TABLE_WIDTH, height, gray: 0.86 });
      addText("DÉPENSES DIVERSES", LEFT + 6, y - 10, 8.5, true);
      horizontalLine(y - height + 5, 0.6); y -= height;
    }
    const designationLines = wrapText(line.designation, COLUMN_WIDTHS[1] - 6, 7.4);
    const height = Math.max(22, designationLines.length * 9 + 10);
    ensureSpace(height);
    const values = [
      String(line.position), "", line.unit, qty(line.contractQuantity),
      line.unitPrice === null ? "—" : money(line.unitPrice),
      qty(line.currentQuantity), money(line.currentAmount), money(line.previousAmount), money(line.amountThisTime),
    ];
    let x = LEFT;
    values.forEach((value, index) => { if (index !== 1) addText(value, x + 3, y - 10, 7, false); x += COLUMN_WIDTHS[index]; });
    designationLines.forEach((text, index) => addText(text, LEFT + COLUMN_WIDTHS[0] + 3, y - 10 - index * 9, 7.4));
    horizontalLine(y - height + 4, 0.4);
    y -= height;
  }

  ensureSpace(30);
  const totalHeight = 22;
  page.fills.push({ x: LEFT, y: y - totalHeight + 5, width: TABLE_WIDTH, height: totalHeight, gray: 0.82 });
  addText("TOTAL À FACTURER SUR CETTE FACTURE", LEFT + COLUMN_WIDTHS[0] + 5, y - 12, 9, true);
  addText(money(input.grossAmount), LEFT + TABLE_WIDTH - COLUMN_WIDTHS[8] + 4, y - 12, 9, true);
  horizontalLine(y - totalHeight + 5, 1); y -= totalHeight + 16;

  const summaryRows: Array<[string, string, boolean]> = [
    ["Montant brut de cette situation", money(input.grossAmount), false],
    [`Retenue de garantie (${input.retentionRate.toFixed(1)} %)`, `- ${money(input.retentionAmount)}`, false],
    ...(input.advanceRepayment > 0 ? [["Remboursement d'avance", `- ${money(input.advanceRepayment)}`, false] as [string, string, boolean]] : []),
    ...(input.otherDeductions > 0 ? [["Autres déductions", `- ${money(input.otherDeductions)}`, false] as [string, string, boolean]] : []),
    [`Taxe de l'État (${input.taxRate.toFixed(1)} %)`, `+ ${money(input.taxAmount)}`, false],
    ["NET À PAYER SUR CETTE FACTURE", money(input.netAmount), true],
  ];
  ensureSpace(summaryRows.length * 20 + 20);
  const labelX = PAGE_WIDTH - RIGHT - 320;
  const valueX = PAGE_WIDTH - RIGHT - 130;
  summaryRows.forEach(([label, value, bold]) => {
    if (bold) page.fills.push({ x: labelX - 6, y: y - 16, width: 326, height: 22, gray: 0.85 });
    addText(label, labelX, y - (bold ? 11 : 8), bold ? 10 : 8.5, bold);
    addText(value, valueX, y - (bold ? 11 : 8), bold ? 10 : 8.5, bold);
    y -= bold ? 24 : 14;
  });

  if (input.legalMentions && input.legalMentions.length > 0) {
    ensureSpace(input.legalMentions.length * 11 + 16);
    horizontalLine(y, 0.3); y -= 12;
    for (const mention of input.legalMentions) {
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
