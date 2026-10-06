import { computeExternalUnitPrices } from "@/lib/estimates/external-pricing";

// Un devis importé vit dans le bordereau du chantier (project_price_items) :
// - unit_price           = prix INTERNE (ton coût), vide tant qu'il n'est pas rempli ;
// - external_unit_price  = prix EXTERNE (celui du client, utilisé pour la facture).
// Marge = total externe ÷ total interne − 1, sur les lignes qui ont les deux prix.

export type DevisItem = { quantity?: number | string | null; unit_price?: number | string | null; external_unit_price?: number | string | null; is_internal?: boolean | null };

const num = (value: unknown) => Number(value) || 0;

export type DevisSummary = {
  lines: number;
  internalTotal: number;
  externalTotal: number;
  missingInternal: number;
  missingExternal: number;
  /** Marge en % (externe ÷ interne − 1) sur les lignes qui ont les deux prix ; null si aucune. */
  marginPercent: number | null;
};

export function summarizeDevis(items: DevisItem[]): DevisSummary {
  const visible = items.filter((item) => !item.is_internal);
  let internalTotal = 0;
  let externalTotal = 0;
  let pairedInternal = 0;
  let pairedExternal = 0;
  let missingInternal = 0;
  let missingExternal = 0;
  for (const item of visible) {
    const quantity = num(item.quantity) || 1;
    const internal = num(item.unit_price);
    const external = num(item.external_unit_price);
    if (internal > 0) internalTotal += quantity * internal; else missingInternal += 1;
    if (external > 0) externalTotal += quantity * external; else missingExternal += 1;
    if (internal > 0 && external > 0) {
      pairedInternal += quantity * internal;
      pairedExternal += quantity * external;
    }
  }
  return {
    lines: visible.length,
    internalTotal,
    externalTotal,
    missingInternal,
    missingExternal,
    marginPercent: pairedInternal > 0 ? Math.round((pairedExternal / pairedInternal - 1) * 1000) / 10 : null,
  };
}

/** Prix externes d'après les prix internes et une marge (même calcul que les devis du DAO). */
export function externalPricesFromInternal(items: Array<{ quantity?: number | string | null; unit_price?: number | string | null }>, marginPercent: number): number[] {
  return computeExternalUnitPrices(
    items.map((item) => ({ quantity: num(item.quantity) || 1, baseUnitPrice: num(item.unit_price) })),
    marginPercent,
    null,
  );
}
