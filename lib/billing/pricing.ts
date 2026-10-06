// Calcul du prix client (« Certifié ») d'un chantier, d'après la marge ou la
// somme attendue. Fonctions simples, sans accès à la base : elles servent à la
// fois à la liste « Factures & paiements », à la fiche du chantier et à la
// génération de la facture, pour que partout les chiffres soient identiques.
//
// Règles (validées avec l'administrateur) :
// - Tout montant est arrondi à 100 Ar (jamais au millier).
// - Prix FIXE (devis avec prix, ou « prix de l'offre » donné) : le client paie
//   toujours ce prix. Si les dépenses réelles changent, c'est la MARGE qui
//   change (prix − dépenses réelles). Pendant les travaux, on facture la part
//   du prix égale à l'avancement du planning.
// - Prix FLOTTANT (seule la marge est donnée, en % ou en montant) : le prix
//   client suit les dépenses réelles = dépenses réelles + marge.
// - Prix et marge ne se donnent JAMAIS ensemble (sinon l'application ne saurait
//   pas lequel est fixe) : si les deux sont présents, le prix fixe l'emporte
//   et la marge est ignorée.
// - Le même coefficient s'applique à toutes les catégories et sous-catégories
//   pour répartir ce prix dans la facture.

export const ROUND_STEP = 100;

export function roundAr(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / ROUND_STEP) * ROUND_STEP;
}

export type PricingSettings = {
  /** Prix général de l'offre (somme que le client doit payer), si connu. */
  contractAmount?: number | null;
  /** Marge attendue en % des dépenses (ex. 20 = dépenses × 1,20). */
  marginPercent?: number | null;
  /** Bénéfice attendu en Ariary (autre façon de donner la marge). */
  marginAmount?: number | null;
};

export type PricingInput = {
  settings: PricingSettings;
  /** Total des dépenses réellement payées sur le chantier. */
  realCost: number;
  /** Total du devis (somme quantité × prix) quand le devis a des prix. */
  devisTotal?: number | null;
  /** Avancement du planning entre 0 et 1 (null si le chantier n'a pas de tâches). */
  progress?: number | null;
};

export type Pricing = {
  mode: "fixed" | "floating" | "none";
  /** Montant certifié = ce que le client doit payer (arrondi à 100 Ar). */
  certified: number;
  realCost: number;
  /** Gardé pour compatibilité : toujours null depuis que prix et marge sont exclusifs. */
  expectedCost: number | null;
  /** Part du prix facturable maintenant (prix × avancement), arrondie à 100 Ar. */
  billable: number;
  /** Multiplicateur appliqué aux dépenses pour obtenir le prix client. */
  coefficient: number | null;
  /** Marge réelle en Ariary : certifié − dépenses réelles. */
  margin: number;
  /** Marge réelle en % des dépenses (null tant qu'aucune dépense). */
  marginPercent: number | null;
  /** Vrai quand le total doit tomber pile sur le prix (chantier « terminé »). */
  forceTotal: boolean;
};

function positive(value: number | null | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function finite(value: number | null | undefined): number | null {
  if (value === null || value === undefined || (value as unknown) === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function computePricing(input: PricingInput): Pricing {
  const realCost = Math.max(0, Number(input.realCost) || 0);
  const devisTotal = positive(input.devisTotal);
  const fixedPrice = devisTotal ?? positive(input.settings.contractAmount);
  const marginPercent = finite(input.settings.marginPercent);
  const marginAmount = finite(input.settings.marginAmount);

  const finish = (partial: Pick<Pricing, "mode" | "certified" | "billable" | "expectedCost" | "coefficient" | "forceTotal">): Pricing => {
    const margin = partial.certified - realCost;
    return {
      ...partial,
      realCost,
      margin,
      marginPercent: realCost > 0 ? (margin / realCost) * 100 : null,
    };
  };

  if (fixedPrice !== null) {
    const certified = roundAr(fixedPrice);
    const rawProgress = input.progress === null || input.progress === undefined ? null : Math.max(0, Math.min(1, Number(input.progress) || 0));
    // Tant que le planning n'est pas terminé, on ne facture que la part du
    // prix correspondant à l'avancement ; à 100 % (ou sans planning), tout le
    // prix est réparti sur les dépenses et le total tombe pile dessus.
    const inProgress = rawProgress !== null && rawProgress < 1;
    const billable = inProgress ? roundAr(certified * (rawProgress as number)) : certified;
    const coefficient = realCost > 0 ? billable / realCost : null;
    return finish({ mode: "fixed", certified, billable, expectedCost: null, coefficient, forceTotal: !inProgress });
  }

  if (marginPercent !== null && marginPercent > -100) {
    const coefficient = 1 + marginPercent / 100;
    const certified = roundAr(realCost * coefficient);
    return finish({ mode: "floating", certified, billable: certified, expectedCost: null, coefficient, forceTotal: false });
  }
  if (marginAmount !== null) {
    const certified = roundAr(realCost + marginAmount);
    return finish({ mode: "floating", certified, billable: certified, expectedCost: null, coefficient: realCost > 0 ? certified / realCost : null, forceTotal: false });
  }

  return finish({ mode: "none", certified: 0, billable: 0, expectedCost: null, coefficient: null, forceTotal: false });
}

/**
 * Répartit un coefficient sur des lignes de dépenses (catégories ou
 * sous-catégories) : chaque montant client = dépense × coefficient, arrondi à
 * 100 Ar. Si `forceTotal` est donné, la petite différence d'arrondi est mise
 * sur la dernière ligne non nulle pour que la somme tombe exactement dessus.
 */
export function distributeByCoefficient(costs: number[], coefficient: number, forceTotal?: number | null): number[] {
  const amounts = costs.map((cost) => roundAr((Number(cost) || 0) * coefficient));
  if (forceTotal === null || forceTotal === undefined) return amounts;
  const target = roundAr(forceTotal);
  const diff = target - amounts.reduce((sum, value) => sum + value, 0);
  if (diff === 0) return amounts;
  for (let index = amounts.length - 1; index >= 0; index -= 1) {
    if (amounts[index] > 0 || (Number(costs[index]) || 0) > 0) {
      amounts[index] = Math.max(0, amounts[index] + diff);
      return amounts;
    }
  }
  return amounts;
}

/** Reçu supérieur au certifié = erreur à signaler (montant du dépassement). */
export function overpaidAmount(certified: number, received: number): number {
  const over = (Number(received) || 0) - (Number(certified) || 0);
  return over > 0.5 ? over : 0;
}
