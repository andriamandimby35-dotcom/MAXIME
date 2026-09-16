/** Répare les anciennes chaînes UTF-8 lues comme du latin-1 (ex. ReprÃ©sentant). */
function repairMojibake(value: string) {
  let repaired = value;
  for (let pass = 0; pass < 2 && /[ÃÂâ]/.test(repaired); pass += 1) {
    const candidate = Buffer.from(repaired, "latin1").toString("utf8");
    if (candidate === repaired || candidate.includes("\uFFFD")) break;
    repaired = candidate;
  }
  return repaired;
}

function escapePdf(value: string) {
  return repairMojibake(value)
    .normalize("NFC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7e\u00a0-\u00ff]/g, "?");
}

function binaryLength(value: string) {
  return Buffer.byteLength(value, "latin1");
}

function wrapLine(value: string, maximum = 88) {
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

// Le DAO présente souvent plusieurs petits tableaux à la suite SUR LA MÊME
// page (ex. deux tableaux de chiffre d'affaires l'un sous l'autre) : les
// forcer chacun sur sa propre page ne ressemble plus du tout à l'original.
// On les empile donc avec un curseur Y commun, et on ne change de page que
// lorsqu'il n'y a vraiment plus la place.
function tableStreams(tables: PrintableTable[]) {
  const TOP_Y = 790;
  const BOTTOM_Y = 50;
  const ROW_HEIGHT = 19;
  const TITLE_GAP = 24;
  const TABLE_GAP = 16;
  const pages: string[][] = [[]];
  let y = TOP_Y;
  const newPage = () => { pages.push([]); y = TOP_Y; };
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
    const cell = (value: string, column: number, rowY: number) => {
      const width = widths[column];
      const x = 54 + offsets[column];
      const clipped = value.slice(0, Math.max(8, Math.floor(width / 5.2)));
      return `0.7 w ${x} ${rowY} ${width} ${ROW_HEIGHT} re S BT /F1 8 Tf ${x + 3} ${rowY + 6} Td (${escapePdf(clipped)}) Tj ET`;
    };
    if (y - (TITLE_GAP + ROW_HEIGHT) < BOTTOM_Y) newPage();
    pages[pages.length - 1].push(`BT /F1 12 Tf 54 ${y} Td (${escapePdf(table.title || "Tableau du DAO")}) Tj ET`);
    y -= TITLE_GAP;
    pages[pages.length - 1].push(...columns.map((column, index) => cell(column, index, y - ROW_HEIGHT)));
    y -= ROW_HEIGHT;
    for (const row of rows) {
      if (y - ROW_HEIGHT < BOTTOM_Y) newPage();
      pages[pages.length - 1].push(...columns.map((_, columnIndex) => cell(String(row[columnIndex] ?? ""), columnIndex, y - ROW_HEIGHT)));
      y -= ROW_HEIGHT;
    }
    y -= TABLE_GAP;
  }
  return pages.filter((ops) => ops.length).map((ops) => ops.join("\n"));
}

export function createPrintableSubmissionPdf(title: string, company: Record<string, unknown>, extraLines: string[] = [], tables: PrintableTable[] = []) {
  const lines = [
    title.toUpperCase(), "", `Entreprise : ${company.legal_name || company.trade_name || "À compléter"}`,
    `Représentant : ${company.representative_name || "À compléter"}`,
    `Fonction : ${company.representative_role || "À compléter"}`,
    `Adresse : ${company.address || "À compléter"}`, `NIF : ${company.nif || "À compléter"}   STAT : ${company.stat || "À compléter"}`,
    "", ...extraLines, "", "Document à lire, imprimer et signer ou parapher selon les exigences du DAO.",
    "", "Lieu et date : ________________________________", "", "Signature et cachet :", "", "", "_______________________________",
  ].flatMap((line) => wrapLine(line));
  const textStreams = Array.from({ length: Math.max(1, Math.ceil(lines.length / 42)) }, (_, index) => {
    const page = lines.slice(index * 42, index * 42 + 42);
    return page.map((line, lineIndex) => lineIndex === 0
      ? `BT /F1 11 Tf 54 790 Td (${escapePdf(line)}) Tj`
      : `0 -17 Td (${escapePdf(line)}) Tj`).join("\n") + "\nET";
  });
  const streams = [...textStreams, ...tableStreams(tables)];
  const pageObjectNumbers = streams.map((_, index) => 3 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${streams.length} >>`,
  ];
  streams.forEach((text, index) => {
    const pageNumber = pageObjectNumbers[index];
    const contentNumber = pageNumber + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${3 + streams.length * 2} 0 R >> >> /Contents ${contentNumber} 0 R >>`);
    objects.push(`<< /Length ${binaryLength(text)} >>\nstream\n${text}\nendstream`);
  });
  // Les octets latin-1 (é, à, ç…) doivent utiliser WinAnsi : Helvetica seul
  // emploie StandardEncoding et affichait par exemple « é » comme « Ø ».
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding >> >>");
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(binaryLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = binaryLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}
