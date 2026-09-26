import type { DocumentBlock, TableBlock, TextRun } from "@/lib/submission/generated-document-pdf";

// Transforme le texte d'un modèle (recopié par l'IA avec des {{cles}} à la
// place de chaque blanc/pointillé/tiret du DAO d'origine, voir analyze-dao)
// en blocs de paragraphes prêts pour renderGeneratedDocumentPdf. Chaque
// {{cle}} connue devient un morceau en GRAS (la vraie valeur, bien visible) ;
// une clé sans valeur connue disparaît simplement, sans laisser aucun
// pointillé ni texte de remplacement — même règle que replaceTemplateFields
// dans printable-submission-document/route.ts ("si la case est vide, on
// laisse aussi le pdf vide").
function tokenizeTemplateParagraph(paragraph: string, templateValues: Record<string, string>): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /\{\{([a-z0-9_]+)\}\}/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(paragraph))) {
    const [full, key] = match;
    if (match.index > lastIndex) pushPlain(runs, paragraph.slice(lastIndex, match.index));
    const value = templateValues[key.toLowerCase()]?.trim();
    if (value) runs.push({ text: value, bold: true });
    lastIndex = match.index + full.length;
  }
  if (lastIndex < paragraph.length) pushPlain(runs, paragraph.slice(lastIndex));
  return runs;
}

function pushPlain(runs: TextRun[], text: string) {
  // Filet de sécurité (constaté sur un vrai DAO : "{{delai_execution_jours}}"
  // affiché tel quel dans le PDF) : une clé que l'IA a écrite dans
  // template_text mais qui ne correspond à AUCUNE valeur connue de
  // l'application (orthographe différente de celle utilisée dans fields,
  // espace ou accent glissé dans la clé...) ne doit jamais s'afficher sous sa
  // forme brute "{{...}}" — un tel repère raté est traité exactement comme un
  // blanc sans valeur : supprimé, jamais montré au candidat. Même filet que
  // replaceTemplateFields dans printable-submission-document/route.ts.
  const cleaned = text
    .replace(/\{\{[^{}]{1,80}\}\}/g, "")
    .replace(/(?:\.[ \t]?){4,}\.?/g, " ")
    .replace(/\.{4,}/g, " ")
    .replace(/…{2,}/g, " ")
    .replace(/-{4,}/g, " ")
    .replace(/_{3,}/g, " ")
    .replace(/[ \t]{2,}/g, " ");
  if (cleaned.trim() || cleaned.includes(" ")) runs.push({ text: cleaned });
}

// Un paragraphe du DAO est normalement séparé du suivant par une ligne vide
// dans template_text (l'IA reproduit la numérotation d'origine "1.", "2.",
// "3." À L'INTÉRIEUR de chaque paragraphe). Mais l'IA n'ajoute pas toujours
// cette ligne vide (constaté : toute la lettre fondue en un seul bloc, sans
// aucune séparation entre "1." et "2.") : on détecte donc AUSSI, en secours,
// le début d'un nouveau paragraphe numéroté ("2. Dans le cas...") même
// collé au texte précédent, pour ne jamais fondre deux paragraphes en un
// seul pavé de texte illisible.
function splitIntoParagraphs(templateText: string): string[] {
  const normalized = templateText.replace(/\r\n/g, "\n");
  return normalized
    .split(/\n[ \t]*\n/)
    .flatMap((chunk) => chunk.split(/(?=(?:^|\n)[ \t]*\d{1,2}\.\s)/))
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function buildParagraphBlocksFromTemplateText(templateText: string, templateValues: Record<string, string>): DocumentBlock[] {
  const paragraphs = splitIntoParagraphs(templateText);
  const blocks: DocumentBlock[] = [];
  paragraphs.forEach((paragraph, index) => {
    const runs = tokenizeTemplateParagraph(paragraph.replace(/\s*\n\s*/g, " "), templateValues);
    if (runs.some((run) => run.text.trim().length > 0)) {
      blocks.push({ kind: "paragraph", runs });
      if (index < paragraphs.length - 1) blocks.push({ kind: "spacer", height: 6 });
    }
  });
  return blocks;
}

export function buildTableBlockFromTemplateTable(table: { title?: string; columns: string[]; rows: string[][] }): TableBlock {
  return { kind: "table", title: table.title, columns: table.columns, rows: table.rows };
}

/**
 * Construit la liste complète des blocs d'un document généré : titre, texte
 * du modèle (ou des lignes déjà résolues en repli, quand aucun template_text
 * n'existe pour ce DAO), puis ses tableaux, puis d'éventuelles informations
 * du formulaire que le texte du modèle n'aurait pas déjà couvertes (garde-fou
 * si l'IA a oublié d'inclure une clé dans template_text).
 */
export function buildGeneratedDocumentBlocks(params: {
  title: string;
  templateText?: string;
  templateValues: Record<string, string>;
  fallbackParagraphs?: string[];
  tables?: Array<{ title?: string; columns: string[]; rows: string[][] }>;
  leftoverFieldLines?: string[];
}): DocumentBlock[] {
  const blocks: DocumentBlock[] = [
    { kind: "heading", text: params.title.toLocaleUpperCase("fr-FR") },
    { kind: "spacer", height: 10 },
  ];
  if (params.templateText?.trim()) {
    blocks.push(...buildParagraphBlocksFromTemplateText(params.templateText, params.templateValues));
  } else if (params.fallbackParagraphs?.length) {
    params.fallbackParagraphs.forEach((line) => {
      if (line.trim()) blocks.push({ kind: "paragraph", runs: [{ text: line }] });
      else blocks.push({ kind: "spacer", height: 8 });
    });
  }
  if (params.tables?.length) {
    blocks.push({ kind: "spacer", height: 16 });
    params.tables.forEach((table, index) => {
      blocks.push(buildTableBlockFromTemplateTable(table));
      if (index < params.tables!.length - 1) blocks.push({ kind: "spacer", height: 16 });
    });
  }
  if (params.leftoverFieldLines?.length) {
    blocks.push({ kind: "spacer", height: 16 });
    blocks.push({ kind: "paragraph", runs: [{ text: "Informations complémentaires :", bold: true }] });
    params.leftoverFieldLines.forEach((line) => blocks.push({ kind: "paragraph", runs: [{ text: line }] }));
  }
  return blocks;
}
