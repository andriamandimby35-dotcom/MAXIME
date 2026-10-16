// Détection GRATUITE (sans IA) des lots d'un DAO à plusieurs lots, à partir du texte de chaque page du PDF.
//
// Dans ces DAO, le lot n'est PAS un titre : seule une petite ligne « • Lot 2 : Chef lieu de la Commune… »
// figure sur la PREMIÈRE page de chaque tableau (bordereau de prix unitaire, détail quantitatif et estimatif).
// Les pages suivantes du même tableau ne mentionnent plus le lot. Un lot commence donc à la page où cette ligne
// apparaît et dure jusqu'à la page où commence le tableau suivant (ou jusqu'à la fin du bloc de formulaires).
//
// Ce fichier ne contient que des fonctions pures (aucun import serveur) : il est testable sans PDF.

export type PageText = { page: number; lines: string[] };
export type PageRange = [number, number];
export type LotSection = { start: number; end: number; lot: number | null };
export type DetectedLot = {
  number: number;
  label: string;
  /** Pages (du PDF d'origine) des tableaux de prix propres à ce lot. */
  ranges: PageRange[];
  pageCount: number;
  /** Montant de la garantie de soumission de ce lot si le DAO le donne par lot (ex. « 5 000 000 Ar »). */
  bidSecurity: string | null;
};
export type LotDetection = {
  pageCount: number;
  lots: DetectedLot[];
  sections: LotSection[];
  /** Blocs de pages du CCAG (cahier général, non utile à la soumission). */
  ccagRanges: PageRange[];
};

export const norm = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// « • Lot 2 : … », « - LOT 2: … », « Lot n° 2 – … », « LOT 02 » en début de ligne.
const LOT_LINE = /^\s*[•\-–—*·o]?\s*lot\s*(?:n\s*°|n°|no\.?|num[ée]ro)?\s*0*(\d{1,2})\s*(?:[:\-–—.)]\s*(.*))?$/i;
// Première page d'un tableau de prix : on ne regarde que le haut de la page (jamais un simple renvoi dans un texte).
const TABLE_START = /cadre du (bordereau|detail|d[ée]tail)|bordereau (des|de) prix|detail quantitatif et estimatif|devis quantitatif et estimatif|sous[- ]detail des prix/;

function lotNumbersOnPage(lines: string[]) {
  const found: Array<{ number: number; label: string }> = [];
  for (const line of lines) {
    const match = line.match(LOT_LINE);
    if (match) found.push({ number: Number(match[1]), label: (match[2] ?? "").trim() });
  }
  return found;
}

/** Titre courant d'une page (première ligne), débarrassé des chiffres : sert à reconnaître « le même bloc de pages ». */
function headerOf(page: PageText | undefined) {
  const first = (page?.lines ?? []).find((line) => line.trim() !== "") ?? "";
  return norm(first).replace(/[0-9]+/g, "").replace(/\s+/g, " ").trim();
}

function mergeRanges(pages: number[]): PageRange[] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: PageRange[] = [];
  for (const page of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && page === last[1] + 1) last[1] = page;
    else ranges.push([page, page]);
  }
  return ranges;
}

function formatAmount(raw: string) {
  const digits = raw.replace(/[\s .]/g, "");
  return digits ? `${Number(digits).toLocaleString("fr-FR").replace(/ /g, " ")} Ar` : null;
}

export function detectLots(pages: PageText[]): LotDetection {
  const pageCount = pages.length;
  const byPage = new Map(pages.map((page) => [page.page, page]));

  // 1) Pages où commence un tableau de prix.
  const starts: Array<{ page: number; lot: number | null; label: string }> = [];
  for (const page of pages) {
    const top = norm(page.lines.slice(0, 10).join(" "));
    if (!TABLE_START.test(top)) continue;
    const lots = lotNumbersOnPage(page.lines);
    const distinct = [...new Set(lots.map((lot) => lot.number))];
    // Une page qui liste plusieurs lots n'est pas le tableau d'UN lot (c'est le modèle vierge ou une liste).
    const only = distinct.length === 1 ? lots[0] : null;
    starts.push({ page: page.page, lot: only ? only.number : null, label: only?.label ?? "" });
  }

  // 2) Chaque tableau dure jusqu'au tableau suivant, sans sortir du bloc de pages au même titre courant.
  const sections: LotSection[] = starts.map((start, index) => {
    const nextStart = starts[index + 1]?.page ?? pageCount + 1;
    let end = start.page;
    const header = headerOf(byPage.get(start.page));
    while (end + 1 < nextStart && end + 1 <= pageCount && headerOf(byPage.get(end + 1)) === header) end += 1;
    return { start: start.page, end, lot: start.lot };
  });

  // 3) Regroupement par lot.
  const lotNumbers = [...new Set(starts.flatMap((start) => (start.lot === null ? [] : [start.lot])))].sort((a, b) => a - b);

  // 4) Garantie de soumission par lot : « • Lot 7 : Trois Cent Millions Ariary (Ar 300 000 000,00) ».
  // On ne lit que les lignes « Lot N : … (Ar …) » placées juste après la mention « garantie de soumission »
  // (au plus 14 lignes plus loin, même en passant à la page suivante) : un autre montant par lot du DAO
  // (chiffre d'affaires, liquidités…) ne doit jamais être pris pour la garantie.
  const security = new Map<number, string>();
  let linesSinceMention = Number.POSITIVE_INFINITY;
  for (const page of pages) {
    for (const line of page.lines) {
      if (norm(line).includes("garantie de soumission")) linesSinceMention = 0;
      else linesSinceMention += 1;
      if (linesSinceMention > 14) continue;
      const match = line.match(LOT_LINE);
      const amount = line.match(/\(\s*(?:ar|mga)\.?\s*([0-9][0-9\s\u00a0.]*)(?:,\d+)?\s*\)/i);
      if (match && amount) {
        const formatted = formatAmount(amount[1]);
        if (formatted && !security.has(Number(match[1]))) security.set(Number(match[1]), formatted);
      }
    }
  }

  const lots: DetectedLot[] = lotNumbers.map((number) => {
    const mine = sections.filter((section) => section.lot === number);
    const pagesOfLot = mine.flatMap((section) => Array.from({ length: section.end - section.start + 1 }, (_, i) => section.start + i));
    const label = starts.find((start) => start.lot === number && start.label)?.label ?? "";
    return {
      number,
      label: label.replace(/\s+/g, " ").slice(0, 200),
      ranges: mergeRanges(pagesOfLot),
      pageCount: new Set(pagesOfLot).size,
      bidSecurity: security.get(number) ?? null,
    };
  });

  // 5) Pages du CCAG (cahier général standard) : retirées par défaut du mini-DAO.
  const ccagPages = pages
    .filter((page) => {
      const header = headerOf(page);
      return /^ccag\b/.test(header) || /cahier des clauses administratives generales/.test(header);
    })
    .map((page) => page.page);

  return { pageCount, lots, sections, ccagRanges: mergeRanges(ccagPages) };
}

export function expandRanges(ranges: PageRange[]) {
  return ranges.flatMap(([from, to]) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i));
}

/**
 * Pages (numéros du PDF d'origine) qui forment le mini-DAO d'un lot : tout le dossier SAUF les tableaux de prix des
 * AUTRES lots (et, si demandé, le CCAG). Les pages communes (instructions, DPAO, CCAP, spécifications, formulaires,
 * modèles vierges) restent, puisque le dossier de soumission en a besoin.
 */
export function pagesForLot(detection: LotDetection, lotNumber: number, options: { dropCcag?: boolean } = {}) {
  const removed = new Set<number>();
  const mine = new Set(expandRanges(detection.lots.find((lot) => lot.number === lotNumber)?.ranges ?? []));
  for (const lot of detection.lots) {
    if (lot.number === lotNumber) continue;
    for (const page of expandRanges(lot.ranges)) if (!mine.has(page)) removed.add(page);
  }
  if (options.dropCcag !== false) for (const page of expandRanges(detection.ccagRanges)) removed.add(page);
  const kept: number[] = [];
  for (let page = 1; page <= detection.pageCount; page += 1) if (!removed.has(page)) kept.push(page);
  return kept;
}

/** « PDF 1-41 = DAO 1-41 ; PDF 42-47 = DAO 42-47 ; PDF 48-60 = DAO 54-66 … » — pour dire à l'IA comment retrouver les pages d'origine. */
export function describePageMap(sourcePages: number[]) {
  const runs: string[] = [];
  let i = 0;
  while (i < sourcePages.length) {
    let j = i;
    while (j + 1 < sourcePages.length && sourcePages[j + 1] === sourcePages[j] + 1) j += 1;
    const pdfFrom = i + 1;
    const pdfTo = j + 1;
    const origFrom = sourcePages[i];
    const origTo = sourcePages[j];
    runs.push(pdfFrom === pdfTo ? `page ${pdfFrom} = page ${origFrom} du DAO complet` : `pages ${pdfFrom}-${pdfTo} = pages ${origFrom}-${origTo} du DAO complet`);
    i = j + 1;
  }
  return runs.join(" ; ");
}

/** Lecture des plages saisies à la main : « 54-59, 62 » → [[54,59],[62,62]]. Ignore tout ce qui est hors du PDF. */
export function parseRanges(text: string, pageCount: number): PageRange[] {
  const ranges: PageRange[] = [];
  for (const part of String(text ?? "").split(/[;,\s]+/)) {
    const match = part.match(/^(\d{1,4})(?:\s*[-–à]\s*(\d{1,4}))?$/);
    if (!match) continue;
    const from = Math.max(1, Math.min(Number(match[1]), pageCount));
    const to = Math.max(1, Math.min(Number(match[2] ?? match[1]), pageCount));
    ranges.push(from <= to ? [from, to] : [to, from]);
  }
  return mergeRanges(expandRanges(ranges));
}
