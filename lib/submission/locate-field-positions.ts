import "@/lib/submission/pdfjs-worker-setup";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { significantWords } from "@/lib/submission/title-match";

// L'IA ne donne quasiment jamais de position fiable pour écrire une valeur
// sur la page DAO elle-même (constaté : 0 position sur 16 pièces d'un DAO
// réel, deux analyses de suite). Plutôt que de dépendre uniquement d'une
// coordonnée devinée par l'IA, on retrouve directement où se trouve le
// libellé du champ (ou, pour un tableau, le libellé de la ligne ET l'en-tête
// de la colonne) sur la page réelle, et on place la valeur juste à l'endroit
// normal du formulaire — exactement comme le ferait un candidat qui complète
// le modèle à la main, quel que soit le DAO.
type TextItem = { str?: string; transform?: number[]; width?: number };
type FieldTarget = { field_key: string; label: string; description?: string };
type LocatedPosition = { page: number; field_key: string; x_percent: number; y_percent: number; width_percent: number };
type LineGroup = { items: TextItem[]; text: string; y: number };
type PageData = { items: TextItem[]; width: number; height: number; lineGroups: LineGroup[] };

function normalize(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function loadPageData(doc: Awaited<ReturnType<typeof getDocument>["promise"]>, pageNumber: number): Promise<PageData | null> {
  if (pageNumber < 1 || pageNumber > doc.numPages) return null;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = (content.items as TextItem[]).filter((item) => item.str?.trim() && item.transform);
    const lineGroups = new Map<string, LineGroup>();
    items.forEach((item) => {
      const y = Math.round((item.transform?.[5] ?? 0) / 2) * 2;
      const key = String(y);
      if (!lineGroups.has(key)) lineGroups.set(key, { items: [], text: "", y });
      const group = lineGroups.get(key)!;
      group.items.push(item);
      group.text += ` ${item.str}`;
    });
    return { items, width: viewport.width, height: viewport.height, lineGroups: [...lineGroups.values()] };
  } catch {
    return null;
  }
}

/** Trouve, parmi les lignes de la page, celle qui correspond le mieux aux mots-clés d'un libellé. */
function findBestLine(lineGroups: LineGroup[], label: string, usedItems: Set<TextItem>): LineGroup | null {
  const keywords = [...significantWords(label)].filter((word) => word.length >= 3);
  if (!keywords.length) return null;
  let best: LineGroup | null = null;
  let bestScore = 0;
  for (const group of lineGroups) {
    if (group.items.every((item) => usedItems.has(item))) continue;
    const normalizedLine = normalize(group.text);
    const matched = keywords.filter((word) => normalizedLine.includes(word)).length;
    const score = matched / keywords.length;
    if (score > bestScore && score >= 0.6) { bestScore = score; best = group; }
  }
  return best;
}

/** Cherche, pour chaque champ, la ligne de la page qui porte son libellé
 * (parmi candidatePages, dans l'ordre) et place la valeur juste à côté. */
export async function locateFieldPositions(pdfBytes: Uint8Array, candidatePages: number[], targets: FieldTarget[]): Promise<LocatedPosition[]> {
  if (!targets.length || !candidatePages.length) return [];
  const results: LocatedPosition[] = [];
  const foundKeys = new Set<string>();
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    for (const pageNumber of candidatePages) {
      const pageTargets = targets.filter((target) => !foundKeys.has(target.field_key));
      if (!pageTargets.length) break;
      const pageData = await loadPageData(doc, pageNumber);
      if (!pageData) continue;
      const usedItems = new Set<TextItem>();
      for (const target of pageTargets) {
        const bestLine = findBestLine(pageData.lineGroups, target.label, usedItems);
        if (!bestLine) continue;
        bestLine.items.forEach((item) => usedItems.add(item));
        const rightmost = bestLine.items.reduce((max, item) => Math.max(max, (item.transform?.[4] ?? 0) + (item.width ?? 0)), 0);
        const topY = bestLine.items.reduce((min, item) => Math.min(min, item.transform?.[5] ?? min), bestLine.items[0].transform?.[5] ?? 0);
        const remainingWidth = pageData.width - rightmost;
        // Une valeur courte tient à droite du libellé sur la même ligne ;
        // sinon (label prenant déjà toute la largeur) on la place juste en
        // dessous, à l'alignement gauche de la ligne.
        const placeBelow = remainingWidth < pageData.width * 0.12;
        const x = placeBelow ? (bestLine.items[0].transform?.[4] ?? 0) : rightmost + 4;
        const y = placeBelow ? topY - 14 : topY;
        results.push({
          page: pageNumber,
          field_key: target.field_key,
          x_percent: Math.max(0, Math.min(96, (x / pageData.width) * 100)),
          y_percent: Math.max(0, Math.min(98, 100 - (y / pageData.height) * 100)),
          width_percent: placeBelow ? 60 : Math.max(15, Math.min(60, (remainingWidth / pageData.width) * 100 - 2)),
        });
        foundKeys.add(target.field_key);
      }
    }
  } catch {
    return results;
  }
  return results;
}

export type BracketZone = {
  page: number;
  field_key: string | null; // null = instruction pure (ex. "[insérer nom de la banque]" non reconnu) : à effacer sans rien écrire à la place
  x_percent: number;
  y_percent: number;
  width_percent: number;
  height_percent: number;
};

/**
 * Beaucoup de modèles DAO indiquent leurs blancs par une instruction entre
 * crochets en italique ("[insérer nom et adresse du Maître de l'Ouvrage]"),
 * que le DAO demande lui-même de retirer avant le dépôt ("le texte en
 * italique... devra être supprimé de la version officielle finale"). On
 * repère chaque crochet, on le fait correspondre à un champ connu par ses
 * mots-clés, et l'appelant efface la zone (rectangle blanc) avant d'écrire
 * la vraie valeur — ou la laisse simplement blanche si aucun champ ne
 * correspond (une pure instruction de préparation, pas un champ à remplir).
 */
export async function locateBracketPlaceholders(pdfBytes: Uint8Array, candidatePages: number[], fields: FieldTarget[]): Promise<BracketZone[]> {
  if (!candidatePages.length) return [];
  const results: BracketZone[] = [];
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    for (const pageNumber of candidatePages) {
      if (pageNumber < 1 || pageNumber > doc.numPages) continue;
      try {
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items = (content.items as TextItem[]).filter((item) => item.str && item.transform);
        // Reconstruit le texte complet de la page avec, pour chaque
        // caractère, l'item pdf.js dont il provient — une instruction entre
        // crochets est parfois coupée sur plusieurs items (changement de
        // police italique en plein milieu), il faut donc pouvoir retrouver
        // TOUS les items couverts par un même "[...]".
        let fullText = "";
        const charItemMap: TextItem[] = [];
        for (const item of items) {
          for (const _char of item.str ?? "") { charItemMap.push(item); }
          fullText += item.str;
        }
        const usedFieldKeys = new Set<string>();
        // Certaines instructions entre crochets sont de longs paragraphes
        // explicatifs (ex. "[La compagnie de garantie remplit cette garantie
        // d'offre conformément aux indications entre crochets...]" sur un
        // modèle de caution) : la limite précédente (220 caractères) était
        // trop courte pour ces cas-là, donc le crochet n'était jamais détecté
        // et son texte d'instruction restait visible tel quel dans le PDF
        // généré au lieu d'être effacé comme le DAO le demande lui-même.
        const bracketPattern = /\[([^[\]]{3,1200})\]/g;
        let match: RegExpExecArray | null;
        while ((match = bracketPattern.exec(fullText))) {
          const innerStart = match.index + 1;
          const innerEnd = innerStart + match[1].length;
          const spanItems = [...new Set(charItemMap.slice(match.index, innerEnd + 1))];
          if (!spanItems.length) continue;
          const minX = spanItems.reduce((min, item) => Math.min(min, item.transform?.[4] ?? min), spanItems[0].transform?.[4] ?? 0);
          const maxX = spanItems.reduce((max, item) => Math.max(max, (item.transform?.[4] ?? 0) + (item.width ?? 0)), 0);
          const minY = spanItems.reduce((min, item) => Math.min(min, item.transform?.[5] ?? min), spanItems[0].transform?.[5] ?? 0);
          // Une instruction entre crochets peut s'étaler sur PLUSIEURS lignes
          // ("[insérer la somme en chiffres dans la monnaie du pays du Maître
          // de l'Ouvrage ou un montant équivalent...]" sur 3 lignes, constaté
          // sur un vrai DAO) : minY seul (la ligne la plus BASSE du crochet,
          // les coordonnées PDF montant vers le haut) ne couvrait alors que
          // la dernière ligne, laissant les lignes du dessus intactes avec
          // leur texte d'instruction original — jamais effacées comme le DAO
          // le demande, et un vrai risque de chevauchement avec la valeur
          // écrite juste en dessous. maxY (la ligne la plus HAUTE) permet de
          // couvrir tout l'intervalle vertical réellement occupé par le
          // crochet, qu'il tienne sur une seule ligne (minY === maxY, aucun
          // changement de comportement) ou plusieurs.
          const maxY = spanItems.reduce((max, item) => Math.max(max, item.transform?.[5] ?? max), spanItems[0].transform?.[5] ?? 0);
          const fontHeight = Math.max(8, ...spanItems.map((item) => Math.abs(item.transform?.[3] ?? 10)));
          const innerText = match[1];
          const keywords = [...significantWords(innerText)].filter((word) => word.length >= 3);
          let bestField: FieldTarget | null = null;
          let bestScore = 0;
          for (const field of fields) {
            if (usedFieldKeys.has(field.field_key)) continue;
            const fieldKeywords = [...significantWords(`${field.label} ${field.description ?? ""}`)].filter((word) => word.length >= 3);
            if (!fieldKeywords.length || !keywords.length) continue;
            const shared = fieldKeywords.filter((word) => keywords.includes(word)).length;
            const score = shared / Math.min(fieldKeywords.length, keywords.length);
            if (score > bestScore && score >= 0.4) { bestScore = score; bestField = field; }
          }
          if (bestField) usedFieldKeys.add(bestField.field_key);
          results.push({
            page: pageNumber,
            field_key: bestField?.field_key ?? null,
            x_percent: Math.max(0, Math.min(98, (minX / viewport.width) * 100)),
            y_percent: Math.max(0, Math.min(99, 100 - (maxY / viewport.height) * 100) - (fontHeight / viewport.height) * 100),
            width_percent: Math.max(2, Math.min(90, ((maxX - minX) / viewport.width) * 100)),
            height_percent: Math.max(1, Math.min(40, ((maxY - minY + fontHeight * 1.3) / viewport.height) * 100)),
          });
        }
      } catch {
        // Page illisible : ces crochets resteront visibles sur cette page précise.
      }
    }
  } catch {
    return results;
  }
  return results;
}

/**
 * Mesure la largeur relative de chaque colonne d'un tableau telle qu'elle
 * apparaît réellement sur la page DAO (en repérant où commence l'en-tête de
 * chaque colonne), pour que le tableau reconstruit garde des proportions
 * proches de l'original au lieu d'une largeur égale arbitraire — une colonne
 * de désignation est presque toujours bien plus large qu'une colonne de
 * quantité ou d'unité à côté d'elle.
 */
export async function measureTableColumnRatios(pdfBytes: Uint8Array, candidatePages: number[], columns: string[]): Promise<number[] | null> {
  if (columns.length < 2 || !candidatePages.length) return null;
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    for (const pageNumber of candidatePages) {
      const pageData = await loadPageData(doc, pageNumber);
      if (!pageData) continue;
      const positions: number[] = [];
      const usedItems = new Set<TextItem>();
      // Plusieurs colonnes partagent souvent le même mot-clé ("Exercice du
      // 01/01/23", "01/01/24", "01/01/25" contiennent toutes "exercice") :
      // on cherche donc chaque colonne DANS L'ORDRE et on n'accepte qu'une
      // occurrence encore libre et située à droite de la colonne précédente,
      // pour assigner la bonne occurrence à la bonne colonne.
      let minX = -Infinity;
      for (const [columnIndex, column] of columns.entries()) {
        const keywords = [...significantWords(column)].filter((word) => word.length >= 3);
        if (!keywords.length) {
          // La toute première colonne d'un tableau DAO est presque toujours
          // la colonne de désignation, sans en-tête propre (juste ""), donc
          // sans aucun mot-clé à chercher : elle commence à la marge gauche
          // habituelle plutôt que d'être considérée comme introuvable.
          const assumed = columnIndex === 0 ? 54 : NaN;
          positions.push(assumed);
          if (!Number.isNaN(assumed)) minX = assumed;
          continue;
        }
        let bestItem: TextItem | null = null;
        let bestScore = 0;
        for (const group of pageData.lineGroups) {
          for (const item of group.items) {
            if (usedItems.has(item) || (item.transform?.[4] ?? -Infinity) <= minX) continue;
            const normalizedItem = normalize(item.str ?? "");
            if (!normalizedItem) continue;
            const matched = keywords.filter((word) => normalizedItem.includes(word)).length;
            const score = matched / keywords.length;
            if (score > bestScore && score >= 0.5) { bestScore = score; bestItem = item; }
          }
        }
        if (bestItem) { usedItems.add(bestItem); minX = bestItem.transform?.[4] ?? minX; }
        positions.push(bestItem?.transform?.[4] ?? NaN);
      }
      if (positions.some((value) => Number.isNaN(value))) continue;
      const sorted = [...positions].sort((left, right) => left - right);
      // Les positions doivent suivre le même ordre que les colonnes déclarées
      // (de gauche à droite) : sinon la mesure n'est pas fiable pour ce tableau.
      if (JSON.stringify(sorted) !== JSON.stringify(positions)) continue;
      const widths = positions.map((start, index) => (index < positions.length - 1 ? positions[index + 1] - start : Math.max(pageData.width - start, 20)));
      if (widths.some((width) => width <= 0)) continue;
      return widths;
    }
  } catch {
    return null;
  }
  return null;
}

type TableCellTarget = { field_key: string; row_label: string; column_label: string };

/**
 * Même principe que locateFieldPositions, mais pour une cellule de tableau :
 * la ligne qui porte le libellé de LIGNE donne le Y, la ligne d'en-tête qui
 * porte le libellé de COLONNE donne le X — la valeur va à leur intersection,
 * directement dans la case du tableau imprimé sur la page DAO.
 */
export async function locateTableCellPositions(pdfBytes: Uint8Array, candidatePages: number[], targets: TableCellTarget[]): Promise<LocatedPosition[]> {
  if (!targets.length || !candidatePages.length) return [];
  const results: LocatedPosition[] = [];
  const foundKeys = new Set<string>();
  try {
    const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
    for (const pageNumber of candidatePages) {
      const pageTargets = targets.filter((target) => !foundKeys.has(target.field_key));
      if (!pageTargets.length) break;
      const pageData = await loadPageData(doc, pageNumber);
      if (!pageData) continue;
      // Les en-têtes de colonnes sont toujours au-dessus des lignes de
      // données : on les cherche une seule fois par page, sans les marquer
      // "utilisés", puisque plusieurs lignes partagent la même colonne.
      const columnUsed = new Set<TextItem>();
      const rowUsed = new Set<TextItem>();
      for (const target of pageTargets) {
        const columnLine = findBestLine(pageData.lineGroups, target.column_label, columnUsed);
        const rowLine = findBestLine(pageData.lineGroups, target.row_label, rowUsed);
        if (!columnLine || !rowLine) continue;
        rowUsed.clear();
        rowLine.items.forEach((item) => rowUsed.add(item));
        const columnStart = columnLine.items.reduce((min, item) => Math.min(min, item.transform?.[4] ?? min), columnLine.items[0].transform?.[4] ?? 0);
        const columnEnd = columnLine.items.reduce((max, item) => Math.max(max, (item.transform?.[4] ?? 0) + (item.width ?? 0)), 0);
        const rowY = rowLine.items.reduce((min, item) => Math.min(min, item.transform?.[5] ?? min), rowLine.items[0].transform?.[5] ?? 0);
        results.push({
          page: pageNumber,
          field_key: target.field_key,
          x_percent: Math.max(0, Math.min(96, (columnStart / pageData.width) * 100)),
          y_percent: Math.max(0, Math.min(98, 100 - (rowY / pageData.height) * 100)),
          width_percent: Math.max(10, Math.min(40, ((columnEnd - columnStart) / pageData.width) * 100 - 2)),
        });
        foundKeys.add(target.field_key);
      }
    }
  } catch {
    return results;
  }
  return results;
}
