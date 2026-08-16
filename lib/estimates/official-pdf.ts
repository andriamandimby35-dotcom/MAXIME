export type OfficialPdfRow =
  | { kind: "section"; title: string }
  | { kind: "item"; number: string; designation: string; unit: string; quantity: number; unitPrice: number; total: number }
  | { kind: "subtotal"; title: string; total: number };

export type OfficialPdfInput = {
  companyName: string;
  companyDetails: string[];
  daoTitle: string;
  daoReference?: string;
  clientName?: string;
  estimateDate: string;
  rows: OfficialPdfRow[];
  grandTotal: number;
};

const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const LEFT = 34;
const RIGHT = 34;
const TOP = 30;
const BOTTOM = 30;
const TABLE_WIDTH = PAGE_WIDTH - LEFT - RIGHT;
const COLUMN_WIDTHS = [42, 420, 54, 70, 88, 99];

type DrawCommand = { text: string; x: number; y: number; size: number; bold?: boolean };
type LineCommand = { x1: number; y1: number; x2: number; y2: number; width?: number };
type FillCommand = { x: number; y: number; width: number; height: number; gray: number };
type PageCommands = { draw: DrawCommand[]; lines: LineCommand[]; fills: FillCommand[] };

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function pdfText(value: string) {
  return cleanText(value)
    .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
    .replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/œ/g, "oe").replace(/Œ/g, "OE")
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
    commands.push(`${fill.gray} g ${fill.x.toFixed(2)} ${fill.y.toFixed(2)} ${fill.width.toFixed(2)} ${fill.height.toFixed(2)} re f`, "0 g");
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
  const drawTableHeader = () => {
    const height = 22;
    page.fills.push({ x: LEFT, y: y - height + 5, width: TABLE_WIDTH, height, gray: 0.9 });
    const labels = ["N°", "DÉSIGNATION", "UNITÉ", "QUANTITÉ", "PRIX UNITAIRE", "TOTAL"];
    let x = LEFT;
    labels.forEach((label, index) => { addText(label, x + 4, y - 9, 7.2, true); x += COLUMN_WIDTHS[index]; });
    y -= height;
  };
  const newPage = () => {
    page = { draw: [], lines: [], fills: [] }; pages.push(page); y = PAGE_HEIGHT - TOP;
    addText(input.companyName, LEFT, y, 15, true);
    addText("DEVIS OFFICIEL - DAO", PAGE_WIDTH - RIGHT - 180, y, 13, true); y -= 18;
    for (const detail of input.companyDetails.slice(0, 3)) { addText(detail, LEFT, y, 7.5); y -= 10; }
    addText(`DAO : ${input.daoTitle}`, LEFT + 330, PAGE_HEIGHT - TOP - 20, 9, true);
    if (input.daoReference) addText(`Référence : ${input.daoReference}`, LEFT + 330, PAGE_HEIGHT - TOP - 32, 8);
    if (input.clientName) addText(`Client : ${input.clientName}`, LEFT + 520, PAGE_HEIGHT - TOP - 32, 8);
    addText(`Date : ${input.estimateDate}`, LEFT + 520, PAGE_HEIGHT - TOP - 44, 8);
    y = PAGE_HEIGHT - TOP - 58;
    page.lines.push({ x1: LEFT, y1: y, x2: PAGE_WIDTH - RIGHT, y2: y, width: 1 }); y -= 22;
    drawTableHeader();
  };
  const ensureSpace = (height: number) => { if (y - height < BOTTOM + 18) newPage(); };
  const horizontalLine = (baseline: number, width = 0.35) => page.lines.push({ x1: LEFT, y1: baseline, x2: PAGE_WIDTH - RIGHT, y2: baseline, width });

  newPage();
  for (const row of input.rows) {
    if (row.kind === "section") {
      ensureSpace(30); const height = 26;
      page.fills.push({ x: LEFT, y: y - height + 5, width: TABLE_WIDTH, height, gray: 0.86 });
      addText(row.title.toLocaleUpperCase("fr-FR"), LEFT + 6, y - 11, 9.5, true);
      horizontalLine(y - height + 5, 0.8); y -= height; continue;
    }
    if (row.kind === "subtotal") {
      ensureSpace(27); const height = 24;
      page.fills.push({ x: LEFT, y: y - height + 5, width: TABLE_WIDTH, height, gray: 0.94 });
      addText(`SOUS-TOTAL ${row.title}`, LEFT + COLUMN_WIDTHS[0] + 5, y - 10, 8.2, true);
      addText(money(row.total), LEFT + TABLE_WIDTH - COLUMN_WIDTHS[5] + 4, y - 10, 8.2, true);
      horizontalLine(y - height + 5, 0.6); y -= height; continue;
    }
    const designationLines = wrapText(row.designation, COLUMN_WIDTHS[1] - 10, 8);
    const height = Math.max(25, designationLines.length * 10 + 12); ensureSpace(height);
    const values = [row.number, "", row.unit, quantity(row.quantity), money(row.unitPrice), money(row.total)];
    let x = LEFT;
    values.forEach((value, index) => { if (index !== 1) addText(value, x + 4, y - 10, 7.6); x += COLUMN_WIDTHS[index]; });
    designationLines.forEach((line, index) => addText(line, LEFT + COLUMN_WIDTHS[0] + 5, y - 10 - index * 10, 8));
    horizontalLine(y - height + 5); y -= height;
  }
  ensureSpace(34);
  page.fills.push({ x: LEFT, y: y - 23, width: TABLE_WIDTH, height: 28, gray: 0.82 });
  addText("TOTAL GÉNÉRAL DU DEVIS", LEFT + COLUMN_WIDTHS[0] + 5, y - 12, 10, true);
  addText(money(input.grandTotal), LEFT + TABLE_WIDTH - COLUMN_WIDTHS[5] + 4, y - 12, 10, true);
  horizontalLine(y - 23, 1);

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
