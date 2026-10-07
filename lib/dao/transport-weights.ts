import "@/lib/submission/pdfjs-worker-setup";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Lecture GRATUITE (sans IA, sans internet) des tableaux « LISTE ET POIDS DES MATÉRIAUX ESTIMÉS À TRANSPORTER » d'un DAO.
// Beaucoup de DAO donnent DEUX tableaux (remplissage des murs en briques / en parpaings) avec, pour chacun, trois totaux :
// poids total, poids fourni hors localité (distance > 10 km) et poids existant dans la localité (distance ≤ 10 km).
// Le résultat est gardé dans l'analyse du DAO (tenders.ai_analysis.transport_weights) : le PDF n'est lu qu'une seule fois.

export type TransportWeightRow = { material: string; quantity: number | null; unit: string; totalKg: number; outsideKg: number; localKg: number };
export type TransportWeightTable = {
  variant: "brique" | "parpaing" | "unique";
  title: string;
  rows: TransportWeightRow[];
  totalKg: number;
  /** Matériaux fournis hors de la localité (distance > 10 km) : ceux qui se transportent sur de longues distances. */
  outsideKg: number;
  /** Matériaux existant dans la localité (distance ≤ 10 km). */
  localKg: number;
  page: number;
};
export type TransportWeights = { tables: TransportWeightTable[]; source: string };

export type TextItem = { str: string; x: number; y: number };

const UNIT_RE = /^(tonne|tonnes|m3|m³|unite|unité|u|kg|litre|litres|l|metre lineaire|mètre linéaire|ml|ens|ff|fft)$/i;
const toNumber = (input: string): number | null => {
  const text = input.replace(/\s*kg\s*$/i, "");
  const clean = text.replace(/\s/g, "").replace(/ /g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return null;
  return Number(clean);
};
const isNumeric = (text: string) => toNumber(text) !== null;
const norm = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Regroupe les morceaux de texte d'une page en lignes (même hauteur), triés de gauche à droite. */
function toLines(items: TextItem[]): TextItem[][] {
  const sorted = [...items].filter((item) => item.str.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: TextItem[][] = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - item.y) <= 3) last.push(item);
    else lines.push([item]);
  }
  return lines.map((line) => line.sort((a, b) => a.x - b.x));
}

/** Colle les morceaux de nombre séparés par une espace de milliers (« 24 » « 760,00 ») en un seul nombre. */
function mergeNumbers(line: TextItem[]): TextItem[] {
  const out: TextItem[] = [];
  for (const item of line) {
    const previous = out[out.length - 1];
    if (previous && /^\d{1,3}$/.test(previous.str.trim()) && /^\d{3}([.,]\d+)?$/.test(item.str.trim()) && item.x - previous.x < 40) {
      out[out.length - 1] = { str: `${previous.str.trim()}${item.str.trim()}`, x: previous.x, y: previous.y };
    } else out.push(item);
  }
  return out;
}

/** Pages (dans l'ordre) qui portent les tableaux de poids → tableaux lus. Fonction pure, testable sans PDF. */
export function parseTransportWeightPages(pages: Array<{ page: number; items: TextItem[] }>): TransportWeights {
  const tables: TransportWeightTable[] = [];
  // L'état (tableau en cours, colonnes) passe d'une page à la suivante : un tableau de poids tient souvent sur 2 ou 3 pages.
  let current: TransportWeightTable | null = null;
  // Poids des lignes du tableau en cours, avec leur position horizontale : la colonne (total / hors localité / dans la
  // localité) est décidée à la fin du tableau, d'après la position des trois totaux de la ligne TOTAL.
  let pending: Array<{ row: TransportWeightRow; weights: Array<{ value: number; x: number }> }> = [];
  const assign = (centres: number[]) => {
    for (const { row, weights } of pending) {
      weights.forEach((weight, position) => {
        let column = position;
        if (weights.length < 3 && centres.length >= 3) column = centres.map((centre, i) => ({ i, d: Math.abs(centre - weight.x) })).sort((a, b) => a.d - b.d)[0].i;
        if (column === 0) row.totalKg = weight.value;
        else if (column === 1) row.outsideKg = weight.value;
        else row.localKg = weight.value;
      });
    }
    pending = [];
  };
  for (const { page, items } of pages) {
    const lines = toLines(items).map(mergeNumbers);
    for (const line of lines) {
      const joined = line.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
      const lowered = norm(joined);
      if (/liste et poids des materiaux/.test(lowered)) {
        const variant = /brique/.test(lowered) ? "brique" : /parpaing/.test(lowered) ? "parpaing" : "unique";
        assign([]);
        current = { variant, title: joined, rows: [], totalKg: 0, outsideKg: 0, localKg: 0, page };
        tables.push(current);
        continue;
      }
      if (!current) continue;
      // Fin de la zone des tableaux de poids (chapitre suivant du DAO).
      if (/^chapitre\s+vi\b|termes de reference/.test(lowered)) { assign([]); current = null; continue; }
      // Ligne de total : « TOTAL 230 590,40 Kg 41 921,00 Kg 188 669,40 Kg ».
      if (/^total\b/.test(lowered)) {
        const numbers = line.filter((item) => isNumeric(item.str));
        if (numbers.length >= 1) {
          current.totalKg = toNumber(numbers[0].str) ?? 0;
          current.outsideKg = numbers.length >= 2 ? (toNumber(numbers[1].str) ?? 0) : 0;
          current.localKg = numbers.length >= 3 ? (toNumber(numbers[2].str) ?? 0) : 0;
          assign(numbers.map((item) => item.x));
        }
        continue;
      }
      // Ligne de matériau : texte… quantité unité poids(s).
      const unitIndex = line.findIndex((item, i) => i > 0 && UNIT_RE.test(item.str.trim()) && isNumeric(line[i - 1].str));
      if (unitIndex < 1) continue;
      const quantity = toNumber(line[unitIndex - 1].str);
      const material = line.slice(0, unitIndex - 1).map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
      if (!material) continue;
      const weights = line.slice(unitIndex + 1).filter((item) => isNumeric(item.str)).map((item) => ({ value: toNumber(item.str) ?? 0, x: item.x }));
      const row: TransportWeightRow = { material, quantity, unit: line[unitIndex].str.trim(), totalKg: 0, outsideKg: 0, localKg: 0 };
      pending.push({ row, weights });
      current.rows.push(row);
    }
  }
  // Les totaux du DAO sont la référence. Deux tableaux de même variante (chapitre V et annexe de la convention) : le premier est gardé.
  assign([]);
  const seen = new Set<string>();
  const unique = tables.filter((table) => table.totalKg > 0 && !seen.has(table.variant) && seen.add(table.variant));
  return { tables: unique, source: unique.length > 0 ? `pages ${[...new Set(unique.map((table) => table.page))].join(", ")} du DAO` : "" };
}

/** Lit un PDF de DAO et en tire les tableaux de poids (texte du PDF uniquement, aucun appel IA). */
export async function readTransportWeightsFromPdf(pdfBytes: Uint8Array): Promise<TransportWeights> {
  const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
  const pages: Array<{ page: number; items: TextItem[] }> = [];
  let previousWasWeightPage = false;
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    try {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items: TextItem[] = content.items.flatMap((item) => ("str" in item && item.str.trim() !== "" ? [{ str: item.str, x: item.transform[4], y: item.transform[5] }] : []));
      const quick = norm(items.map((item) => item.str).join(" "));
      const titled: boolean = /liste et poids des materiaux/.test(quick);
      // Page de titre du tableau, ou page qui le continue (matériaux et poids en kg, sans nouveau chapitre).
      const continues: boolean = previousWasWeightPage && quick.includes("kg") && /\b(ciment|gravillon|sable|moellons?|planche|fer \d+|peinture|total)\b/.test(quick) && !/termes de reference/.test(quick);
      previousWasWeightPage = titled || continues;
      if (titled || continues) pages.push({ page: pageNumber, items });
    } catch { previousWasWeightPage = false; }
  }
  return parseTransportWeightPages(pages);
}
