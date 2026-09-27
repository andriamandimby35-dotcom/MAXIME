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

// RÈGLE GÉNÉRALE PARTAGÉE (demandée après avoir dû répéter ce même correctif
// à plusieurs endroits — page.tsx, generate/route.ts,
// printable-submission-document/route.ts, split-merged-dao-items.ts — sans
// jamais tous les mettre à jour d'un coup) : "quelles sont les VRAIES pages
// connues de cette pièce" combine TOUJOURS template_page_numbers (ce que
// l'IA a noté formellement) et les pages seulement citées en texte dans
// source_reference (ex. "Pages 16, 267-268") — une page manquante d'un
// côté peut très bien exister de l'autre. Toute nouvelle vérification "cette
// pièce s'étale-t-elle sur plusieurs pages ?" doit passer par CETTE seule
// fonction plutôt que réécrire l'union à la main : un futur correctif de
// cette règle (ex. un nouveau format de référence à reconnaître) se
// répercute alors automatiquement PARTOUT où elle est utilisée, sans avoir
// besoin de le refaire un par un à chaque endroit.
export function knownPagesForItem(item: { template_page_numbers?: number[]; source_reference?: string | null }): number[] {
  return [...new Set([...(item.template_page_numbers ?? []), ...parsePageNumbersFromReference(item.source_reference)])].sort((a, b) => a - b);
}
