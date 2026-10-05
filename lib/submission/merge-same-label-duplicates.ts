// Dernier filet de sécurité, 100 % texte (AUCUNE lecture du DAO, donc aucun
// coût de temps) : fusionne les pièces qui sont en réalité LA MÊME pièce du
// DAO malgré des titres formulés un peu différemment par l'IA — ex. "Annexe 2
// : Modèle de planning d'exécution des travaux" et "Annexe 2 - Planning
// d'exécution des travaux" (observé en vrai), ou "A1 - FICHE DE
// RENSEIGNEMENTS RELATIFS AU CANDIDAT" et "A1- IDENTIFICATION DU CANDIDAT"
// (toutes deux page 13). Demande explicite de Maxime : ces pièces ne doivent
// apparaître qu'UNE fois.
//
// Règle générale (aucun titre ni numéro codé en dur) : deux pièces d'origine
// "dao" sont la même pièce si elles portent la MÊME étiquette de pièce
// ("Annexe 2", "A1", "A2 – b)"... lue au tout début du titre, même
// orthographe de ponctuation/espaces) ET si, au choix :
//   - les mots-clés du plus court des deux titres (sans l'étiquette ni les
//     mots vides comme "de", "du", "modèle") se retrouvent TOUS dans l'autre
//     titre (le plus court n'est qu'une version abrégée du plus long) ; ou
//   - elles partagent au moins une page connue du DAO (un DAO ne place jamais
//     deux pièces portant la même étiquette sur la même page).
// Deux pièces d'étiquettes différentes, ou d'étiquette commune mais de pages
// ET de mots-clés sans rapport ("Annexe 1 : garantie" / "Annexe 1 : BDQE"),
// ne sont JAMAIS touchées.
//
// Reprend aussi la règle déjà appliquée à l'affichage (même titre normalisé ET
// même type de pièce = même pièce, voir deduplicate() dans
// SubmissionDossierManager.tsx) pour que l'avertissement "doublon" ne reste
// pas collé à la copie survivante une fois ses jumelles retirées.
//
// On garde la copie la plus RICHE (plus de champs à compléter, puis des
// instructions plus longues) : une copie générique "Joindre le document" ne
// doit jamais l'emporter sur le vrai formulaire à compléter.
import { knownPagesForItem } from "@/lib/submission/parse-page-reference";
import { pagesWithTitleNearby } from "@/lib/submission/trim-to-relevant-pages";
import {
  hasDuplicateWarning,
  normalizeInstructions,
  normalizeTitle,
  stripDuplicateWarning,
} from "@/lib/submission/sanitize-ai-analysis";

type MergeableItem = {
  title: string;
  kind?: string;
  instructions?: string;
  template_origin?: string;
  template_page_numbers?: number[];
  source_reference?: string | null;
  fields?: unknown[];
};

const STOP_WORDS = new Set([
  "de", "du", "des", "la", "le", "les", "l", "d", "et", "au", "aux", "un", "une",
  "en", "pour", "sur", "a", "modele", "modeles", "type",
]);

function words(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Étiquette de pièce au tout début du titre : "annexe 2" -> "annexe2",
// "A1" -> "a1", "A2 – b)" -> "a2b". Renvoie aussi le reste du titre. Une
// pièce sans étiquette claire n'est jamais concernée (label = null).
export function splitLabel(title: string): { label: string; rest: string[] } | null {
  const tokens = words(title);
  if (!tokens.length) return null;
  let label: string | null = null;
  let used = 0;
  if (tokens[0] === "annexe" && /^[0-9]+$/.test(tokens[1] ?? "")) {
    label = `annexe${tokens[1]}`;
    used = 2;
  } else if (/^[a-z]$/.test(tokens[0]) && /^[0-9]+$/.test(tokens[1] ?? "")) {
    label = `${tokens[0]}${tokens[1]}`;
    used = 2;
  }
  if (!label) return null;
  // Sous-lettre éventuelle ("A2 – b)") : fait partie de l'étiquette, sinon
  // "A2 – a)" et "A2 – b)" seraient prises pour la même pièce.
  if (/^[a-z]$/.test(tokens[used] ?? "") && /^\s*[-–—:.]?\s*[a-z]\s*\)/i.test(title.replace(/^.*?[0-9]+/, "").trim())) {
    label += tokens[used];
    used += 1;
  }
  return { label, rest: tokens.slice(used).filter((token) => !STOP_WORDS.has(token)).map((token) => token.replace(/s$/, "")) };
}

function richness(item: MergeableItem): number {
  return (item.fields?.length ?? 0) * 100000 + (stripDuplicateWarning(item.instructions)?.length ?? 0);
}

// Deux pièces aux instructions IDENTIQUES mot pour mot (30 caractères minimum,
// hors avertissement de doublon) dont les pages se touchent ou se chevauchent
// (l'une finit page N, l'autre commence page N ou N+1) sont les deux moitiés
// d'UN SEUL document de plusieurs pages (observé en vrai : "Contrat individuel
// de travail" pages 258-260 et un fragment "NY ORINASA ( L'ENTREPRISE" page
// 261, même texte d'instructions). Les pages sont alors réunies.
function sameInstructionsAdjacentPages(a: MergeableItem, b: MergeableItem): boolean {
  const instrA = normalizeInstructions(stripDuplicateWarning(a.instructions) ?? "");
  const instrB = normalizeInstructions(stripDuplicateWarning(b.instructions) ?? "");
  if (instrA.length < 30 || instrA !== instrB) return false;
  const pagesA = knownPagesForItem(a);
  const pagesB = knownPagesForItem(b);
  if (!pagesA.length || !pagesB.length) return false;
  return pagesA.some((pageA) => pagesB.some((pageB) => Math.abs(pageA - pageB) <= 1));
}

function samePiece(a: MergeableItem, b: MergeableItem): boolean {
  if (normalizeTitle(a.title || "") === normalizeTitle(b.title || "") && a.kind === b.kind) return true;
  if (sameInstructionsAdjacentPages(a, b)) return true;
  const labelA = splitLabel(a.title || "");
  const labelB = splitLabel(b.title || "");
  if (!labelA || !labelB || labelA.label !== labelB.label) return false;
  const [shorter, longer] = labelA.rest.length <= labelB.rest.length ? [labelA.rest, labelB.rest] : [labelB.rest, labelA.rest];
  if (shorter.length >= 2 && shorter.every((word) => longer.includes(word))) return true;
  const pagesA = knownPagesForItem(a);
  const pagesB = knownPagesForItem(b);
  return pagesA.some((page) => pagesB.includes(page));
}

export function mergeSamePieceDuplicates<T extends MergeableItem>(items: T[]): T[] {
  const dropped = new Set<number>();
  const merged = new Set<number>();
  const unionPages = new Map<number, number[]>();
  const candidates = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.template_origin === "dao" && (item.title || "").trim().length > 0);
  for (let a = 0; a < candidates.length; a++) {
    for (let b = a + 1; b < candidates.length; b++) {
      const i = candidates[a].index;
      const j = candidates[b].index;
      if (dropped.has(i) || dropped.has(j)) continue;
      if (!samePiece(items[i], items[j])) continue;
      const [keep, drop] = richness(items[i]) >= richness(items[j]) ? [i, j] : [j, i];
      dropped.add(drop);
      merged.add(keep);
      if (sameInstructionsAdjacentPages(items[i], items[j])) {
        const union = [...new Set([...(unionPages.get(keep) ?? knownPagesForItem(items[keep])), ...knownPagesForItem(items[drop])])].sort((x, y) => x - y);
        unionPages.set(keep, union);
      }
    }
  }
  if (!dropped.size) return items;

  const survivors = items.filter((_, index) => !dropped.has(index));
  const titleCount = new Map<string, number>();
  const instructionCount = new Map<string, number>();
  for (const item of survivors) {
    const title = normalizeTitle(item.title || "");
    if (title) titleCount.set(title, (titleCount.get(title) ?? 0) + 1);
    const instr = normalizeInstructions(stripDuplicateWarning(item.instructions) ?? "");
    if (instr.length >= 30) instructionCount.set(instr, (instructionCount.get(instr) ?? 0) + 1);
  }
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => !dropped.has(index))
    .map(({ item, index }) => {
      const pages = unionPages.get(index);
      if (pages) item = { ...item, template_page_numbers: pages, source_reference: `Pages ${pages.join(", ")}` };
      // L'avertissement "doublon" n'a plus de raison d'être sur une pièce
      // gardée après fusion, tant qu'aucune autre pièce restante ne porte
      // encore le même titre ou les mêmes instructions.
      if (!merged.has(index) || !hasDuplicateWarning(item.instructions)) return item;
      const title = normalizeTitle(item.title || "");
      const instr = normalizeInstructions(stripDuplicateWarning(item.instructions) ?? "");
      const stillDuplicated = (title && (titleCount.get(title) ?? 0) > 1) || (instr.length >= 30 && (instructionCount.get(instr) ?? 0) > 1);
      return stillDuplicated ? item : { ...item, instructions: stripDuplicateWarning(item.instructions) };
    });
}

// Paires de pièces de MÊME étiquette ("Annexe 1"...) sans aucune page connue en
// commun : candidates à la vérification dans le DAO ci-dessous. Calcul 100 %
// texte, pour ne charger/lire le DAO que s'il existe vraiment une telle paire.
export function findSameLabelPairs<T extends MergeableItem>(items: T[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const dao = items.map((item, index) => ({ item, index })).filter(({ item }) => item.template_origin === "dao");
  for (let a = 0; a < dao.length; a++) {
    for (let b = a + 1; b < dao.length; b++) {
      const labelA = splitLabel(dao[a].item.title || "");
      const labelB = splitLabel(dao[b].item.title || "");
      if (!labelA || !labelB || labelA.label !== labelB.label) continue;
      const pagesA = knownPagesForItem(dao[a].item);
      const pagesB = knownPagesForItem(dao[b].item);
      if (!pagesA.length || !pagesB.length || pagesA.some((page) => pagesB.includes(page))) continue;
      pairs.push([dao[a].index, dao[b].index]);
    }
  }
  return pairs;
}

// BUG corrigé (observé en vrai) : "Annexe 1 : Modèle de garantie bancaire de
// bonne exécution" (page 45 selon l'IA) et "ANNEXE 1 AU CCAP" (page 47) sont
// en réalité UNE seule pièce — le vrai DAO titre la page 47 "ANNEXE 1 AU CCAP
// Modèle de garantie bancaire de bonne exécution" — mais leurs titres ne
// partagent presque aucun mot, et la page 45 annoncée par l'IA est fausse
// (aucun rapport avec une garantie), donc ni la vérification de page ni les
// règles purement textuelles ne les rapprochaient.
//
// Règle générale (aucun titre codé en dur) : pour deux pièces de même
// étiquette sur des pages différentes, si le TITRE COMPLET de l'une n'apparaît
// pas sur ses propres pages annoncées MAIS apparaît sur les pages de l'autre,
// alors elle n'est que l'autre pièce, mal paginée : on n'en garde qu'une (la
// plus riche en contenu) avec les pages de celle qui s'est VÉRIFIÉE dans le
// DAO. Si le titre n'apparaît sur aucune des deux, ou apparaît déjà sur ses
// propres pages, on ne touche à rien. Ne lit que les quelques pages annoncées
// de ces paires (jamais le document entier).
export async function mergeRelabeledPiecesUsingDao<T extends MergeableItem>(items: T[], pdfBytes: Uint8Array): Promise<T[]> {
  const pairs = findSameLabelPairs(items);
  if (!pairs.length) return items;
  const dropped = new Set<number>();
  const pagesOverride = new Map<number, number[]>();
  for (const [i, j] of pairs) {
    if (dropped.has(i) || dropped.has(j)) continue;
    const pagesI = pagesOverride.get(i) ?? knownPagesForItem(items[i]);
    const pagesJ = pagesOverride.get(j) ?? knownPagesForItem(items[j]);
    let suspect: number | null = null;
    let other: number | null = null;
    try {
      for (const [a, b, pagesA, pagesB] of [[i, j, pagesI, pagesJ], [j, i, pagesJ, pagesI]] as Array<[number, number, number[], number[]]>) {
        const title = items[a].title || "";
        const onOwnPages = await pagesWithTitleNearby(pdfBytes, pagesA, title);
        if (onOwnPages.size) continue;
        const onOtherPages = await pagesWithTitleNearby(pdfBytes, pagesB, title);
        if (onOtherPages.size) { suspect = a; other = b; break; }
      }
    } catch {
      continue;
    }
    if (suspect === null || other === null) continue;
    const [keep, drop] = richness(items[suspect]) > richness(items[other]) ? [suspect, other] : [other, suspect];
    dropped.add(drop);
    // La pièce gardée reprend les pages de celle qui s'est vérifiée.
    pagesOverride.set(keep, pagesOverride.get(other) ?? knownPagesForItem(items[other]));
  }
  if (!dropped.size) return items;
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => !dropped.has(index))
    .map(({ item, index }) => {
      const pages = pagesOverride.get(index);
      if (!pages) return item;
      return { ...item, template_page_numbers: pages, source_reference: `Pages ${pages.join(", ")}`, instructions: stripDuplicateWarning(item.instructions) };
    });
}
