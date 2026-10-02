// Nettoyage déterministe (AUCUN appel IA ici) du tableau submission_items
// renvoyé par l'analyse du DAO, pour rattraper deux erreurs déjà observées
// sur une vraie analyse (DAO "2ddd2a15..."), et qui restent possibles sur
// N'IMPORTE QUEL DAO tant que le modèle d'IA peut commettre ce type de
// confusion :
//
// 1) Un titre de rubrique ou de sous-total du bordereau de prix (BDQE) — par
//    exemple "TOTAL - CHARPENTE & COUVERTURE" ou "VII - PEINTURE ET
//    VITRERIE" — se retrouve par erreur dans submission_items comme s'il
//    s'agissait d'une pièce à fournir, alors que ce n'est qu'un titre de
//    ligne du bordereau (déjà présent, correctement, dans work_items). Un tel
//    titre n'est JAMAIS une vraie pièce de soumission (une pièce de
//    soumission est toujours un document à signer/joindre/compléter, jamais
//    une ligne de prix) : repéré ici par motif (TOTAL/SOUS-TOTAL/
//    RÉCAPITULATIF/chiffre romain suivi d'un tiret) OU par correspondance
//    exacte avec un titre de section/sous-total déjà présent dans
//    work_items, et retiré avant l'enregistrement — sans appel IA
//    supplémentaire, donc sans coût ni délai additionnel.
//
// 2) Deux pièces avec EXACTEMENT le même titre (ex. deux fois "Annexe 2 :
//    Modèle de planning d'exécution des travaux", avec des pages et des
//    descriptions différentes) — un DAO ne numérote jamais deux fois la même
//    annexe dans une même partie, donc l'une des deux est forcément une
//    confusion de l'IA. Plutôt que de risquer de supprimer la bonne pièce par
//    une règle automatique qui se tromperait parfois, on les garde TOUTES LES
//    DEUX mais on ajoute un avertissement visible directement sur chacune,
//    pour que Maxime les repère tout de suite dans le dossier et tranche
//    lui-même laquelle est la bonne (voir le principe déjà appliqué ailleurs
//    dans ce projet : ne jamais faire disparaître silencieusement une pièce
//    potentiellement réelle).

export type WorkItemLike = {
  row_type?: string;
  section_title?: string;
  designation?: string;
};

export type SubmissionItemLike = {
  title: string;
  instructions?: string;
};

function normalizeTitle(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toUpperCase();
}

// Chiffre romain suivi d'un tiret/point ("VII - ...", "IV. ...") : numérotation
// typique d'une rubrique de bordereau, jamais celle d'une pièce de soumission
// (qui porte un intitulé comme "Annexe 7", "A2", "B1", jamais un chiffre
// romain seul).
const BORDEREAU_HEADING_PATTERNS = [
  /^TOTAL\b/i,
  /^SOUS[ -]?TOTAL\b/i,
  /^R[ÉE]CAPITULAT/i,
  /^[IVXLCDM]{1,6}\s*[-–—.)]/i,
];

export function sanitizeSubmissionItems<T extends SubmissionItemLike>(
  submissionItems: T[],
  workItems: WorkItemLike[],
): { items: T[]; removedAsBordereauHeading: string[]; flaggedDuplicateTitles: string[] } {
  const bordereauTitles = new Set(
    workItems
      .filter((item) => item.row_type === "section" || item.row_type === "subtotal")
      .map((item) => normalizeTitle(item.section_title || item.designation || ""))
      .filter(Boolean),
  );

  const removedAsBordereauHeading: string[] = [];
  const afterBordereauFilter = submissionItems.filter((item) => {
    const rawTitle = (item.title || "").trim();
    if (!rawTitle) return true;
    const normalized = normalizeTitle(rawTitle);
    const matchesPattern = BORDEREAU_HEADING_PATTERNS.some((pattern) => pattern.test(rawTitle));
    const matchesWorkItemTitle = normalized.length > 0 && bordereauTitles.has(normalized);
    if (matchesPattern || matchesWorkItemTitle) {
      removedAsBordereauHeading.push(rawTitle);
      return false;
    }
    return true;
  });

  // Doublon de titre : on ne supprime jamais silencieusement, on avertit.
  const titleCounts = new Map<string, number>();
  for (const item of afterBordereauFilter) {
    const normalized = normalizeTitle(item.title || "");
    if (!normalized) continue;
    titleCounts.set(normalized, (titleCounts.get(normalized) || 0) + 1);
  }
  const flaggedDuplicateTitles: string[] = [];
  const items = afterBordereauFilter.map((item) => {
    const normalized = normalizeTitle(item.title || "");
    if (normalized && (titleCounts.get(normalized) || 0) > 1) {
      flaggedDuplicateTitles.push(item.title);
      const warning = "⚠ Titre identique à une autre pièce détectée dans ce DAO — vérifiez laquelle des deux correspond vraiment avant de vous en servir.";
      const instructions = item.instructions && item.instructions.trim()
        ? `${item.instructions.trim()}\n\n${warning}`
        : warning;
      return { ...item, instructions };
    }
    return item;
  });

  return { items, removedAsBordereauHeading, flaggedDuplicateTitles };
}
