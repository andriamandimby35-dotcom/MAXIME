// Nettoyage déterministe (AUCUN appel IA ici) du tableau submission_items
// renvoyé par l'analyse du DAO, pour rattraper des erreurs déjà observées sur
// de vraies analyses (DAO "2ddd2a15..."), et qui restent possibles sur
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
// 2) Deux pièces qui sont en réalité LA MÊME pièce dupliquée par erreur. Ça
//    peut se voir de deux façons différentes, observées toutes les deux sur
//    de vraies analyses :
//      a) même titre, exactement (ex. deux fois "Annexe 2 : Modèle de
//         planning d'exécution des travaux", avec des pages et des
//         descriptions différentes) ;
//      b) titre différent (parfois un fragment incohérent, ex. "NY ORINASA (
//         L'ENTREPRISE") mais instructions EXACTEMENT identiques à une autre
//         pièce déjà présente (ex. la même phrase "Un contrat individuel de
//         travail doit être préparé et signé pour chaque..." recopiée sur
//         "Annexe 3 : Modèle de petit contrat..." ET sur ce fragment) — un
//         DAO ne donne jamais mot pour mot les mêmes instructions à deux
//         pièces différentes, donc des instructions identiques veulent dire
//         que c'est la même pièce, même si le titre, lui, a été mal recopié.
//    Dans les deux cas, un DAO ne numérote/ne décrit jamais deux fois la
//    même pièce, donc l'une des deux (ou les deux) est forcément une
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

// Même normalisation que pour le titre, appliquée aux instructions : sert à
// repérer deux pièces qui ont reçu mot pour mot le même texte d'instructions
// (voir point 2b ci-dessus). On exige une longueur minimale (30 caractères
// une fois normalisé) pour ne jamais déclencher sur une instruction courte et
// générique qui pourrait légitimement se répéter (ex. "Signer et dater.").
const MIN_INSTRUCTIONS_LENGTH_FOR_DUPLICATE_CHECK = 30;
function normalizeInstructions(value: string) {
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
): {
  items: T[];
  removedAsBordereauHeading: string[];
  flaggedDuplicateTitles: string[];
  flaggedDuplicateInstructions: string[];
} {
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

  // Doublon de titre OU d'instructions : on ne supprime jamais silencieusement,
  // on avertit (voir points 2a et 2b ci-dessus).
  const titleCounts = new Map<string, number>();
  const instructionsCounts = new Map<string, number>();
  for (const item of afterBordereauFilter) {
    const normalizedTitle = normalizeTitle(item.title || "");
    if (normalizedTitle) {
      titleCounts.set(normalizedTitle, (titleCounts.get(normalizedTitle) || 0) + 1);
    }
    const normalizedInstructions = normalizeInstructions(item.instructions || "");
    if (normalizedInstructions.length >= MIN_INSTRUCTIONS_LENGTH_FOR_DUPLICATE_CHECK) {
      instructionsCounts.set(normalizedInstructions, (instructionsCounts.get(normalizedInstructions) || 0) + 1);
    }
  }
  const flaggedDuplicateTitles: string[] = [];
  const flaggedDuplicateInstructions: string[] = [];
  const items = afterBordereauFilter.map((item) => {
    const normalizedTitle = normalizeTitle(item.title || "");
    const isDuplicateTitle = normalizedTitle.length > 0 && (titleCounts.get(normalizedTitle) || 0) > 1;
    const normalizedInstructions = normalizeInstructions(item.instructions || "");
    const isDuplicateInstructions =
      normalizedInstructions.length >= MIN_INSTRUCTIONS_LENGTH_FOR_DUPLICATE_CHECK &&
      (instructionsCounts.get(normalizedInstructions) || 0) > 1;
    if (!isDuplicateTitle && !isDuplicateInstructions) return item;

    if (isDuplicateTitle) flaggedDuplicateTitles.push(item.title);
    if (isDuplicateInstructions) flaggedDuplicateInstructions.push(item.title);

    const warning = isDuplicateTitle && isDuplicateInstructions
      ? "⚠ Titre ET instructions identiques à une autre pièce détectée dans ce DAO — vérifiez laquelle des deux correspond vraiment avant de vous en servir."
      : isDuplicateTitle
        ? "⚠ Titre identique à une autre pièce détectée dans ce DAO — vérifiez laquelle des deux correspond vraiment avant de vous en servir."
        : "⚠ Instructions identiques, mot pour mot, à une autre pièce de ce DAO (même si le titre diffère) — c'est probablement la même pièce détectée deux fois ; vérifiez laquelle des deux est la bonne avant de vous en servir.";
    const instructions = item.instructions && item.instructions.trim()
      ? `${item.instructions.trim()}\n\n${warning}`
      : warning;
    return { ...item, instructions };
  });

  return { items, removedAsBordereauHeading, flaggedDuplicateTitles, flaggedDuplicateInstructions };
}
