import "@/lib/submission/pdfjs-worker-setup";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, rgb } from "pdf-lib";
import { significantWords } from "@/lib/submission/title-match";
import { sanitizeForPdf } from "@/lib/submission/dao-template-pdf";
import { embedUnicodeFonts } from "@/lib/submission/pdf-font";

// Écrire une valeur PAR-DESSUS la page originale du DAO dépend de la mise en
// page exacte du PDF source (polices, calques, structure interne) — un DAO
// mal formé ou un lecteur PDF particulier peut alors afficher le résultat
// autrement que prévu, sans qu'aucune erreur ne remonte. Ici, on ne touche
// plus du tout au PDF original : on relit son texte ligne par ligne et on
// RECRÉE entièrement la page en remplaçant directement les blancs par les
// vraies valeurs — même si la police change, le contenu reste fidèle au
// modèle du DAO et le rendu ne dépend plus jamais du fichier source.
type FieldTarget = { field_key: string; label: string; description?: string };
type TextItem = { str?: string; transform?: number[] };

function normalize(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function bestFieldMatch(text: string, fields: FieldTarget[], excluded: Set<string>, minRatio: number) {
  const keywords = [...significantWords(text)].filter((word) => word.length >= 3);
  if (!keywords.length) return null;
  let best: FieldTarget | null = null;
  let bestScore = 0;
  for (const field of fields) {
    if (excluded.has(field.field_key)) continue;
    const fieldKeywords = [...significantWords(`${field.label} ${field.description ?? ""}`)].filter((word) => word.length >= 3);
    if (!fieldKeywords.length) continue;
    const shared = fieldKeywords.filter((word) => keywords.includes(word)).length;
    const score = shared / Math.min(fieldKeywords.length, keywords.length);
    if (score > bestScore && score >= minRatio) { bestScore = score; best = field; }
  }
  return best;
}

// Un DAO justifie souvent son texte : la ligne visuelle juste avant un blanc
// (points de suite, ou ":" en fin de ligne) peut alors ne contenir que la fin
// du libellé ("...estimé à :........"), le début ("un montant total") ayant
// débordé sur la ligne précédente à cause du retour à la ligne automatique du
// PDF — pas d'un vrai changement de paragraphe. Si la ligne associée au blanc
// n'a presque pas de mot-clé exploitable, on élargit donc la recherche au
// texte qui précède (sans franchir une vraie coupure de paragraphe) pour ne
// pas perdre ces mots-clés "débordés" en amont. Ce filet est générique : il
// ne dépend d'aucun intitulé particulier et s'applique à n'importe quel DAO.
function widenLabel(resolved: string, offset: number, labelPart: string) {
  if (significantWords(labelPart).size >= 2) return labelPart;
  const searchStart = Math.max(0, offset - 220);
  let context = resolved.slice(searchStart, offset);
  const paragraphBreak = context.lastIndexOf("\n\n");
  if (paragraphBreak >= 0) context = context.slice(paragraphBreak + 2);
  return `${context.replace(/\n/g, " ")} ${labelPart}`.trim();
}

// Une note instructive du DAO n'est pas toujours entre crochets (ex. "Note :
// le texte en italiques... devra être supprimé de la version officielle
// finale") : ce genre de phrase qui s'auto-désigne comme à retirer avant
// dépôt est repérée par son sens, pas seulement par la ponctuation.
const SELF_REMOVING_NOTE = /(texte en italiques?.{0,80}(supprim|retir)|devra être supprim.{0,40}(version|dépôt)|à supprimer avant le dépôt|ne doit pas figurer dans la version (officielle|finale))/i;

type MeasuredItem = TextItem & { width?: number };

/**
 * Reconstitue le texte de la page en UNE seule chaîne (retours à la ligne
 * marqués par "\n"), avec un espace inséré entre deux items dès qu'un vrai
 * espacement horizontal les sépare — pdf.js ne restitue pas toujours
 * l'espace lui-même comme caractère, seulement l'écart de position.
 * Un texte à une seule chaîne (plutôt que ligne par ligne) permet aussi de
 * retrouver une instruction entre crochets même quand elle s'étend sur
 * plusieurs lignes visuelles du PDF (ex. un crochet qui se referme au début
 * de la ligne suivante).
 */
async function extractPageText(page: Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>["promise"]>["getPage"]>>): Promise<string> {
  const content = await page.getTextContent();
  const items = (content.items as MeasuredItem[]).filter((item) => item.str !== undefined && item.transform);
  const groups = new Map<number, MeasuredItem[]>();
  for (const item of items) {
    const y = Math.round((item.transform?.[5] ?? 0) / 2) * 2;
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y)!.push(item);
  }
  const lines = [...groups.entries()]
    .sort((left, right) => right[0] - left[0]) // le haut de la page a le Y le plus grand
    .map(([, lineItems]) => {
      const sorted = [...lineItems].sort((left, right) => (left.transform?.[4] ?? 0) - (right.transform?.[4] ?? 0));
      let line = "";
      let previousEnd: number | null = null;
      for (const item of sorted) {
        const start = item.transform?.[4] ?? 0;
        const str = item.str ?? "";
        if (!str.trim()) { previousEnd = start + (item.width ?? 0); continue; }
        const needsSpace = previousEnd !== null && start - previousEnd > 1 && !line.endsWith(" ") && !str.startsWith(" ");
        line += (needsSpace ? " " : "") + str;
        previousEnd = start + (item.width ?? 0);
      }
      return line;
    });
  return lines.join("\n");
}

/** Une ligne de titre du DAO est courte, sans ponctuation de fin de phrase. */
function looksLikeHeading(line: string) {
  const trimmed = line.trim();
  const letters = trimmed.replace(/[^A-Za-zÀ-ÿ]/g, "");
  return letters.length >= 4 && trimmed.length <= 90 && !/[.,;]\s*$/.test(trimmed);
}

/** Une ligne "Libellé : valeur" ressemble à une case de formulaire tabulaire
 * (comme les fiches de renseignements) : courte, avec un ":" tôt sur la
 * ligne, jamais une phrase complète en prose. */
function looksLikeFormField(line: string) {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 100) return false;
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex < 2 || colonIndex > 60) return false;
  return !/[.;]\s*$/.test(trimmed.slice(0, colonIndex));
}

/**
 * Relit le texte réel des pages DAO indiquées et reconstruit chaque ligne en
 * remplaçant directement les blancs par les vraies valeurs : les
 * instructions entre crochets ("[insérer nom de la banque]") deviennent la
 * valeur du champ correspondant (ou disparaissent si aucun champ ne
 * correspond, comme le DAO le demande lui-même), et les longues suites de
 * points/tirets/soulignés précédées d'un intitulé reconnu sont remplacées de
 * la même façon.
 */
export async function rebuildTemplatePages(pdfBytes: Uint8Array, pageNumbers: number[], fields: FieldTarget[], values: Record<string, string>): Promise<string[][]> {
  const doc = await getDocument({ data: pdfBytes.slice(), useSystemFonts: true }).promise;
  // Un même champ (ex. le nom de la banque) revient souvent à plusieurs
  // endroits du modèle ("Nom de la banque :" ET plus loin "Garant :") ; les
  // deux doivent recevoir la vraie valeur, donc les crochets ne s'excluent
  // jamais entre eux. Seules les suites de points/soulignés (signal plus
  // ambigu, basé sur le texte environnant) gardent un suivi pour éviter
  // qu'un même champ ne s'invite deux fois sur une correspondance douteuse.
  const noExclusion = new Set<string>();
  const usedForBlanks = new Set<string>();
  const pages: string[][] = [];
  for (const pageNumber of pageNumbers) {
    if (pageNumber < 1 || pageNumber > doc.numPages) continue;
    let fullText: string;
    try {
      const page = await doc.getPage(pageNumber);
      fullText = await extractPageText(page);
    } catch {
      continue;
    }
    // Une instruction entre crochets peut s'étendre sur plusieurs lignes
    // visuelles du PDF (le crochet fermant commence la ligne suivante) : on
    // travaille donc sur le texte entier de la page, "\n" compris, jamais
    // ligne par ligne — sinon ces crochets-là ne seraient jamais reconnus.
    let resolved = fullText.replace(/\[([^[\]]{2,220})\]/g, (_whole, inner: string) => {
      const match = bestFieldMatch(inner.replace(/\n/g, " "), fields, noExclusion, 0.4);
      const value = match ? values[match.field_key]?.trim() || "" : "";
      // Espace de part et d'autre pour ne jamais coller la valeur insérée au
      // mot qui précède/suit directement (ex. "que" + valeur + "(ci-après").
      return value ? ` ${value} ` : "";
    });
    // Longue suite de points/tirets/soulignés précédée d'un intitulé : le
    // libellé recherché reste celui de la MÊME ligne visuelle (depuis le
    // dernier retour à la ligne), pas tout ce qui précède sur la page.
    resolved = resolved.replace(/([:.]?\s*)([.…_]{5,})/g, (whole, sep: string, _dots: string, offset: number) => {
      const lineStart = resolved.lastIndexOf("\n", offset) + 1;
      const labelPart = widenLabel(resolved, offset, resolved.slice(lineStart, offset));
      const match = bestFieldMatch(labelPart, fields, usedForBlanks, 0.5);
      const value = match ? values[match.field_key]?.trim() : "";
      if (match && value) { usedForBlanks.add(match.field_key); return `${sep} ${value} `; }
      return whole;
    });
    // Beaucoup de formulaires en tableau (ex. Fiche de renseignements A1)
    // n'utilisent ni crochets ni points de suite : juste un intitulé suivi
    // d'un ":" et d'une case vide sans aucun caractère de remplissage. Toute
    // ligne qui se termine par ":" (rien après, ou seulement des espaces)
    // reçoit donc directement la valeur du champ reconnu.
    resolved = resolved.replace(/^([^\n]*?:)[ \t]*$/gm, (whole, labelWithColon: string, offset: number) => {
      const labelPart = widenLabel(resolved, offset, labelWithColon.slice(0, -1));
      const match = bestFieldMatch(labelPart, fields, usedForBlanks, 0.5);
      const value = match ? values[match.field_key]?.trim() : "";
      if (match && value) { usedForBlanks.add(match.field_key); return `${labelWithColon} ${value}`; }
      return whole;
    });
    // Un mot coupé en fin de ligne justifiée ("...devra être sup-\nprimé...")
    // sépare le mot-clé recherché sur deux lignes : on rejoint d'abord ces
    // césures avant de chercher une note auto-référentielle à retirer,
    // sinon le motif ne peut jamais matcher un mot coupé en deux.
    const dehyphenated = resolved.replace(/([a-zà-ÿ])-\n(?=[a-zà-ÿ])/gi, "$1");
    const resolvedLines = dehyphenated
      .split("\n")
      .filter((line) => !SELF_REMOVING_NOTE.test(line))
      .map((line) => line.replace(/ {2,}/g, " ").trim());
    pages.push(resolvedLines);
  }
  return pages;
}

function wrapLine(value: string, maximum: number) {
  const words = value.split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (`${current} ${word}`.trim().length > maximum && current) { lines.push(current); current = word; }
    else current = `${current} ${word}`.trim();
  }
  if (current) lines.push(current);
  return lines;
}

/** Dessine les pages reconstruites dans un nouveau PDF, indépendant du fichier source. */
export async function renderRebuiltPages(pages: string[][]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const { font, boldFont } = await embedUnicodeFonts(doc);
  const pageWidth = 595;
  const pageHeight = 842;
  const marginX = 50;
  const maxCharsPerLine = 95;
  for (const pageLines of pages) {
    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - 50;
    for (const rawLine of pageLines) {
      const line = sanitizeForPdf(rawLine);
      // Une case de formulaire (comme dans les fiches de renseignements) est
      // encadrée dans le DAO ; on redessine ce cadre autour de la ligne pour
      // retrouver l'allure "formulaire en cases", sans viser les dimensions
      // exactes de l'original. Un "Libellé :" court ressemble aussi à un
      // titre : on vérifie donc d'abord si c'est un champ, avant un titre.
      const isField = looksLikeFormField(line);
      const heading = !isField && looksLikeHeading(line);
      const wrapped = wrapLine(line, maxCharsPerLine);
      if (isField) {
        const boxHeight = wrapped.length * 15 + 6;
        if (y - boxHeight < 45) { page = doc.addPage([pageWidth, pageHeight]); y = pageHeight - 50; }
        page.drawRectangle({ x: marginX - 6, y: y - boxHeight + 11, width: pageWidth - marginX * 2 + 12, height: boxHeight, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.75 });
      }
      for (const part of wrapped) {
        if (y < 50) { page = doc.addPage([pageWidth, pageHeight]); y = pageHeight - 50; }
        if (part.trim()) {
          page.drawText(part, { x: marginX, y, size: 10, font: heading ? boldFont : font, color: rgb(0, 0, 0) });
        }
        y -= 15;
      }
      if (isField) y -= 4;
      if (!wrapped.length || (wrapped.length === 1 && !wrapped[0].trim())) y -= 4;
    }
  }
  return Buffer.from(await doc.save());
}
