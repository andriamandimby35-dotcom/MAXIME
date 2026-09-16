// La liste générique de pièces (« Plan à parapher », « CCAP paraphé »...) est
// codée en dur avec des intitulés génériques, alors que l'IA extrait les
// vraies pièces du DAO avec SES propres intitulés (souvent différents en
// détail : "Garantie bancaire de soumission B1" vs "Garantie bancaire de
// soumission"). Une égalité stricte des titres ne les fait presque jamais
// correspondre, ce qui empêchait d'utiliser les vraies pages/le vrai modèle
// trouvés par l'IA. Ce rapprochement compare les mots significatifs des deux
// titres plutôt que le texte exact.
const STOPWORDS = new Set([
  "de", "du", "des", "le", "la", "les", "un", "une", "et", "ou", "a", "au",
  "aux", "en", "pour", "sur", "dans", "par", "avec", "est", "ce", "cette",
  "ces", "son", "sa", "ses", "leur", "leurs", "ou",
  // Verbes/qualificatifs d'action qui décrivent CE QU'IL FAUT FAIRE d'une
  // pièce (parapher, signer, certifier conforme...), pas SA nature — les
  // garder faisait rater des rapprochements pourtant évidents (ex. "CCAP
  // paraphé" vs le titre réel de l'IA "CCAP / Cahier des Clauses
  // Administratives Particulières" : seul "ccap" était partagé, sous le
  // seuil), laissant un doublon générique vide affiché à côté de la vraie
  // pièce trouvée.
  "parapher", "paraphe", "paraphee", "paraphees", "paraphes", "signer",
  "signe", "signee", "signees", "signes", "certifiee", "certifiees",
  "certifie", "certifies", "conforme", "conformes", "photocopie",
  "photocopies",
]);

export function significantWords(title: string) {
  return new Set(
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLocaleLowerCase("fr-FR")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word)),
  );
}

/** Ratio de mots partagés, généreux envers le titre le plus court (0 à 1). */
export function titleSimilarity(a: string, b: string) {
  const wordsA = significantWords(a);
  const wordsB = significantWords(b);
  if (!wordsA.size || !wordsB.size) return 0;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared += 1;
  return shared / Math.min(wordsA.size, wordsB.size);
}

/**
 * Trouve, parmi une liste de pièces réellement extraites du DAO par l'IA,
 * celle qui correspond le mieux à un titre donné (générique ou non).
 * Essaie d'abord l'égalité exacte, puis la similarité par mots-clés.
 */
export function findBestTitleMatch<T extends { title?: string }>(
  title: string,
  candidates: T[],
  threshold = 0.6,
): T | null {
  const exact = candidates.find((candidate) => candidate.title?.toLocaleLowerCase("fr-FR") === title.toLocaleLowerCase("fr-FR"));
  if (exact) return exact;
  let best: T | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (!candidate.title) continue;
    const score = titleSimilarity(title, candidate.title);
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return bestScore >= threshold ? best : null;
}

/** Combien de pièces IA partagent au moins un mot significatif avec ce titre générique. */
export function countPartialMatches<T extends { title?: string }>(title: string, candidates: T[]) {
  return candidates.filter((candidate) => candidate.title && titleSimilarity(title, candidate.title) > 0).length;
}
