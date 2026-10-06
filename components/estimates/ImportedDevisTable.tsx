// Le tableau séparé « Devis ajoutés par PDF » n'existe plus : ces devis sont
// maintenant dans la même liste que les devis du DAO (EstimateList), avec les
// mêmes colonnes et les mêmes boutons. Ce fichier ne garde que le type.
export type ImportedDevis = {
  id: string;
  name: string;
  createdAt: string | null;
  lines: number;
  internalTotal: number;
  externalTotal: number;
  missingInternal: number;
  missingExternal: number;
  marginPercent: number | null;
  /** Bénéfice attendu (externe − interne) sur les lignes qui ont les deux prix ; null si aucune. */
  profit: number | null;
};
