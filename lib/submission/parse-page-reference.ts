// Certaines pièces (ex. « CCAP paraphé ») affichent déjà une référence de
// page réelle ("Pages 31-46, Partie III") sans que l'IA ait pour autant créé
// d'entrée dédiée dans submission_items avec template_page_numbers. Plutôt
// que de rester bloqué sur un texte générique dans ce cas, on extrait
// directement les numéros de page de CE texte — c'est ce que le DAO indique
// déjà, il suffit de le lire.
export function parsePageNumbersFromReference(reference: string | undefined | null): number[] {
  if (!reference) return [];
  const pages = new Set<number>();
  // "p.31-46", "pages 31-46", "page 31 à 46", "p.231-232"
  const rangePattern = /\bp(?:ages?)?\.?\s*(\d{1,4})\s*(?:-|à|to|–)\s*(\d{1,4})/gi;
  let match: RegExpExecArray | null;
  while ((match = rangePattern.exec(reference))) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start < 60) {
      for (let page = start; page <= end; page += 1) pages.add(page);
    }
  }
  // Supprime les plages déjà consommées pour ne pas redétecter leurs bornes
  // comme des pages isolées, puis capture les mentions restantes "p.19",
  // "page 7", "p.19, p.20".
  const withoutRanges = reference.replace(rangePattern, " ");
  const singlePattern = /\bp(?:ages?)?\.?\s*(\d{1,4})\b/gi;
  while ((match = singlePattern.exec(withoutRanges))) {
    const page = Number(match[1]);
    if (Number.isFinite(page) && page > 0) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}
