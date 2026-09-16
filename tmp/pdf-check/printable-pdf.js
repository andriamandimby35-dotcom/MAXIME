"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPrintableSubmissionPdf = createPrintableSubmissionPdf;
/** Répare les anciennes chaînes UTF-8 lues comme du latin-1 (ex. ReprÃ©sentant). */
function repairMojibake(value) {
    let repaired = value;
    for (let pass = 0; pass < 2 && /[ÃÂâ]/.test(repaired); pass += 1) {
        const candidate = Buffer.from(repaired, "latin1").toString("utf8");
        if (candidate === repaired || candidate.includes("\uFFFD"))
            break;
        repaired = candidate;
    }
    return repaired;
}
function escapePdf(value) {
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
function binaryLength(value) {
    return Buffer.byteLength(value, "latin1");
}
function wrapLine(value, maximum = 88) {
    const words = value.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = "";
    for (const word of words) {
        if (`${current} ${word}`.trim().length > maximum && current) {
            lines.push(current);
            current = word;
        }
        else
            current = `${current} ${word}`.trim();
    }
    if (current || !lines.length)
        lines.push(current);
    return lines;
}
function tableStreams(tables) {
    return tables.flatMap((table) => {
        const columns = table.columns.slice(0, 6);
        if (!columns.length)
            return [];
        const rows = table.rows.length ? table.rows : [columns.map(() => "")];
        const pages = Array.from({ length: Math.ceil(rows.length / 32) }, (_, index) => rows.slice(index * 32, index * 32 + 32));
        return pages.map((pageRows, pageIndex) => {
            const width = 487 / columns.length;
            const cell = (value, column, row) => {
                const x = 54 + column * width;
                const y = 742 - row * 19;
                const clipped = value.slice(0, Math.max(8, Math.floor(width / 5.2)));
                return `0.7 w ${x} ${y} ${width} 19 re S BT /F1 8 Tf ${x + 3} ${y + 6} Td (${escapePdf(clipped)}) Tj ET`;
            };
            const titleText = `${table.title || "Tableau du DAO"}${pages.length > 1 ? ` (${pageIndex + 1}/${pages.length})` : ""}`;
            return [
                `BT /F1 12 Tf 54 790 Td (${escapePdf(titleText)}) Tj ET`,
                ...columns.map((column, index) => cell(column, index, 0)),
                ...pageRows.flatMap((row, rowIndex) => columns.map((_, columnIndex) => cell(String(row[columnIndex] ?? ""), columnIndex, rowIndex + 1))),
            ].join("\n");
        });
    });
}
function createPrintableSubmissionPdf(title, company, extraLines = [], tables = []) {
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
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => { offsets.push(binaryLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = binaryLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf, "latin1");
}
