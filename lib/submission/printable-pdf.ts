import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
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

export async function createPrintableSubmissionPdf(title: string, company: Record<string, unknown>, extraLines: string[] = [], tables: PrintableTable[] = [], options: { tableOnly?: boolean } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(cleanText(title).slice(0, 200));
  // subset:false — même raison que dans createFillableDaoTemplatePdf et
  // renderGeneratedDocumentPdf : les cases de tableau créées plus bas
  // (drawRow) restent modifiables, y compris avec des caractères qui
  // n'apparaissent nulle part ailleurs dans ce document précis.
  const { font, boldFont } = await embedUnicodeFonts(doc, { subset: false });
  const form = doc.getForm();
  const fieldCounter = { current: 0 };

  // tableOnly : pour une pièce dont le SEUL vrai contenu est un tableau que
  // l'application construit elle-même à partir de vraies valeurs entrées
  // (liste de personnel/matériel, planning d'exécution, poids du transport,
  // registre des plans) — jamais un document à signer. Le titre en lettre,
  // les coordonnées de l'entreprise, "Document à lire, imprimer et signer...",
  // "Lieu et date"/"Signature et cachet" n'existent dans AUCUN DAO pour ce
  // genre de pièce et faisaient doublon avec le titre et les colonnes déjà
  // affichés par le tableau juste en dessous : on ne les ajoute donc plus du
  // tout ici, seul le tableau reste.
  const lines = options.tableOnly ? [...extraLines].flatMap((line) => wrapLine(cleanText(line))) : [
    title.toUpperCase(), "", `Entreprise : ${company.legal_name || company.trade_name || "À compléter"}`,
    `Représentant : ${company.representative_name || "À compléter"}`,
    `Fonction : ${company.representative_role || "À compléter"}`,
    `Adresse : ${company.address || "À compléter"}`, `NIF : ${company.nif || "À compléter"}   STAT : ${company.stat || "À compléter"}`,
    "", ...extraLines, "", "Document à lire, imprimer et signer ou parapher selon les exigences du DAO.",
    // Ces pointillés/traits n'existent dans AUCUN vrai document du DAO — on
    // les invente nous-mêmes juste pour "faire modèle". Comme rien n'est
    // jamais rempli automatiquement ici (ni la date, ni la signature), on
    // laisse ces zones simplement vides plutôt que d'inventer un remplissage
    // qui n'a pas de valeur réelle derrière.
    "", "Lieu et date :", "", "Signature et cachet :", "", "",
  ].flatMap((line) => wrapLine(cleanText(line)));

  // --- Largeur des colonnes : elles s'ADAPTENT au contenu, la taille du texte
  // ne change JAMAIS. Une case de tableau s'affiche à l'écran en 11 pt (Times,
  // réglage par défaut de l'application) : chaque colonne doit donc être assez
  // large pour le texte le plus long qu'elle contient, mesuré avec cette même
  // police et cette même taille (plus la marge interne de la case). Si la
  // somme dépasse la largeur d'une page A4, c'est la PAGE qui s'élargit (le
  // lecteur l'ajuste ensuite à l'écran) — jamais le texte qui rétrécit ni qui
  // se coupe. Les proportions mesurées sur le vrai DAO (column_ratios) restent
  // utilisées tant que le contenu y tient. Règle générale, valable pour tout
  // tableau généré, quel que soit le DAO.
  const timesFont = await doc.embedFont(StandardFonts.TimesRoman);
  const SCREEN_FONT_SIZE = 11;
  const CELL_SIDE_PADDING = 30;
  const BASE_TABLE_WIDTH = 487;
  const layouts = new Map<PrintableTable, { widths: number[]; tableWidth: number }>();
  let pageWidth = PAGE_WIDTH;
  for (const table of tables) {
    const columns = table.columns.slice(0, 6);
    if (!columns.length) continue;
    const rows = table.rows.length ? table.rows : [columns.map(() => "")];
    const needed = columns.map((column, columnIndex) => {
      const dataWidth = Math.max(0, ...rows.map((row) => {
        const text = cleanText(String(row[columnIndex] ?? ""));
        try { return timesFont.widthOfTextAtSize(text, SCREEN_FONT_SIZE); } catch { return text.length * 6; }
      }));
      let headerWidth = 0;
      try { headerWidth = font.widthOfTextAtSize(cleanText(column ?? ""), 8); } catch { headerWidth = cleanText(column ?? "").length * 5; }
      return Math.min(900, Math.max(dataWidth, headerWidth) + CELL_SIDE_PADDING);
    });
    const neededSum = needed.reduce((sum, value) => sum + value, 0);
    const ratios = table.column_ratios?.length === columns.length && table.column_ratios.every((value) => value > 0) ? table.column_ratios : null;
    const ratioSum = ratios ? ratios.reduce((sum, value) => sum + value, 0) || 1 : 1;
    const ratioWidths = ratios ? ratios.map((ratio) => (ratio / ratioSum) * BASE_TABLE_WIDTH) : null;
    let widths: number[];
    let tableWidth: number;
    if (ratioWidths && ratioWidths.every((width, index) => width >= needed[index])) {
      widths = ratioWidths;
      tableWidth = BASE_TABLE_WIDTH;
    } else if (neededSum <= BASE_TABLE_WIDTH) {
      // Tout tient : la place en trop est répartie au prorata des besoins.
      widths = needed.map((value) => (value / neededSum) * BASE_TABLE_WIDTH);
      tableWidth = BASE_TABLE_WIDTH;
    } else {
      widths = needed;
      tableWidth = neededSum;
    }
    layouts.set(table, { widths, tableWidth });
    pageWidth = Math.max(pageWidth, Math.ceil(tableWidth + MARGIN_X * 2));
  }

  let page = doc.addPage([pageWidth, PAGE_HEIGHT]);
  let y = TOP_Y;
  for (const line of lines) {
    if (y < BOTTOM_Y) { page = doc.addPage([pageWidth, PAGE_HEIGHT]); y = TOP_Y; }
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
    const { widths, tableWidth } = layouts.get(table)!;
    const offsets = widths.reduce<number[]>((acc, width, index) => [...acc, (acc[index - 1] ?? 0) + (index === 0 ? 0 : widths[index - 1])], []);

    if (y - (TITLE_GAP + ROW_HEIGHT) < BOTTOM_Y) { page = doc.addPage([pageWidth, PAGE_HEIGHT]); y = TOP_Y; }
    page.drawText(cleanText(table.title || "Tableau du DAO"), { x: MARGIN_X, y, size: 12, font: boldFont, color: rgb(0, 0, 0) });
    y -= TITLE_GAP;

    const drawRow = (values: string[], isHeader: boolean) => {
      if (y - ROW_HEIGHT < BOTTOM_Y) { page = doc.addPage([pageWidth, PAGE_HEIGHT]); y = TOP_Y; }
      values.forEach((value, columnIndex) => {
        const width = widths[columnIndex];
        const x = MARGIN_X + offsets[columnIndex];
        page.drawRectangle({ x, y: y - ROW_HEIGHT, width, height: ROW_HEIGHT, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.7 });
        const text = cleanText(value);
        if (!text.trim()) return;
        const maxWidth = Math.max(1, width - 6);
        // On réduit d'abord la taille de police (jusqu'à 6pt) si le texte
        // ne rentre pas dans la colonne, au lieu de couper un nombre fixe
        // de caractères au hasard : l'ancienne méthode tronquait par ex.
        // "Technicien supérieur BTP" en "Technicien supérieur B", perdant
        // silencieusement une vraie information (diplôme, marque, etc.).
        let fontSize = 8;
        const fullWidthAtDefault = font.widthOfTextAtSize(text, fontSize);
        if (fullWidthAtDefault > maxWidth) {
          fontSize = Math.max(6, fontSize * (maxWidth / fullWidthAtDefault));
        }
        // Une case d'EN-TÊTE (nom des colonnes) reste fixe, comme avant. Une
        // case de DONNÉE (une ligne de personnel/matériel, un poids, un
        // chiffre d'affaires...) devient une vraie case cliquable — même
        // méthode que dans generated-document-pdf.ts (drawTable) — pour que
        // Maxime puisse corriger une valeur directement dans le lecteur PDF
        // intégré, sans devoir tout refaire depuis le dossier.
        //
        // PAS de enableMultiline() ici : la ligne garde toujours la même
        // hauteur fixe (ROW_HEIGHT, une seule ligne de texte — la police est
        // déjà réduite juste au-dessus pour rentrer sur cette seule ligne).
        // Une case "multi-lignes" dans une hauteur d'UNE seule ligne se
        // rendait chez pdf.js comme un <textarea> DÉFILANT : dès que le texte
        // dépassait un peu, un ascenseur avec ses petites flèches haut/bas
        // apparaissait par-dessus le texte (le "chevauchement à double
        // bizarre" signalé) — jamais vu sur les cases normales (un simple
        // <input>, jamais de <textarea>). En restant sur une case à une
        // seule ligne, comme TOUTES les autres cases de l'application, ce
        // défilement ne peut plus jamais apparaître.
        if (!isHeader) {
          fieldCounter.current += 1;
          const field = form.createTextField(`case_roster_${fieldCounter.current}`);
          field.addToPage(page, {
            x: x + 2,
            y: y - ROW_HEIGHT + 2,
            width: Math.max(4, width - 4),
            height: Math.max(4, ROW_HEIGHT - 4),
            borderWidth: 0,
            textColor: rgb(0, 0, 0),
            font,
          });
          field.setFontSize(fontSize);
          field.setText(text);
          return;
        }
        let display = text;
        // Si même à la taille minimale le texte ne rentre toujours pas, on
        // tronque avec "…" pour signaler clairement une coupure plutôt que
        // de couper le mot sans indication.
        if (font.widthOfTextAtSize(display, fontSize) > maxWidth) {
          while (display.length > 1 && font.widthOfTextAtSize(`${display}…`, fontSize) > maxWidth) {
            display = display.slice(0, -1);
          }
          display = `${display}…`;
        }
        page.drawText(display, { x: x + 3, y: y - ROW_HEIGHT + 6, size: fontSize, font, color: rgb(0, 0, 0) });
      });
      y -= ROW_HEIGHT;
    };
    drawRow(columns, true);
    for (const row of rows) drawRow(columns.map((_, columnIndex) => String(row[columnIndex] ?? "")), false);
    y -= TABLE_GAP;
  }

  if (fieldCounter.current > 0) {
    try {
      form.updateFieldAppearances(font);
    } catch {
      // Repli silencieux, comme dans createFillableDaoTemplatePdf et
      // renderGeneratedDocumentPdf : les valeurs restent enregistrées dans
      // les cases même si la régénération de l'aperçu échoue ici.
    }
  }
  return Buffer.from(await doc.save());
}
